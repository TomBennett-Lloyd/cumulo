#!/usr/bin/env bash
# Restatement-ledger gate: every ledger declared under `.claude/ledgers/` has its
# sweep re-run on every `pnpm verify`, and the ledger must still say what the
# sweep returns (#535).
#
# What this exists for. `docs/standards/architecture.md` rule 9 asks each owned
# value's carriers to be listed in a ledger the owner points at, as a floor with
# its sweep named, and until this gate nothing re-ran a banked sweep: a carrier written in the
# sweep's own words joined the claim without joining the list, a listed carrier
# paraphrased out of the sweep stayed listed, and a sweep banked mid-batch was
# stale at merge. Membership was a string match and the claim was carried by
# meaning; this is the runner that makes the string match mechanical.
#
# THE FORMAT (rule 9 points here and lists no keys; this header is its one owner).
# A ledger is a file `.claude/ledgers/<id>.ledger` where <id> matches
# ^[a-z0-9-]+$. Lines beginning `#` are comments; blank lines are ignored; every
# other line is `key: value` (one space after the colon, value trimmed of
# trailing whitespace). Keys:
#
#   owner: <repo-relative path>        exactly once — the file holding the owning
#                                      declaration. It MUST contain the literal
#                                      `.claude/ledgers/<id>.ledger`, and the sweep
#                                      MUST return it (the sweep's positive control).
#   claim: <one line of prose>         exactly once — what is owned, in words; the
#                                      gate checks only non-emptiness.
#   sweep: <PCRE>                      exactly once — run as the single argument of
#                                      git -C <root> grep --no-color -n -I -P --untracked -e <sweep> -- <scope tokens>
#   scope: <pathspec> [<pathspec>...]  at most once — space-separated git pathspecs
#                                      (`:!docs/tech-debt.md`); absent means the whole tree.
#   carrier: <repo-relative path>      one or more — a file the sweep returns that
#                                      restates, asserts, computes with or argues from
#                                      the claim. MUST be returned by the sweep.
#   excluded: <repo-relative path>     zero or more — a file the sweep returns that is
#                                      not a carrier (narration, a snapshot). MAY stop
#                                      being returned: a tech-debt row dying at triage
#                                      is not drift.
#
# Alphabets, refused loudly (exit 2): paths ^[A-Za-z0-9._/-]+$ with no leading `/`
# and no `..` component; scope tokens ^[A-Za-z0-9._/:!*(),-]+$; `sweep:` any
# non-empty text, reaching git only as one argv element — never through `eval` or
# `bash -c`. The ledger file's own path is exempt from both membership checks (it
# holds the pattern).
#
# Membership, in both directions, with the owner as the positive control. Drift
# (exit 1): a hit path that is neither listed nor the owner nor the ledger file; a
# `carrier:` the sweep no longer returns; the `owner:` the sweep no longer returns.
# The gate compares MEMBERSHIP, never values — a carrier holding a wrong copy still
# matches — so rule 10's true-up stays the change's job, and rule 8's mirror gate
# (check-infra-mirrors.sh) remains the one that compares values.
#
# `-I` is mandatory: the tree holds PNGs and a .woff2, and a binary match prints no
# `path:line:` shape. `--untracked` is mandatory: a carrier created but not yet
# `git add`-ed is the state a lane runs `pnpm verify` in (docs/standards/evidence.md
# member 8, "name the state a check is asserted in"). Ignored files stay out —
# `.claude/worktrees/` is gitignored, so the main checkout never sweeps sibling
# worktrees.
#
# The OK line prints counts only and never a pattern, so a run redirected into an
# untracked file inside the repository cannot become its own unlisted hit.
#
# Refusals are exit 2, never a pass: a missing or empty `.claude/ledgers/`, a file in
# it not named <id>.ledger, a malformed ledger, an invalid pattern ("broken check,
# not a clean tree" — sweep-report.sh's reasoning). Blockers outrank drift.
#
# Usage: bash .claude/scripts/check-ledgers.sh [REPO_ROOT]
#        (or `pnpm check:ledgers`)
#        REPO_ROOT defaults to the repo root above this script; the argument exists so
#        the test harness can point the gate at throwaway fixtures.
# Exit:  0 every ledger holds, 1 at least one has drifted, 2 the gate could not reach a
#        verdict.
#
# Runs under bash 3.2, which macOS ships as /bin/bash.
set -uo pipefail

