#!/usr/bin/env bash
# Shared helpers for the worktree lifecycle scripts (reap / rebranch).
# Sourced, never executed.
set -u
export PATH="/opt/homebrew/bin:$PATH"

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  echo "worktree-lib.sh is a sourced library, not an executable script" >&2
  exit 2
fi

# Env knobs, all overridable by the caller.
: "${WORKTREE_MIN_AGE_MINUTES:=60}" # minutes of git-dir quiet required before reaping; 0 disables the guard
: "${WORKTREE_GH_CMD:=gh}"          # GitHub CLI used for the squash-merge check
: "${WORKTREE_PNPM_CMD:=pnpm}"      # package manager used to reinstall deps after a rebranch
: "${WORKTREE_FETCH_MAIN:=1}"       # 0 means a caller has already refreshed origin/main this run

# canon <path> -> absolute, symlink-resolved path (works for paths that do not exist).
# macOS puts temp dirs behind /var -> /private/var, so string comparison needs this.
canon() {
  python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$1"
}

# main_checkout_dir <path> -> the main checkout of the repo containing <path>.
# The common git dir is shared by every linked worktree, so it identifies the main checkout.
main_checkout_dir() {
  local common
  common=$(git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  common=${common%/}
  printf '%s\n' "${common%/.git}"
}

# is_clean <worktree> -> 0 when the tree has no changes at all.
# Untracked files count as dirty (unreviewed work is still work); ignored files such as
# node_modules do not, since --porcelain omits them without --ignored.
#
# --no-optional-locks is load-bearing, not tidiness: a plain `status` takes $GIT_DIR/index.lock
# to write back the refreshed index, and creating + removing that file bumps the mtime of the
# per-worktree admin dir. reap-worktree.sh's min-age guard measures exactly that mtime, so a
# locking status call makes every worktree look "active" the instant we inspect it — the guard
# would then never let anything through. The guard is also ordered ahead of this call, so
# neither mechanism alone is what keeps it working.
#
# `git -C` walks up to the enclosing repository when the worktree's own .git file is missing,
# so this answers for the MAIN checkout on a broken-linked worktree; reap-worktree.sh verifies
# that link before it ever calls here.
is_clean() {
  local status
  status=$(git -C "$1" --no-optional-locks status --porcelain 2>/dev/null) || return 1
  [ -z "$status" ]
}

# fetch_main <main-dir> -> best-effort refresh of the base ref is_merged compares against.
# Always succeeds: a stale base ref costs the ancestry fast path, never a safety property.
#
# This is a separate call, not a step inside is_merged, so the decision to touch the network
# and the object store belongs to whoever owns the run. That buys two things is_merged could
# not offer on its own: a sweep hoists one fetch above its loop instead of paying one per
# candidate, and a --dry-run skips it and writes nothing whatsoever.
fetch_main() {
  git -C "$1" fetch --quiet origin main >/dev/null 2>&1 || true
}

# is_merged <branch> <tip> <main-dir> -> prints one of:
#   merged-ancestor | merged-squash | unmerged | unverifiable
# This repo squash-merges, so a merged branch's tip is NOT an ancestor of main. Ancestry is
# only a fast path (it also catches never-committed branches); the authoritative check asks
# GitHub whether a merged PR CONTAINED this tip — either as its head, or anywhere in its
# commit list.
#
# Containment rather than head-equality, because head-equality strands genuinely merged
# branches (#204, PRs #203/#205/#207). `gh pr update-branch` before a squash merges main into
# the PR branch, so headRefOid becomes a merge commit the local object store has never seen
# and never can name; the local tip then equals nothing on the PR and every lifecycle script
# refuses. A tip listed among the PR's commits is the property the callers actually need
# before they `branch -D`: the tip is an ancestor of headRefOid, so everything reachable from
# it went into the squash and no commit is stranded.
#
# Deliberately NOT fetch + `merge-base` against headRefOid, which would prove the same thing
# from local objects: is_merged must never write to the repository. Keeping it read-only is
# what lets --dry-run leave the tree byte-identical, makes a dry run and a real run reach the
# same verdict, and spares the callers a new "do not touch the object store" knob. gh already
# returns commits in the same `pr list` call, so containment costs no extra round trip.
#
# Reads whatever base ref is on disk and never refreshes it (see fetch_main). Staleness can
# only turn a merge the fast path would have spotted into a question for the gh check, and the
# gh check is the authoritative one — so a caller that must not write is giving up speed, not
# safety.
is_merged() {
  local branch="$1" tip="$2" main_dir="$3" base="" prs rc

  if git -C "$main_dir" rev-parse --verify --quiet refs/remotes/origin/main >/dev/null 2>&1; then
    base=refs/remotes/origin/main
  elif git -C "$main_dir" rev-parse --verify --quiet refs/heads/main >/dev/null 2>&1; then
    base=refs/heads/main
  fi

  if [ -n "$base" ] && git -C "$main_dir" merge-base --is-ancestor "$tip" "$base" 2>/dev/null; then
    printf 'merged-ancestor\n'
    return 0
  fi

  if ! prs=$("$WORKTREE_GH_CMD" pr list --state merged --head "$branch" --json headRefOid,commits --limit 10 2>/dev/null); then
    printf 'unverifiable\n'
    return 0
  fi

  printf '%s' "$prs" | python3 -c '
import json, sys

try:
    prs = json.load(sys.stdin)
except Exception:
    sys.exit(2)
tip = sys.argv[1]


def contains(pr):
    """Did this merged PR carry the local tip? A missing or null commit list is tolerated."""
    if pr.get("headRefOid") == tip:
        return True
    return any(commit.get("oid") == tip for commit in pr.get("commits") or [])


sys.exit(0 if any(contains(pr) for pr in prs) else 1)
' "$tip"
  rc=$?

  case "$rc" in
    0) printf 'merged-squash\n' ;;
    1) printf 'unmerged\n' ;;
    *) printf 'unverifiable\n' ;;
  esac
}
