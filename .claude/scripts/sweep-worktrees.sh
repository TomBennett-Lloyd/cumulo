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

# --- base ref: one refresh for the whole sweep -------------------------------------------
# The fetch used to live inside is_merged, which meant a sweep paid one per candidate — and a
# dry sweep wrote remote-tracking refs and objects for every worktree it merely looked at.
# Now it happens once here, not at all under --dry-run, and every child is told the base ref is
# already as fresh as this run will make it. Exported rather than passed as a flag because it
# describes the run, not the target: anything reap spawns inherits the same answer.
if [ "$dry_run" = "0" ]; then
  fetch_main "$main_dir"
fi
export WORKTREE_FETCH_MAIN=0

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

  # < /dev/null, not tidiness: this loop reads the worktree list from the process's own stdin,
  # and a child that reads stdin reads the entries the loop has not reached yet. reap runs a
  # caller-supplied $WORKTREE_GH_CMD, so "the child never reads stdin" is not ours to promise.
  # The worktrees it swallowed would then be skipped in silence — a backstop reporting
  # "kept 1" over a repo holding five worktrees looks exactly like a backstop with nothing to
  # do, which is the one failure mode a backstop must not have.
  #
  # Through `bash`, not directly: the exec bit is not assumed, because `git show` writes mode 644
  # and an extracted copy of these scripts must still sweep (#204).
  if [ "$dry_run" = "1" ]; then
    bash "$script_dir/reap-worktree.sh" "$wt" --dry-run </dev/null
    rc=$?
  else
    bash "$script_dir/reap-worktree.sh" "$wt" </dev/null
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

# --- stale admin entries: reported, never pruned -----------------------------------------
# This used to run `git worktree prune` unconditionally, which destroyed admin data under
# --dry-run. The guarantee used to stop at "--dry-run destroys nothing" because is_merged
# fetched per candidate, writing remote-tracking refs and objects; with that fetch hoisted
# above the loop and skipped in dry mode, a dry run now writes nothing to the repository at
# all — no ref, no object, no admin entry.
# Reporting is now the behaviour in BOTH modes, for a reason beyond dry-run:
# reap-worktree.sh removes worktrees via `git worktree remove`, which cleans up its own admin
# dir, so a sweep never leaves an entry of its own to prune. Prune could therefore only ever
# fire on the one case this tool has no business deciding — a worktree directory that vanished
# for an unknown reason. Pruning it discards $GIT_DIR/worktrees/<name>, and a directory that
# comes back (restored from a backup, remounted, un-renamed) is then unrepairable and any
# uncommitted work in it needs manual surgery. Ambiguity resolves to KEPT here as everywhere:
# say what is stale, leave the decision to a human.
if stale=$(git -C "$main_dir" worktree prune --dry-run --verbose 2>&1); then
  if [ -n "$stale" ]; then
    # Double quotes, not backticks, around the suggested command: this string is printed to a
    # terminal, where backticks are not markdown emphasis but the thing that makes a reader —
    # and shellcheck (SC2016) — read it as an unexpanded command substitution.
    printf 'WARN stale worktree admin entries in %s (not pruned — run "git worktree prune" by hand once you are sure nothing is recoverable):\n' "$main_dir"
    printf '%s\n' "$stale" | sed 's/^/  /'
  fi
else
  # Purely informational, so a failure to report is not a failure to sweep.
  printf 'WARN could not check for stale worktree admin entries in %s\n' "$main_dir"
fi

# A dry run must never claim to have deleted anything, so the count it reports is labelled as
# the hypothetical it is.
if [ "$dry_run" = "1" ]; then
  swept_label="would sweep"
else
  swept_label="swept"
fi

if [ "$failed" -gt 0 ]; then
  printf '%s %d, kept %d, failed %d\n' "$swept_label" "$swept" "$kept" "$failed"
  exit 2
fi
printf '%s %d, kept %d\n' "$swept_label" "$swept" "$kept"
