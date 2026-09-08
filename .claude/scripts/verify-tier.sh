#!/usr/bin/env bash
#
# The tier classifier behind `pnpm verify` (#476).
#
# `verify` used to be one 13-leg composite, run whole before every commit. For a
# markdown-only change set only four of those legs can observe the change —
# verify:root, check:adr-index, check:markdown-links, format:check. The other
# nine cannot see a .md file at all: eslint, stylelint, tsc and vitest are not
# given one, and the remaining check:* gates read manifests, Terraform and
# TypeScript. Paying for them on a three-file prose PR buys nothing.
#
# The tier is DERIVED, never chosen. That distinction is the whole design:
# CLAUDE.md bans hand-picking legs because a human picking "the relevant ones"
# is how a gate stops running, and a flag like `--docs` would be exactly that
# ban with a nicer spelling. Nobody is asked what changed; git is.
#
#   every changed path matches \.md$   ->  docs tier
#   anything else                      ->  the full composite, `pnpm verify:full`
#
# FAIL CLOSED, everywhere. An empty change set, a git command that fails, a
# fetch that cannot reach the remote, a path this script cannot classify — every
# one of them runs the full composite. The docs tier is only ever reached by a
# positive answer to "is every one of these N paths markdown", so the failure
# direction is always "ran too much", never "ran too little". Offline is
# therefore not a regression: it is today's behaviour.
#
# THE SOUNDNESS GUARD, and where it differs from #476's wording.
#
# The docs tier rests on a claim — "no test can observe this markdown" — and a
# claim nobody checks is an assumption. #476 asked for a blanket grep: any \.md
# reference anywhere in the test trees forces full. That form is not
# implementable here, and the reason is worth stating rather than discovering
# again. check-adr-index.test.sh and check-markdown-links.test.sh build markdown
# FIXTURES by the dozen, so the blanket grep returns ~200 hits on a clean tree
# and would pin every run on the full tier forever — the ticket would deliver
# nothing, and this script's own harness would add hits of its own.
#
# So the guard is scoped to the change set, which is the sharper question in any
# case: could a test observe THESE files? For every changed .md path, its
# repo-relative path and its basename are grepped, as fixed strings, across
# every *.test.* / *.spec.* / *.test.sh file git knows about. Any hit is printed
# with file and line, and forces the full tier. The basename arm is what catches
# a path assembled at runtime — join(root, 'docs', 'x.md') contains no
# repo-relative path but does contain the basename — and it costs false
# positives on prose that merely names a file ("testing.md rule 7"). Those cost
# a full run, which is the direction this script is allowed to be wrong in.
#
# CI is deliberately NOT tiered: .github/workflows/ci.yml calls `verify:full`
# explicitly. The saving here is on the local iteration loop, where the composite
# is paid several times per PR; widening it to CI is a separate decision with its
# own evidence, and until then CI's coverage is unchanged by this script.
#
# Usage: bash .claude/scripts/verify-tier.sh [--dry-run] [REPO_ROOT]
#          REPO_ROOT defaults to the repository holding this script; the argument
#          exists so the harness can point the classifier at throwaway fixtures.
#          --dry-run classifies and prints, and runs no gate.
# Exit:  the delegated tier's exit code (0 pass, non-zero a red gate), or 2 if
#        the invocation itself was wrong.
#
set -uo pipefail
# Homebrew's prefix is not on a non-interactive shell's default PATH on this
# machine (same reason lint-shell.sh and worktree-lib.sh do it). Harmless on
# Linux, where the directory does not exist.
export PATH="/opt/homebrew/bin:$PATH"

SCRIPTS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2

# How many of the classified paths are listed before the list is summarised. A
# branch can carry a hundred files since its merge-base and a hundred-line dump
# before every gate is noise; the tier and the count are the load-bearing parts.
LIST_CAP=20

dry_run=0
root_arg=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)
      dry_run=1
      ;;
    -h | --help)
      cat <<'EOF'
Usage: bash .claude/scripts/verify-tier.sh [--dry-run] [REPO_ROOT]

  REPO_ROOT   repository to classify (default: the one holding this script)
  --dry-run   classify and print the tier, run no gate

