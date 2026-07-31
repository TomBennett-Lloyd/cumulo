#!/usr/bin/env bash
#
# Runs every shell test harness in this directory — the implementation behind
# `pnpm test:scripts`, and through it `pnpm verify`.
#
# The harness list is DISCOVERED, never hard-coded, for the same reason
# lint-shell.sh discovers its file list: `test:scripts` used to be a literal
# `bash a.test.sh && bash b.test.sh && …` chain in package.json, which had two
# silent failure modes. A harness added next to the others was green by absence
# until somebody remembered to extend the string (the drift class #47/#64 fixed
# one level up, for the CI -> `verify` edge, and left in place for the
# `verify` -> harnesses edge). And `&&` short-circuits: the first red harness
# hid every later harness's findings, turning one fix-everything cycle into
# several. So: discover, run all of them regardless of failures, summarise, and
# treat "found nothing" as broken rather than as a pass.
#
# Usage:
#   bash .claude/scripts/run-script-tests.sh [--list] [dir]
#
#     dir      directory to search (default: the directory holding this script)
#     --list   print the discovered harnesses and exit without running any
#
# Exit:  0 every harness passed, 1 at least one failed, 2 the runner itself
#        could not reach a verdict (bad arguments, missing directory, a failed
#        or empty discovery, or a recursive invocation).
#
# On self-reference: this runner's own harness, run-script-tests.test.sh, lives
# in this directory and is therefore discovered and run like any other — it is
# NOT special-cased, because a skip list is the hand-enumeration this script
# exists to delete. It does not recurse: every case that actually *runs* the
# runner points it at a throwaway fixture directory, and the one case that
# covers the shipped default target uses `--list`, which discovers without
# executing. The guard below makes that a structural property rather than a
# convention — a target directory already being run by an ancestor invocation is
# refused outright, so a future harness that reached for the default target
# would fail loudly and finitely instead of forking until the box gives up.
#
set -uo pipefail
# Homebrew's prefix is not on a non-interactive shell's default PATH on this
# machine (same reason worktree-lib.sh and lint-shell.sh do it). Harmless on
# Linux, where the directory does not exist.
export PATH="/opt/homebrew/bin:$PATH"

SCRIPTS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2

list_only=0
target=""

while [ $# -gt 0 ]; do
  case "$1" in
    --list)
      list_only=1
      ;;
    -h | --help)
      cat <<'EOF'
Usage: bash .claude/scripts/run-script-tests.sh [--list] [dir]

  dir      directory to search for *.test.sh (default: this script's directory)
  --list   print the discovered harnesses and exit without running any

Exit: 0 all passed, 1 at least one failed, 2 no verdict reached.
EOF
      exit 0
      ;;
    -*)
      printf 'run-script-tests: unknown option %s\n' "$1" >&2
      exit 2
      ;;
    *)
      if [ -n "$target" ]; then
        printf 'run-script-tests: expected at most one directory, got a second: %s\n' "$1" >&2
        exit 2
      fi
      target="$1"
      ;;
  esac
  shift
done

target=${target:-$SCRIPTS}

if [ ! -d "$target" ]; then
  printf 'run-script-tests: %s is not a directory\n' "$target" >&2
  exit 2
fi
target_canon=$(cd "$target" && pwd -P) || exit 2

# `find` rather than a flat glob so a harness in a subdirectory is still found,
# and LC_ALL=C so the order is the caller's locale's business, not the report's.
#
# Discovery is written to a file and its exit status checked, rather than piped
# straight into the read loop. That is not ceremony: a `find` that cannot descend
# into one subdirectory prints "Permission denied" to stderr, exits non-zero, and
# STILL emits everything it did reach. Piped into a loop, that partial listing
# runs as if it were the whole suite — a red harness behind an unreadable
# directory reported as "1 harness(es), 0 failed" — and `pipefail` cannot help,
# because the pipeline lives inside a process substitution whose status the
# parent shell never sees. A partial listing is the one outcome worse than none,
# so it is refused outright.
discovered=$(mktemp "${TMPDIR:-/tmp}/run-script-tests.XXXXXX") || exit 2
trap 'rm -f "$discovered"' EXIT INT TERM

if ! find "$target_canon" -type f -name '*.test.sh' >"$discovered"; then
  printf 'run-script-tests: discovery failed under %s — find exited non-zero (its own error is above)\n' "$target_canon" >&2
  printf '  find still lists what it could reach, so continuing would run a subset of the\n' >&2
  printf '  suite and report it as the whole of it. No verdict is the honest answer.\n' >&2
  exit 2
fi

# Same reasoning one step on: a sort that fails has produced a truncated list, so
# its status is checked too. `-o` naming the input file is explicitly supported.
if ! LC_ALL=C sort -o "$discovered" "$discovered"; then
  printf 'run-script-tests: could not sort the discovered harnesses under %s\n' "$target_canon" >&2
  exit 2
fi

harnesses=()
while IFS= read -r path; do
  [ -n "$path" ] || continue
  harnesses+=("$path")
done <"$discovered"

harness_count=${#harnesses[@]}

if [ "$harness_count" -eq 0 ]; then
  printf 'run-script-tests: found no *.test.sh under %s\n' "$target_canon" >&2
  printf '  A harness suite that discovers nothing is green by absence, not green.\n' >&2
  exit 2
fi

if [ "$list_only" = "1" ]; then
  for path in "${harnesses[@]}"; do
    printf '%s\n' "$path"
  done
  exit 0
fi

# Recursion guard. The membership test is a literal substring test, not a `case`
# glob: a directory path containing `[`, `*` or `?` is a legal path and must
# still match itself (docs/tech-debt.md carries the same finding against the
# worktree scripts' self-protection guards).
seen=":${CUMULO_SCRIPT_TEST_TARGETS:-}:"
needle=":$target_canon:"
if [ "${seen%%"$needle"*}" != "$seen" ]; then
  printf 'run-script-tests: refusing to recurse — %s is already being run by an enclosing invocation\n' "$target_canon" >&2
  printf '  A harness under that directory invoked this runner against it. Point the\n' >&2
  printf '  nested call at a fixture directory, or use --list, which does not execute.\n' >&2
  exit 2
fi
export CUMULO_SCRIPT_TEST_TARGETS="${CUMULO_SCRIPT_TEST_TARGETS:-}${CUMULO_SCRIPT_TEST_TARGETS:+:}$target_canon"

printf 'run-script-tests: %d harness(es) under %s\n' "$harness_count" "$target_canon"

failed=0
results=()

for path in "${harnesses[@]}"; do
  name=$(basename "$path")
  printf '\n--- %s ---\n' "$name"
  # No `&&`, no `set -e`: every harness runs, whatever the ones before it did.
  # Output is streamed rather than captured so a failing harness's own report is
  # visible in place, above the summary that names it.
  bash "$path"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    results+=("PASS $name")
  else
    results+=("FAIL $name (exit $rc)")
    failed=$((failed + 1))
  fi
done

printf '\n=== run-script-tests summary ===\n'
for line in "${results[@]}"; do
  printf '%s\n' "$line"
done
printf '%d harness(es), %d failed\n' "$harness_count" "$failed"

[ "$failed" -eq 0 ] || exit 1
