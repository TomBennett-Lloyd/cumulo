#!/usr/bin/env bash
# Supply-chain policy gate over pnpm-workspace.yaml. Two things must hold:
#
#   1. The quarantine is armed and strict — `minimumReleaseAge` is set to a
#      positive number of minutes and `minimumReleaseAgeStrict` is `true`.
#   2. Every entry in a supply-chain opt-out block carries a justification
#      comment on the line(s) directly above it.
#
# Why both, and why a gate rather than a convention:
#
# pnpm 11.18 ships `minimumReleaseAge` at 1440 minutes by default, but with
# `minimumReleaseAgeStrict` FALSE while the value stays implicit. In that "loose"
# mode an install that resolves a too-fresh version does not fail — it appends
# the offending versions to `minimumReleaseAgeExclude` in pnpm-workspace.yaml and
# carries on, exit 0. Reproduced against 11.18.0 (issue #92): a `pnpm add` of a
# 15-hour-old package wrote two exclusions, one of them for a transitive
# dependency nobody named. Setting the age explicitly auto-enables strict mode
# and turns that into ERR_PNPM_NO_MATURE_MATCHING_VERSION with nothing written,
# which is rule 1 — and rule 1 is a gate because the setting that does the work
# is one line in a file pnpm itself rewrites.
#
# Rule 2 covers what strict mode does not. `pnpm audit --fix` writes
# `minimumReleaseAgeExclude` entries regardless of strict mode, an approved
# interactive prompt writes them by design, and `allowBuilds` is auto-populated
# on the same "pnpm decided, nobody wrote it down" pattern. All of them land as
# an unexplained diff in a shared file, which every agent then has to
# independently notice, interpret, and decide whether to commit. A required
# comment makes the answer readable instead of archaeological: an entry with
# nothing above it is one nobody decided on.
#
# Wired into the root `verify` composite (CLAUDE.md: gates join `verify`, never a
# hand-picked subset), so `pnpm verify`, the CI `checks` job and any human
# running the composite all enforce it.
#
# The parser is deliberately small and deliberately brittle: top-level keys at
# column 0, one level of indented entries beneath them. It refuses (exit 2) any
# shape it does not recognise rather than skipping it, because a parser that
# shrugs at a line it cannot read is a gate that passes the entry it could not
# see. That is also why the two settings in rule 1 are asserted present: they are
# the census. If the key matching ever stopped matching, this gate goes red
# ("missing setting") instead of green ("no violations found").
#
# SCOPE LIMIT, stated because it is not obvious from the OK line: this gate reads
# the MANIFEST, and pnpm does not resolve these settings from the manifest alone.
# A CLI flag, a `pnpm_config_*` environment variable and the global `config.yaml`
# all outrank pnpm-workspace.yaml, so `pnpm_config_minimum_release_age_strict=false`
# in a runner's environment disarms the quarantine with this gate still green.
# What is checked here is that the repo's committed intent is right — not that the
# process which ran pnpm honoured it. Closing that gap means asking pnpm for its
# effective config at gate time, which is a dependency this script deliberately
# does not have; the trade-off is recorded in docs/tech-debt.md rather than
# decided here.
#
# No dependencies: bash (3.2, which macOS ships as /bin/bash) only. No YAML
# library, no pnpm, no network.
#
# Usage: bash .claude/scripts/check-supply-chain-policy.sh [REPO_ROOT]
#        (or `pnpm check:supply-chain-policy`)
#        REPO_ROOT defaults to the repo root above this script; the argument
#        exists so the test harness can point the gate at throwaway fixtures.
# Exit:  0 policy holds, 1 it does not, 2 the invocation or the file itself was
#        something this gate cannot give a verdict on.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2
ROOT=${1:-"$SCRIPT_DIR/../.."}

if [ ! -d "$ROOT" ]; then
  printf 'check-supply-chain-policy: not a directory: %s\n' "$ROOT" >&2
  exit 2
fi
ROOT=$(cd "$ROOT" && pwd -P) || exit 2

MANIFEST_NAME=pnpm-workspace.yaml
MANIFEST="$ROOT/$MANIFEST_NAME"