Exit: the delegated tier's exit code, or 2 if the invocation was wrong.
EOF
      exit 0
      ;;
    -*)
      printf 'verify-tier: unknown option %s\n' "$1" >&2
      exit 2
      ;;
    *)
      if [ -n "$root_arg" ]; then
        printf 'verify-tier: expected at most one directory, got a second: %s\n' "$1" >&2
        exit 2
      fi
      root_arg="$1"
      ;;
  esac
  shift
done

if [ -n "$root_arg" ]; then
  if [ ! -d "$root_arg" ]; then
    printf 'verify-tier: not a directory: %s\n' "$root_arg" >&2
    exit 2
  fi
  ROOT=$(cd "$root_arg" && pwd -P) || exit 2
else
  # The script's own directory, not the caller's: `pnpm verify` runs from the
  # workspace root today, but a classifier that silently followed a stale shell
  # cwd into another checkout is the failure the `verify root:` line exists to
  # catch, and this one would pick the tier from the wrong tree's diff.
  ROOT=$(git -C "$SCRIPTS" rev-parse --show-toplevel) || exit 2
fi
# Every later command runs in the repository under classification, so a `cd`
# that failed cannot be mistaken for a grep that found nothing.
cd "$ROOT" || exit 2

TMP=$(mktemp -d "${TMPDIR:-/tmp}/verify-tier.XXXXXX") || exit 2
trap 'rm -rf "$TMP"' EXIT INT TERM

CHANGED="$TMP/changed"
TESTS="$TMP/tests"
PATTERNS="$TMP/patterns"

# core.quotePath=false keeps non-ASCII paths readable rather than \xNN-escaped.
# A path holding a quote or a newline is still quoted by git, and a quoted path
# does not end in `.md`, so it classifies as non-markdown and runs the full
# composite — fail-closed, and the reason line shows the quoting.
git_at() {
  git -C "$ROOT" -c core.quotePath=false "$@"
}

reason=""

# collect_change_set -> writes the change set to $CHANGED, one path per line.
# Returns 1 with $reason set if any part of the derivation could not be trusted.
#
# Three sources, because no single git command covers them: what is edited or
# staged against HEAD, what is untracked but not ignored, and what this branch
# has committed since it left origin/main. The fetch is what makes the third one
# honest — a stale refs/remotes/origin/main puts the merge-base too far back,
# which widens the change set, which can only ever move the tier towards full.
collect_change_set() {
  local base
  if ! git_at fetch --quiet origin main >/dev/null 2>&1; then
    reason="could not fetch origin main (offline, or no such remote)"
    return 1
  fi
  if ! base=$(git_at merge-base HEAD refs/remotes/origin/main 2>/dev/null) || [ -z "$base" ]; then
    reason="no merge-base between HEAD and origin/main"
    return 1
  fi
  if ! git_at diff --name-only HEAD >"$TMP/raw" 2>/dev/null; then
    reason="git diff --name-only HEAD failed"
    return 1
  fi
  if ! git_at ls-files --others --exclude-standard >>"$TMP/raw" 2>/dev/null; then
    reason="git ls-files --others failed"
    return 1
  fi
  if ! git_at diff --name-only "$base...HEAD" >>"$TMP/raw" 2>/dev/null; then
    reason="git diff --name-only $base...HEAD failed"
    return 1
  fi
  if ! LC_ALL=C sort -u "$TMP/raw" >"$TMP/sorted"; then
    reason="could not sort the change set"
    return 1
  fi
  # grep exits 1 when nothing survives, which here means an empty change set —
  # a legitimate state the caller reports on its own terms, not a failure. Hence
  # the explicit `return 0` rather than falling off the end on grep's status.
  grep -v '^$' "$TMP/sorted" >"$CHANGED"
  return 0
}

