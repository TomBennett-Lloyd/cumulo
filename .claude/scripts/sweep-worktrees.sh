#!/usr/bin/env bash
# Backstop for agent worktrees whose session was killed before the merging agent could reap
# them (issue #34). Offers every linked worktree to reap-worktree.sh, which owns all the
# safety checks — this script only decides what to offer, never whether it is safe to delete.
#
# Usage: sweep-worktrees.sh [--dry-run]   (finds the repo from the cwd)
# Exit:  0 the sweep ran (reaping nothing is a normal outcome), 2 unexpected failure.
set -u
export PATH="/opt/homebrew/bin:$PATH"

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2
# shellcheck source=./worktree-lib.sh
. "$script_dir/worktree-lib.sh"

usage() {
  echo "usage: sweep-worktrees.sh [--dry-run]" >&2
  exit 2
}

# There is deliberately no --force: the only way to widen what gets deleted is to change
# reap-worktree.sh, where the safety checks are reviewed together.
dry_run=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=1 ;;
    *) usage ;;
  esac
  shift
done

main_dir=$(main_checkout_dir "$PWD") || {
  echo "sweep-worktrees.sh must run inside a git worktree" >&2
  exit 2
}
main_dir=$(canon "$main_dir") || exit 2
pwd_canon=$(canon "$PWD") || exit 2

# --- main checkout: report only ----------------------------------------------------------
# A parked main checkout is the workflow's invariant, so drifting off main is worth saying
# out loud — but the main checkout is never a sweep target, whatever branch it is on.
main_branch=$(git -C "$main_dir" branch --show-current) || exit 2
if [ -z "$main_branch" ]; then
  printf 'WARN main checkout is on a detached HEAD — should be parked on main (CLAUDE.md Workflow)\n'
elif [ "$main_branch" != "main" ]; then
  printf "WARN main checkout is on '%s' — should be parked on main (CLAUDE.md Workflow)\n" "$main_branch"
fi

list=$(git -C "$main_dir" worktree list --porcelain) || exit 2
paths=$(printf '%s' "$list" | python3 -c '
import os, sys

for line in sys.stdin.read().splitlines():
    key, _, value = line.partition(" ")
    if key == "worktree" and value:
        print(os.path.realpath(value))
') || exit 2

swept=0
kept=0
failed=0

while IFS= read -r wt; do
  [ -n "$wt" ] || continue
  [ "$wt" = "$main_dir" ] && continue

  # Self-protection is decided here rather than left to reap-worktree.sh's own-cwd check,
  # so the invoking session is excluded by path comparison before any check can misfire.
  case "$pwd_canon" in
    "$wt" | "$wt"/*)
      printf 'KEPT %s — self\n' "$wt"
      kept=$((kept + 1))
      continue
      ;;
  esac

  if [ "$dry_run" = "1" ]; then
    "$script_dir/reap-worktree.sh" "$wt" --dry-run
    rc=$?
  else
    "$script_dir/reap-worktree.sh" "$wt"
    rc=$?
  fi

  case "$rc" in
    0) swept=$((swept + 1)) ;;
    1) kept=$((kept + 1)) ;; # KEPT is the expected outcome, not an error
    *)
      printf 'ERROR reap-worktree.sh exited %d for %s\n' "$rc" "$wt" >&2
      failed=$((failed + 1))
      ;;
  esac
done <<EOF
$paths
EOF

git -C "$main_dir" worktree prune || {
  echo "worktree prune failed in $main_dir" >&2
  failed=$((failed + 1))
}

if [ "$failed" -gt 0 ]; then
  printf 'swept %d, kept %d, failed %d\n' "$swept" "$kept" "$failed"
  exit 2
fi
printf 'swept %d, kept %d\n' "$swept" "$kept"
