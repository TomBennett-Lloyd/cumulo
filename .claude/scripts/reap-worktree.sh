#!/usr/bin/env bash
# Remove a finished agent worktree and its branch, but only when every safety check passes.
# Deleting a developer's work is unrecoverable, so every ambiguity resolves to KEPT.
#
# Usage: reap-worktree.sh <worktree-path> [--dry-run]
# Exit:  0 reaped (or would reap), 1 kept, 2 usage error or unexpected git failure.
set -u
export PATH="/opt/homebrew/bin:$PATH"

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2
# shellcheck source=./worktree-lib.sh
. "$script_dir/worktree-lib.sh"

usage() {
  echo "usage: reap-worktree.sh <worktree-path> [--dry-run]" >&2
  exit 2
}

dry_run=0
target=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=1 ;;
    -*) usage ;;
    *)
      [ -n "$target" ] && usage
      target="$1"
      ;;
  esac
  shift
done
[ -n "$target" ] || usage

wt=$(canon "$target") || exit 2

keep() {
  printf 'KEPT %s — %s\n' "$wt" "$1"
  exit 1
}

# --- main-checkout / not-a-worktree ------------------------------------------------------
main_dir=$(main_checkout_dir "$wt") || keep "not-a-worktree"
main_dir=$(canon "$main_dir") || exit 2
[ "$wt" = "$main_dir" ] && keep "main-checkout"

list=$(git -C "$main_dir" worktree list --porcelain) || exit 2
entry=$(printf '%s' "$list" | python3 -c '
import os, sys

target = sys.argv[1]
blocks, cur = [], {}
for line in sys.stdin.read().splitlines():
    if not line.strip():
        if cur:
            blocks.append(cur)
            cur = {}
        continue
    key, _, value = line.partition(" ")
    cur[key] = value
if cur:
    blocks.append(cur)

for block in blocks:
    path = block.get("worktree", "")
    if path and os.path.realpath(path) == target:
        print("1 %d %d %s" % ("locked" in block, "detached" in block,
                              block.get("branch", "") or "-"))
        break
else:
    print("0 0 0 -")
' "$wt") || exit 2

found=$(printf '%s' "$entry" | cut -d' ' -f1)
locked=$(printf '%s' "$entry" | cut -d' ' -f2)
detached=$(printf '%s' "$entry" | cut -d' ' -f3)
branch_ref=$(printf '%s' "$entry" | cut -d' ' -f4)

[ "$found" = "1" ] || keep "not-a-worktree"
[ "$locked" = "1" ] && keep "locked"

# --- own-cwd: never remove the directory this process is running in ----------------------
pwd_canon=$(canon "$PWD") || exit 2
case "$pwd_canon" in
  "$wt" | "$wt"/*) keep "own-cwd" ;;
esac

[ "$detached" = "1" ] && keep "detached"
is_clean "$wt" || keep "dirty"

# --- recently-active: a git dir touched moments ago means someone is still working -------
git_dir=$(git -C "$wt" rev-parse --absolute-git-dir) || exit 2
if [ "$WORKTREE_MIN_AGE_MINUTES" != "0" ]; then
  # A find that errors tells us nothing about activity, so it refuses rather than guesses.
  recent=$(find "$git_dir" -mmin -"$WORKTREE_MIN_AGE_MINUTES" -print -quit 2>/dev/null) || keep "recently-active"
  [ -n "$recent" ] && keep "recently-active"
fi

# --- live-session: any process whose cwd sits in the worktree ----------------------------
if ! cwds=$(lsof -a -d cwd -Fn 2>/dev/null); then
  keep "live-session"
fi
while IFS= read -r line; do
  case "$line" in
    n*) ;;
    *) continue ;;
  esac
  path=${line#n}
  case "$path" in
    "$wt" | "$wt"/*) keep "live-session" ;;
  esac
done <<EOF
$cwds
EOF

# --- merge state -------------------------------------------------------------------------
branch=${branch_ref#refs/heads/}
tip=$(git -C "$main_dir" rev-parse "$branch_ref") || exit 2
case "$(is_merged "$branch" "$tip" "$main_dir")" in
  merged-ancestor | merged-squash) ;;
  unmerged) keep "unmerged" ;;
  *) keep "unverifiable-merge" ;;
esac

if [ "$dry_run" = "1" ]; then
  printf 'WOULD-REAP %s (%s)\n' "$wt" "$branch"
  exit 0
fi

# No --force. Ignored files do NOT block a plain remove (verified on git 2.50.1 with a
# populated node_modules), so the only thing --force would add is the power to delete work
# that appeared between is_clean above and this line. A plain remove refuses in that race
# and we exit 2 with the worktree intact, which is the outcome this script exists to prefer.
git -C "$main_dir" worktree remove "$wt" || exit 2
# -D not -d: -d compares against a possibly-stale local main and would reject squash-merged
# branches. The merge safety lives in is_merged, above.
git -C "$main_dir" branch -D "$branch" >/dev/null || exit 2
printf 'REAPED %s (%s)\n' "$wt" "$branch"