# guard_hits -> 0 the change set is unobservable by any test, 1 it may not be.
# Writes the offending file:line matches to $TMP/hits when it returns 1.
guard_hits() {
  local f count=0
  if ! git_at ls-files >"$TMP/allfiles" 2>/dev/null ||
    ! git_at ls-files --others --exclude-standard >>"$TMP/allfiles" 2>/dev/null; then
    reason="could not enumerate the test files to check the change set against"
    return 1
  fi
  grep -E '(\.test\.|\.spec\.)' "$TMP/allfiles" | LC_ALL=C sort -u >"$TESTS"

  # An empty scan is a broken scan, not a clean one — the same rule the check:*
  # gates apply to their own censuses. A repo whose test files cannot be found
  # has no evidence to offer about what its tests can see.
  if [ ! -s "$TESTS" ]; then
    reason="found no test files to check the change set against — an empty scan is not a clean one"
    return 1
  fi

  : >"$PATTERNS"
  while IFS= read -r f; do
    printf '%s\n%s\n' "$f" "${f##*/}" >>"$PATTERNS"
  done <"$CHANGED"

  # ls-files lists paths that are deleted in the working tree too; grep would
  # exit 2 on those and turn a clean guard into an error.
  files=()
  while IFS= read -r f; do
    [ -f "$ROOT/$f" ] || continue
    files+=("$f")
    count=$((count + 1))
  done <"$TESTS"
  if [ "$count" -eq 0 ]; then
    reason="every discovered test file is absent from the working tree"
    return 1
  fi

  # -F: the patterns are paths, and a path's dots are not wildcards.
  grep -nF -f "$PATTERNS" -- "${files[@]}" >"$TMP/hits" 2>/dev/null
  case $? in
    0)
      reason="a test file references a markdown path in this change set"
      return 1
      ;;
    1)
      return 0
      ;;
    *)
      reason="the guard grep over the test files failed"
      return 1
      ;;
  esac
}

print_list() {
  local shown=0 f
  while IFS= read -r f; do
    if [ "$shown" -ge "$LIST_CAP" ]; then
      printf '  … and %d more\n' "$((changed_count - LIST_CAP))"
      break
    fi
    printf '  %s\n' "$f"
    shown=$((shown + 1))
  done <"$CHANGED"
}

tier=full
changed_count=0

if collect_change_set; then
  changed_count=$(grep -c '' <"$CHANGED")
  if [ "$changed_count" -eq 0 ]; then
    reason="the change set is empty"
  else
    non_md=$(grep -v -E '\.md$' "$CHANGED" | head -1)
    if [ -n "$non_md" ]; then
      reason="not all markdown — e.g. $non_md"
    elif guard_hits; then
      tier=docs
      reason="every path is markdown, and no test references one of them"
    fi
  fi
fi

if [ "$tier" = "docs" ]; then
  printf 'verify tier: docs — %d file(s); %s\n' "$changed_count" "$reason"
  print_list
else
  if [ "$changed_count" -gt 0 ]; then
    printf 'verify tier: full — %d file(s); %s\n' "$changed_count" "$reason"
    print_list
  else
    printf 'verify tier: full — %s\n' "$reason"
  fi
  if [ -s "$TMP/hits" ]; then
    while IFS= read -r hit; do
      printf '  guard: %s\n' "$hit"
    done <"$TMP/hits"
  fi
fi

if [ "$tier" = "docs" ]; then
  legs="pnpm check:adr-index && pnpm check:markdown-links && pnpm format:check"
else
  legs="pnpm verify:full"
fi

if [ "$dry_run" = "1" ]; then
  printf 'verify tier: dry run — would run: %s\n' "$legs"
  exit 0
fi

# The full tier delegates to the unconditional composite rather than restating
# its legs: package.json is the one place that list lives (the same reason the
# CI step calls the composite instead of enumerating gates), and a second copy
# here would be the drift #47 was filed for. The docs tier's four legs are the
# subset that can observe markdown at all; verify:root is not among them because
# `verify` has already run it before reaching this script.
#
# On the full tier the `verify root:` line is therefore printed twice — once by
# `verify`, once by the composite it delegates to. They are the same line about
# the same tree; the alternative is a `verify:full` that no longer states which
# tree it ran in, which the evidence ritual depends on.
if [ "$tier" = "docs" ]; then
  pnpm check:adr-index && pnpm check:markdown-links && pnpm format:check
else
  pnpm verify:full
fi