usage() {
  printf 'Usage: bash .claude/scripts/check-ledgers.sh [REPO_ROOT]\n'
  printf 'Re-runs every sweep declared in REPO_ROOT/.claude/ledgers/*.ledger and checks it against its list.\n'
  printf 'Exit: 0 holds, 1 drifted, 2 could not reach a verdict.\n'
}

case "${1:-}" in
  -h | --help)
    usage
    exit 0
    ;;
esac

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2
ROOT=${1:-"$SCRIPT_DIR/../.."}

if [ ! -d "$ROOT" ]; then
  printf 'check-ledgers: not a directory: %s\n' "$ROOT" >&2
  exit 2
fi
ROOT=$(cd "$ROOT" && pwd -P) || exit 2

top=$(git -C "$ROOT" rev-parse --show-toplevel 2>/dev/null)
if [ "$top" != "$ROOT" ]; then
  printf 'check-ledgers: %s is not the top of a git repository\n' "$ROOT" >&2
  exit 2
fi

LEDGER_DIR="$ROOT/.claude/ledgers"
if [ ! -d "$LEDGER_DIR" ]; then
  printf 'check-ledgers: no .claude/ledgers directory under %s — green by absence is not green\n' "$ROOT" >&2
  exit 2
fi

entries=$(find "$LEDGER_DIR" -mindepth 1 -maxdepth 1 | LC_ALL=C sort)
if [ -z "$entries" ]; then
  printf 'check-ledgers: .claude/ledgers is empty — green by absence is not green\n' >&2
  exit 2
fi

SCRATCH=$(mktemp -d) || exit 2
trap 'rm -rf "$SCRATCH"' EXIT INT TERM

NAME_RE='^[a-z0-9-]+\.ledger$'
LINE_RE='^([a-z]+): (.+)$'
PATH_RE='^[A-Za-z0-9._/-]+$'
SCOPE_RE='^[A-Za-z0-9._/:!*(),-]+$'

blockers=()
drift=()
ledger_count=0
carrier_count=0
summaries=()

# in_list <needle> <item>... — 0 when needle equals one of the items.
in_list() {
  local needle="$1" item
  shift
  for item in "$@"; do
    [ "$item" = "$needle" ] && return 0
  done
  return 1
}