if [ ! -f "$MANIFEST" ]; then
  printf 'check-supply-chain-policy: no %s under %s\n' "$MANIFEST_NAME" "$ROOT" >&2
  exit 2
fi

# The blocks whose entries are supply-chain opt-outs: each one waives a default
# that exists to keep unreviewed code out. `packages` is not one of them.
GUARDED_BLOCKS=" minimumReleaseAgeExclude allowBuilds "

# --- text helpers -------------------------------------------------------------------------

trim() { # trim <string> -> the string with leading and trailing whitespace removed
  local s=$1
  s=${s#"${s%%[![:space:]]*}"}
  s=${s%"${s##*[![:space:]]}"}
  printf '%s' "$s"
}

# Drops a trailing `# …` comment from a scalar value. Anchored on whitespace
# before the `#`, which is what YAML requires for an inline comment, so a `#`
# inside a value is left alone. `%%` removes the longest matching suffix, i.e.
# it cuts at the FIRST such `#`, not the last.
strip_inline_comment() { # strip_inline_comment <value> -> the value without its comment
  local s=$1
  s=${s%%[[:space:]]#*}
  trim "$s"
}

is_positive_integer() { # is_positive_integer <string>
  case "$1" in
    '' | *[!0-9]*) return 1 ;;
    *) [ "$((10#$1))" -gt 0 ] ;;
  esac
}

is_plain_key() { # is_plain_key <text before the first colon> <whole line>
  # "$1" = "$2" means there was no colon to split on at all.
  [ "$1" != "$2" ] || return 1
  case "$1" in
    '' | *[!A-Za-z0-9_-]*) return 1 ;;
    *) return 0 ;;
  esac
}

# --- the pass -----------------------------------------------------------------------------

block=""         # the guarded block we are inside, or "" for anywhere else
entry_indent=-1  # indentation of that block's entries, fixed by its first entry
justified=0      # did the contiguous comment run directly above carry any text?
line_no=0
entries_seen=0
release_age=""
release_age_strict=""
offenders=()

