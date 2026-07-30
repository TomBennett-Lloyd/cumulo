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
is_clean() {
  local status
  status=$(git -C "$1" --no-optional-locks status --porcelain 2>/dev/null) || return 1
  [ -z "$status" ]
}

# is_merged <branch> <tip> <main-dir> -> prints one of:
#   merged-ancestor | merged-squash | unmerged | unverifiable
# This repo squash-merges, so a merged branch's tip is NOT an ancestor of main. Ancestry is
# only a fast path (it also catches never-committed branches); the authoritative check asks
# GitHub whether a merged PR had exactly this tip as its head.
is_merged() {
  local branch="$1" tip="$2" main_dir="$3" base="" prs rc

  # Best effort: a stale base ref only ever costs us a false "unmerged", which is safe.
  git -C "$main_dir" fetch --quiet origin main >/dev/null 2>&1 || true

  if git -C "$main_dir" rev-parse --verify --quiet refs/remotes/origin/main >/dev/null 2>&1; then
    base=refs/remotes/origin/main
  elif git -C "$main_dir" rev-parse --verify --quiet refs/heads/main >/dev/null 2>&1; then
    base=refs/heads/main
  fi

  if [ -n "$base" ] && git -C "$main_dir" merge-base --is-ancestor "$tip" "$base" 2>/dev/null; then
    printf 'merged-ancestor\n'
    return 0
  fi

  if ! prs=$("$WORKTREE_GH_CMD" pr list --state merged --head "$branch" --json headRefOid --limit 10 2>/dev/null); then
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
sys.exit(0 if any(pr.get("headRefOid") == tip for pr in prs) else 1)
' "$tip"
  rc=$?

  case "$rc" in
    0) printf 'merged-squash\n' ;;
    1) printf 'unmerged\n' ;;
    *) printf 'unverifiable\n' ;;
  esac
}