# parse_ledger <file> — sets L_ID, L_OWNER, L_SWEEP, L_SCOPE and the L_CARRIERS /
# L_EXCLUDED arrays, appending to `blockers` for everything it refuses.
parse_ledger() {
  local file="$1" base lineno=0 line key value n_owner=0 n_claim=0 n_sweep=0 n_scope=0 item tokens
  base=$(basename "$file")
  L_ID=${base%.ledger}
  L_OWNER="" L_SWEEP="" L_SCOPE=""
  L_CARRIERS=()
  L_EXCLUDED=()
  while IFS= read -r line || [ -n "$line" ]; do
    lineno=$((lineno + 1))
    case "$line" in
      '#'* | '') continue ;;
    esac
    if ! [[ $line =~ $LINE_RE ]]; then
      blockers+=("$base:$lineno: not a 'key: value' line")
      continue
    fi
    key=${BASH_REMATCH[1]}
    value=${BASH_REMATCH[2]}
    value=${value%"${value##*[![:space:]]}"}
    if [ -z "$value" ]; then
      blockers+=("$base:$lineno: '$key' has no value")
      continue
    fi
    case "$key" in
      owner)
        n_owner=$((n_owner + 1))
        L_OWNER=$value
        ;;
      claim)
        n_claim=$((n_claim + 1))
        ;;
      sweep)
        n_sweep=$((n_sweep + 1))
        L_SWEEP=$value
        ;;
      scope)
        n_scope=$((n_scope + 1))
        L_SCOPE=$value
        read -r -a tokens <<<"$value"
        for item in "${tokens[@]}"; do
          [[ $item =~ $SCOPE_RE ]] || blockers+=("$base:$lineno: scope token outside the alphabet: '$item'")
        done
        ;;
      carrier | excluded)
        if ! [[ $value =~ $PATH_RE ]] || [[ $value == /* ]] || [[ /$value/ == *"/../"* ]]; then
          blockers+=("$base:$lineno: $key path outside the alphabet: '$value'")
        elif [ "$key" = "carrier" ]; then
          L_CARRIERS+=("$value")
        else
          L_EXCLUDED+=("$value")
        fi
        ;;
      *)
        blockers+=("$base:$lineno: unknown key '$key'")
        ;;
    esac
  done <"$file"

  [ "$n_owner" -eq 1 ] || blockers+=("$base: needs exactly one owner: line, found $n_owner")
  [ "$n_claim" -eq 1 ] || blockers+=("$base: needs exactly one claim: line, found $n_claim")
  [ "$n_sweep" -eq 1 ] || blockers+=("$base: needs exactly one sweep: line, found $n_sweep")
  [ "$n_scope" -le 1 ] || blockers+=("$base: at most one scope: line, found $n_scope")
  [ "${#L_CARRIERS[@]}" -ge 1 ] || blockers+=("$base: needs at least one carrier: line")

  for item in ${L_CARRIERS[@]+"${L_CARRIERS[@]}"}; do
    if in_list "$item" ${L_EXCLUDED[@]+"${L_EXCLUDED[@]}"}; then
      blockers+=("$base: '$item' is listed as both carrier: and excluded:")
    fi
  done

  if [ "$n_owner" -eq 1 ]; then
    if ! [[ $L_OWNER =~ $PATH_RE ]] || [[ $L_OWNER == /* ]] || [[ /$L_OWNER/ == *"/../"* ]]; then
      blockers+=("$base: owner path outside the alphabet: '$L_OWNER'")
    elif [ ! -f "$ROOT/$L_OWNER" ]; then
      blockers+=("$base: owner does not exist in the tree: '$L_OWNER'")
    elif ! grep -qF -- ".claude/ledgers/$L_ID.ledger" "$ROOT/$L_OWNER"; then
      blockers+=("$base: owner '$L_OWNER' does not name .claude/ledgers/$L_ID.ledger by path")
    fi
  fi
}

# --- pass 1: parse everything before sweeping anything ---------------------------------------

valid_files=()
while IFS= read -r entry; do
  name=$(basename "$entry")
  if ! [[ $name =~ $NAME_RE ]] || [ ! -f "$entry" ]; then
    blockers+=("$name: not a regular file named <id>.ledger with id in [a-z0-9-]")
    continue
  fi
  valid_files+=("$entry")
  parse_ledger "$entry"
done <<EOF
$entries
EOF

# --- pass 2: sweep, only when every ledger parsed -------------------------------------------

if [ ${#blockers[@]} -eq 0 ]; then
  for file in ${valid_files[@]+"${valid_files[@]}"}; do
    parse_ledger "$file"
    ledger_rel=".claude/ledgers/$L_ID.ledger"
    scope_args=()
    if [ -n "$L_SCOPE" ]; then
      read -r -a scope_args <<<"$L_SCOPE"
    fi
    hits_out="$SCRATCH/$L_ID.hits"
    hits_err="$SCRATCH/$L_ID.err"
    git -C "$ROOT" grep --no-color -n -I -P --untracked -e "$L_SWEEP" -- ${scope_args[@]+"${scope_args[@]}"} >"$hits_out" 2>"$hits_err"
    sweep_rc=$?
    if [ "$sweep_rc" -gt 1 ] || [ -s "$hits_err" ]; then
      blockers+=("$L_ID: the sweep did not run cleanly (rc=$sweep_rc): $(head -n1 "$hits_err") — a broken check, not a clean tree")
      continue
    fi
    LC_ALL=C cut -d: -f1 "$hits_out" | LC_ALL=C sort -u >"$SCRATCH/$L_ID.paths"

    while IFS= read -r hit_path; do
      [ -n "$hit_path" ] || continue
      [ "$hit_path" = "$ledger_rel" ] && continue
      [ "$hit_path" = "$L_OWNER" ] && continue
      in_list "$hit_path" ${L_CARRIERS[@]+"${L_CARRIERS[@]}"} && continue
      in_list "$hit_path" ${L_EXCLUDED[@]+"${L_EXCLUDED[@]}"} && continue
      first=$(awk -v p="$hit_path:" 'index($0, p) == 1 {
        rest = substr($0, length(p) + 1); n = index(rest, ":")
        print p substr(rest, 1, n) " " substr(rest, n + 1); exit }' "$hits_out" | cut -c1-160)
      drift+=("$L_ID: unlisted hit — $first")
    done <"$SCRATCH/$L_ID.paths"

    returned=0
    for item in ${L_CARRIERS[@]+"${L_CARRIERS[@]}"}; do
      if grep -qxF -- "$item" "$SCRATCH/$L_ID.paths"; then
        returned=$((returned + 1))
      else
        drift+=("$L_ID: carrier not returned by the sweep — $item")
      fi
    done
    grep -qxF -- "$L_OWNER" "$SCRATCH/$L_ID.paths" ||
      drift+=("$L_ID: owner not returned by the sweep — $L_OWNER")

    ledger_count=$((ledger_count + 1))
    carrier_count=$((carrier_count + returned))
    summaries+=("  $L_ID: owner $L_OWNER, $returned carrier(s) returned, ${#L_EXCLUDED[@]} excluded, 0 unlisted")
  done
fi

# --- the verdict -----------------------------------------------------------------------------
#
# Blockers outrank drift: "the sweep could not run" is not a verdict about whether the
# list is complete, and reporting it as one is the failure this gate exists to prevent.

if [ ${#blockers[@]} -ne 0 ]; then
  printf '\ncheck-ledgers: %d problem(s) stopped the gate reaching a verdict\n' "${#blockers[@]}" >&2
  for blocker in "${blockers[@]}"; do
    printf '  BLOCKED %s\n' "$blocker" >&2
  done
  printf '\nA ledger this gate cannot read or run is not a ledger it has approved. Fix the\n' >&2
  printf 'file under .claude/ledgers/, or restore what it names.\n' >&2
  exit 2
fi

if [ ${#drift[@]} -ne 0 ]; then
  printf '\ncheck-ledgers: %d ledger line(s) no longer match their sweep\n' "${#drift[@]}" >&2
  for item in "${drift[@]}"; do
    printf '  ERROR %s\n' "$item" >&2
  done
  printf '\nA hit the ledger does not classify is a carrier nobody has read: add it to\n' >&2
  printf '.claude/ledgers/<id>.ledger as carrier: or excluded:, or narrow scope:. A listed\n' >&2
  printf 'carrier the sweep no longer returns has been deleted or paraphrased: re-cite the\n' >&2
  printf 'owner there or strike the line. An owner the sweep no longer returns means the\n' >&2
  printf 'pattern no longer matches the value it ledgers.\n' >&2
  exit 1
fi

for item in ${summaries[@]+"${summaries[@]}"}; do
  printf '%s\n' "$item"
done
printf 'check-ledgers: OK — %d ledger(s), %d carrier(s) returned, 0 unlisted hit(s)\n' "$ledger_count" "$carrier_count"