# `read -r` with a `|| [ -n "$line" ]` tail so a final line with no newline is
# still processed rather than dropped.
while IFS= read -r line || [ -n "$line" ]; do
  line_no=$((line_no + 1))
  line=${line%$'\r'}

  leading=${line%%[![:space:]]*}
  trimmed=$(trim "$line")

  if [ -z "$trimmed" ]; then
    # A blank line separates a comment from whatever follows it. Requiring the
    # justification to sit DIRECTLY above the entry is the whole point: a comment
    # further up is about something else.
    justified=0
    continue
  fi

  case "$leading" in
    *$'\t'*)
      printf 'check-supply-chain-policy: %s:%d is indented with a tab, which YAML does not allow\n' \
        "$MANIFEST_NAME" "$line_no" >&2
      exit 2
      ;;
  esac
  indent=${#leading}

  case "$trimmed" in
    '#'*)
      # A comment run stays "justified" if any line in it has text after the `#`.
      # A bare `#` on its own explains nothing.
      if [ -n "$(trim "${trimmed#\#}")" ]; then
        justified=1
      fi
      continue
      ;;
  esac

  if [ "$indent" -eq 0 ]; then
    key=${line%%:*}
    if ! is_plain_key "$key" "$line"; then
      printf 'check-supply-chain-policy: %s:%d is not a top-level key and not a comment: %s\n' \
        "$MANIFEST_NAME" "$line_no" "$trimmed" >&2
      printf '  This gate parses one shape only, and refuses rather than skips — a line it\n' >&2
      printf '  cannot read could be an opt-out it would then pass without looking.\n' >&2
      exit 2
    fi

    value=$(strip_inline_comment "${line#*:}")
    case "$key" in
      minimumReleaseAge) release_age=$value ;;
      minimumReleaseAgeStrict) release_age_strict=$value ;;
    esac

    case "$GUARDED_BLOCKS" in
      *" $key "*)
        # A guarded key with anything after the colon is holding an inline (flow)
        # collection: `minimumReleaseAgeExclude: ['left-pad@1.3.0', …]`. There are
        # no indented lines beneath it, so the block-shaped reader below walks an
        # empty block and reports zero opt-outs — silent green on precisely the
        # key this gate exists for. Not hypothetical: pnpm patches the existing
        # YAML document rather than rewriting it, so a manifest already in flow
        # style keeps it, and every entry pnpm then appends lands unread.
        #
        # An empty `[]` or `{}` would be harmless, and is refused anyway: "a
        # guarded key's entries live on indented lines beneath it" is a rule worth
        # more than the one manifest it inconveniences, and rewriting it in block
        # style costs a line.
        if [ -n "$value" ]; then
          printf 'check-supply-chain-policy: %s:%d writes %s as an inline collection\n' \
            "$MANIFEST_NAME" "$line_no" "$key" >&2
          printf '  %s\n' "$trimmed" >&2
          printf '\n  This gate reads opt-out entries from the indented lines beneath their key, so\n' >&2
          printf '  it cannot see these — and a justification comment has nowhere to go either.\n' >&2
          printf '  Rewrite the block in indented (block) style, one entry per line.\n' >&2
          exit 2
        fi
        block=$key
        ;;
      *) block="" ;;
    esac
    entry_indent=-1
    justified=0
    continue
  fi

  # Indented, non-blank, non-comment: an entry, or a continuation of one.
  if [ -z "$block" ]; then
    justified=0
    continue
  fi

  if [ "$entry_indent" -lt 0 ]; then
    entry_indent=$indent
  fi

  if [ "$indent" -lt "$entry_indent" ]; then
    printf 'check-supply-chain-policy: %s:%d dedents inside %s without closing it\n' \
      "$MANIFEST_NAME" "$line_no" "$block" >&2
    exit 2
  fi

  if [ "$indent" -eq "$entry_indent" ]; then
    entries_seen=$((entries_seen + 1))
    if [ "$justified" -eq 0 ]; then
      offenders+=("$MANIFEST_NAME:$line_no  $block  $trimmed")
    fi
  fi
  justified=0
done <"$MANIFEST"

# --- the verdict --------------------------------------------------------------------------

problems=()

if [ -z "$release_age" ]; then
  problems+=("minimumReleaseAge is not set. Unset, pnpm runs the 24h quarantine in loose mode and auto-writes minimumReleaseAgeExclude instead of failing.")
elif ! is_positive_integer "$release_age"; then
  problems+=("minimumReleaseAge is '$release_age'; it must be a positive number of minutes (0 or a non-number disables the quarantine).")
fi

if [ "$release_age_strict" != "true" ]; then
  problems+=("minimumReleaseAgeStrict is '${release_age_strict:-unset}'; it must be true, so a too-fresh version fails the install instead of being auto-excluded.")
fi

if [ ${#problems[@]} -ne 0 ]; then
  printf '\ncheck-supply-chain-policy: %s does not arm the quarantine\n' "$MANIFEST_NAME" >&2
  for problem in "${problems[@]}"; do
    printf '  ERROR %s\n' "$problem" >&2
  done
  exit 1
fi

if [ ${#offenders[@]} -ne 0 ]; then
  printf '\ncheck-supply-chain-policy: %d supply-chain opt-out(s) in %s with no justification above them\n' \
    "${#offenders[@]}" "$MANIFEST_NAME" >&2
  for offender in "${offenders[@]}"; do
    printf '  ERROR %s\n' "$offender" >&2
  done
  printf '\npnpm writes these entries itself. An entry with no comment directly above it is\n' >&2
  printf 'one nobody decided on: revert it (git checkout -- %s) and resolve to\n' "$MANIFEST_NAME" >&2
  printf 'a version that satisfies the policy, or keep it and write down why it is safe.\n' >&2
  exit 1
fi

printf 'check-supply-chain-policy: OK — %s sets minimumReleaseAge=%s, minimumReleaseAgeStrict=%s; %d opt-out entr(y/ies), all justified\n' \
  "$MANIFEST_NAME" "$release_age" "$release_age_strict" "$entries_seen"
