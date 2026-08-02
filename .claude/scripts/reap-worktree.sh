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

common_dir=$(git -C "$main_dir" rev-parse --path-format=absolute --git-common-dir) || exit 2
list=$(git -C "$main_dir" worktree list --porcelain) || exit 2
entry=$(printf '%s' "$list" | python3 -c '
import os, sys

target, common = sys.argv[1], sys.argv[2]


def admin_dir():
    """The per-worktree admin dir the MAIN repo records for target, or "".

    The porcelain output does not carry it (git 2.50), so this reads the records that
    worktree list is itself built on: under the common git dir, worktrees/<name>/gitdir
    holds the path of that worktree .git file. Matching on realpath is the same identity
    rule the block scan below uses, so one lookup answers both "is this one of ours" and
    "which admin dir is its own". The alternative -- asking the target directory to name
    its own git dir -- is what this exists to avoid: that search walks up through parents,
    and since Cumulo nests worktrees inside the main checkout, a worktree whose .git file
    is missing answers with the admin dir of the MAIN repo. Reading these files cannot
    bump the mtime the min-age probe measures.
    """
    base = os.path.join(common, "worktrees")
    try:
        names = sorted(os.listdir(base))
    except OSError:
        return ""
    for name in names:
        try:
            with open(os.path.join(base, name, "gitdir")) as handle:
                link = handle.read().strip()
        except OSError:
            continue
        if link and os.path.realpath(os.path.dirname(link)) == target:
            return os.path.join(base, name)
    return ""


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
        print("1 %d %d %s %s" % ("locked" in block, "detached" in block,
                                 block.get("branch", "") or "-", admin_dir() or "-"))
        break
else:
    print("0 0 0 - -")
' "$wt" "$common_dir") || exit 2

found=$(printf '%s' "$entry" | cut -d' ' -f1)
locked=$(printf '%s' "$entry" | cut -d' ' -f2)
detached=$(printf '%s' "$entry" | cut -d' ' -f3)
branch_ref=$(printf '%s' "$entry" | cut -d' ' -f4)
# Last field, taken with -f5- rather than -f5: an admin dir is a path and may contain spaces.
admin_dir=$(printf '%s' "$entry" | cut -d' ' -f5-)

[ "$found" = "1" ] || keep "not-a-worktree"
[ "$locked" = "1" ] && keep "locked"

# --- own-cwd: never remove the directory this process is running in ----------------------
pwd_canon=$(canon "$PWD") || exit 2
case "$pwd_canon" in
  "$wt" | "$wt"/*) keep "own-cwd" ;;
esac

[ "$detached" = "1" ] && keep "detached"

# --- recently-active: a git dir touched moments ago means someone is still working -------
# Ordered BEFORE is_clean deliberately. The probe reads the admin dir's mtime, so it has to
# run before anything that writes there — a plain `git status` takes index.lock inside that
# dir and would make the worktree look active purely because we just looked at it, silencing
# the guard forever. is_clean uses --no-optional-locks so it no longer writes, but this
# ordering means the guard survives a future edit that reintroduces a locking git command.
# Only checks that reached this point read-only may be moved above it: `worktree list` and
# `rev-parse` are verified not to touch the admin dir.
#
# The dir it measures came down from the lookup that identified this worktree, i.e. from what
# the main repo records — deliberately not `rev-parse --absolute-git-dir` run inside the
# target. That search walks up through parent directories, and Cumulo nests worktrees inside
# the main checkout, so a worktree whose .git file has gone missing answers with the MAIN
# repo's admin dir. The probe would then be reading the main checkout's activity while
# reporting on this worktree.
[ "$admin_dir" = "-" ] && keep "no-admin-dir"

# --- broken-git-link: the worktree still points back at the admin dir recorded for it ----
# Ordered ahead of every probe below, the min-age one included, and that ordering is the
# point. A nested worktree that has lost its .git file answers every walk-up query with the
# MAIN checkout — `is_clean` included, since it runs `git -C "$wt" status` — so until the link
# is proven, "clean" or "quiet" may be a fact about the enclosing repository rather than about
# this worktree. Refusing here means no probe ever runs on a worktree that cannot answer for
# itself, and the operator gets a name for the breakage instead of git's remove failure.
#
# Shape: a linked worktree's .git is a regular file holding `gitdir: <admin dir>`. git 2.50.1
# writes an absolute path; a relative one is resolved against the worktree before comparing,
# since git accepts either. Missing, unreadable, wrong prefix, or pointing somewhere other
# than the admin dir the main repo records — all one verdict: this link cannot be trusted.
link=""
[ -f "$wt/.git" ] && IFS= read -r link <"$wt/.git"
case "$link" in
  "gitdir: "?*) link=${link#gitdir: } ;;
  *) keep "broken-git-link" ;;
esac
case "$link" in
  /*) ;;
  *) link="$wt/$link" ;;
esac
link_dir=$(canon "$link") || exit 2
recorded_dir=$(canon "$admin_dir") || exit 2
[ "$link_dir" = "$recorded_dir" ] || keep "broken-git-link"

if [ "$WORKTREE_MIN_AGE_MINUTES" != "0" ]; then
  # A find that errors tells us nothing about activity, so it refuses rather than guesses.
  recent=$(find "$admin_dir" -mmin -"$WORKTREE_MIN_AGE_MINUTES" -print -quit 2>/dev/null) || keep "recently-active"
  [ -n "$recent" ] && keep "recently-active"
fi

is_clean "$wt" || keep "dirty"

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
# One refresh of the base ref, here, and only on a real run. --dry-run must leave the
# repository byte-identical — "destroys nothing" was true before, "writes nothing" was not —
# and a sweep that has already fetched for the whole run passes WORKTREE_FETCH_MAIN=0 so N
# candidates cost one fetch instead of N. Skipping it can only cost the ancestry fast path,
# never a safety check: is_merged says why.
if [ "$dry_run" = "0" ] && [ "$WORKTREE_FETCH_MAIN" != "0" ]; then
  fetch_main "$main_dir"
fi

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
