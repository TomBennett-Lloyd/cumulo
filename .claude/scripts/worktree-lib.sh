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

# node is the repo's declared runtime (package.json engines.node >= 22) and the only interpreter
# these scripts assume. Checked once, at source time, rather than at each call site: every
# function below that needs it needs it unconditionally, and a lifecycle script that discovers
# the gap halfway through — after `worktree list`, before the merge check — would have to invent
# a verdict for a question it could not ask. Refusing up front means the operator gets the tool's
# name instead of a script that keeps or reaps for an unrelated-looking reason.
command -v node >/dev/null 2>&1 || {
  echo "worktree-lib.sh: node is required (package.json engines) and is not on PATH — refusing to run" >&2
  exit 2
}

# canon <path> -> absolute, symlink-resolved path (works for paths that do not exist).
# macOS puts temp dirs behind /var -> /private/var, so string comparison needs this.
#
# Non-strict on purpose — `realpath -e` semantics would be wrong here. The sweep canonicalises
# every path `git worktree list` reports, and a worktree directory that has vanished is still a
# registered entry it must be able to name; a strict resolver would abort the whole sweep over
# the one candidate it exists to report on.
#
# The walk-up is what buys that: resolve the deepest ancestor that does exist, then re-attach the
# components that do not. Symlinked prefixes are therefore still resolved for a path whose leaf
# is missing (/tmp/gone -> /private/tmp/gone), which plain string assembly would not do.
canon() {
  node -e 'const fs=require("fs"),path=require("path");let p=path.resolve(process.argv[1]),tail="";for(;;){try{console.log(path.join(fs.realpathSync(p),tail));break}catch(e){tail=path.join(path.basename(p),tail);const parent=path.dirname(p);if(parent===p){console.log(path.join(p,tail));break}p=parent}}' "$1"
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

  # The verdict is carried by the exit status, not by anything printed: 0 contained, 1 did not,
  # 2 the answer could not be read at all. That third code is why the parse lives here rather
  # than in `gh --jq` — the harness stubs gh with a script that prints JSON, and moving the
  # query into gh would make every stub have to implement jq to be a stub at all.
  printf '%s' "$prs" | node -e '
const fs = require("fs");
let prs;
try {
  prs = JSON.parse(fs.readFileSync(0, "utf8"));
} catch {
  process.exit(2);
}
// A top level that is not an array is not a PR list. gh answering with something else — an
// error object, an envelope — is a question that went unanswered, so it exits 2 and the caller
// reports "unverifiable" rather than reading "unmerged" out of a shape it never parsed.
if (!Array.isArray(prs)) {
  process.exit(2);
}
const tip = process.argv[1];
// Did this merged PR carry the local tip? A missing or null commit list is tolerated.
const contains = (pr) =>
  pr.headRefOid === tip || (pr.commits || []).some((commit) => commit && commit.oid === tip);
process.exit(prs.some(contains) ? 0 : 1);
' "$tip"
  rc=$?

  case "$rc" in
    0) printf 'merged-squash\n' ;;
    1) printf 'unmerged\n' ;;
    *) printf 'unverifiable\n' ;;
  esac
}
