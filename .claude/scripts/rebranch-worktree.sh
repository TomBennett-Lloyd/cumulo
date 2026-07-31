#!/usr/bin/env bash
# Recycle the current worktree onto a fresh branch cut from an updated origin/main, so an
# agent that just merged can continue working without a fresh clone + install.
#
# Usage: rebranch-worktree.sh <new-branch>   (operates on the cwd's worktree)
# Exit:  0 rebranched, 1 refused, 2 usage error or unexpected failure.
set -u
export PATH="/opt/homebrew/bin:$PATH"

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2
# shellcheck source=./worktree-lib.sh
. "$script_dir/worktree-lib.sh"

refuse() {
  printf 'REFUSED %s\n' "$1" >&2
  exit 1
}

[ $# -eq 1 ] || {
  echo "usage: rebranch-worktree.sh <new-branch>" >&2
  exit 2
}
new_branch="$1"
[ -n "$new_branch" ] || {
  echo "usage: rebranch-worktree.sh <new-branch>" >&2
  exit 2
}

top=$(git rev-parse --show-toplevel 2>/dev/null) || refuse "not inside a git worktree"
top=$(canon "$top") || exit 2

main_dir=$(main_checkout_dir "$top") || exit 2
main_dir=$(canon "$main_dir") || exit 2
[ "$top" = "$main_dir" ] && refuse "$top is the main checkout — rebranch only recycles linked worktrees"

git -C "$top" show-ref --verify --quiet "refs/heads/$new_branch" &&
  refuse "branch $new_branch already exists"

is_clean "$top" || refuse "$top has uncommitted or untracked changes"

old_branch=$(git -C "$top" symbolic-ref --quiet --short HEAD) ||
  refuse "$top is on a detached HEAD — no branch to retire"

tip=$(git -C "$top" rev-parse HEAD) || exit 2
# is_merged reads the base ref and never refreshes it, so ask for the refresh here — one
# interactive rebranch has no run to hoist it out of, and this keeps the ancestry fast path
# exactly as accurate as it has always been. Best effort: the hard fetch is further down.
fetch_main "$main_dir"
case "$(is_merged "$old_branch" "$tip" "$main_dir")" in
  merged-ancestor | merged-squash) ;;
  unmerged) refuse "$old_branch is not merged — rebranching would strand its commits" ;;
  *) refuse "could not verify whether $old_branch is merged" ;;
esac

# Hard requirement, unlike the best-effort fetch_main above: the new branch must start from an
# up-to-date main, not from a stale remote-tracking ref. Failing that fetch costs the ancestry
# fast path a merge it could have spotted; failing this one would cut the branch from the wrong
# commit, so it exits instead.
git -C "$top" fetch origin main || {
  echo "fetch of origin/main failed — rebranch needs an updated main" >&2
  exit 2
}

# Clean tree + merged branch means this is exactly "rebase onto updated main".
# --no-track: the new branch starts at origin/main but is not a copy of it, so tracking it
# would make `git status` read "ahead of origin/main" for the whole task. Push with -u.
git -C "$top" switch -c "$new_branch" --no-track origin/main || exit 2
git -C "$top" branch -D "$old_branch" >/dev/null || exit 2
sha=$(git -C "$top" rev-parse HEAD) || exit 2

# The lockfile may have moved on main while this worktree was busy.
(cd "$top" && "$WORKTREE_PNPM_CMD" install --frozen-lockfile) || {
  echo "install failed, but the branch switch already succeeded: $top is on $new_branch at $sha; rerun the install by hand" >&2
  exit 2
}

printf 'REBRANCHED %s -> %s at %s\n' "$old_branch" "$new_branch" "$sha"
