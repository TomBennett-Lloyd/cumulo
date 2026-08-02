#!/usr/bin/env bash
# Test harness for the worktree lifecycle scripts (reap / rebranch / sweep).
#
# Self-contained on purpose: no test framework beyond the shared vocabulary in harness-lib.sh
# next door, no network, no gh, no pnpm. Every fixture is a throwaway repo under a single
# `mktemp -d` that a trap deletes on exit, so the harness can exercise the destructive paths
# (real `worktree remove`, real `branch -D`) without ever being able to touch the repository
# it ships in.
#
# Usage: bash .claude/scripts/worktree-lifecycle.test.sh   (or `pnpm test:scripts`)
# Exit:  0 every case PASS, 1 at least one FAIL, 2 the harness itself broke.
set -uo pipefail
export PATH="/opt/homebrew/bin:$PATH"

shipped_scripts=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2

# The assertion vocabulary is sourced from $shipped_scripts, NOT from $SCRIPTS, and the
# distinction is the negative control below: WORKTREE_SCRIPTS_DIR points at an older revision
# of the four lifecycle scripts, which predates harness-lib.sh and holds no copy of it. The
# harness's own tooling is never part of what the override swaps — only the subject is.
# shellcheck source=./harness-lib.sh
. "$shipped_scripts/harness-lib.sh"

# The scripts under test, overridable so the same cases can be run against an older revision as
# a negative control (testing.md rule 4: a regression case is only worth its line count once it
# has been seen to fail on the pre-fix code). Same convention as lint-shell.test.sh's
# LINT_SHELL_GATE, but a directory rather than a file: these four scripts source and exec each
# other by name, so they can only be swapped as a set.
#
#   mkdir /tmp/pre
#   for s in worktree-lib reap-worktree rebranch-worktree sweep-worktrees; do
#     git show <rev>:.claude/scripts/$s.sh >/tmp/pre/$s.sh
#   done
#   chmod +x /tmp/pre/*.sh
#   WORKTREE_SCRIPTS_DIR=/tmp/pre bash .claude/scripts/worktree-lifecycle.test.sh
#
# The chmod stays in the recipe even though the shipped sweep no longer needs it. Revisions
# predating #204 EXECUTE their sibling reap-worktree.sh rather than running it through `bash`,
# and `git show` writes mode 644, so an extraction of one of those still needs the bit or its
# sweep cases fail with "swept 0, kept 0, failed N" — a bisect that looks like a real regression
# in the revision under test and is not. For post-fix revisions the chmod is simply harmless,
# which is why one recipe can serve both: case 32 is what pins the shipped behaviour, and it
# builds its own mode-644 copy rather than relying on how the recipe was run.
#
# Those four files are the whole of what the directory needs to hold: harness-lib.sh is always
# the shipped one, so an extracted revision from before it existed still runs.
#
# Unset — how `pnpm test:scripts` runs it — is the shipped set.
SCRIPTS=${WORKTREE_SCRIPTS_DIR:-$shipped_scripts}

harness_init_tmp

# The background `sleep` that case 8 parks inside a fixture worktree outlives the case if it
# fails early, and the temp tree cannot be removed cleanly with a process still holding a cwd
# in it.
# So the kill loop runs from the library's EXIT trap, ahead of its `rm -rf`.
bg_pids=""
harness_extra_cleanup() {
  for pid in $bg_pids; do
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
  done
}

# --- harness plumbing, the part with only this consumer ------------------------------------

expect_exists() { [ -e "$1" ] || bad "expected to still exist: $1"; }
expect_gone() { [ ! -e "$1" ] || bad "expected to be gone: $1"; }

expect_branch() {
  git -C "$1" show-ref --verify --quiet "refs/heads/$2" || bad "branch $2 should still exist"
}

expect_no_branch() {
  if git -C "$1" show-ref --verify --quiet "refs/heads/$2"; then bad "branch $2 should be gone"; fi
}

expect_eq() { # expect_eq <label> <actual> <expected>
  [ "$2" = "$3" ] || bad "$1: expected '$3', got '$2'"
}

# --- fixtures ----------------------------------------------------------------------------

# Identity is passed per-command: the harness must not depend on (or write) any git config.
gitc() {
  local dir="$1"
  shift
  git -C "$dir" -c user.email=test@test -c user.name=test -c commit.gpgsign=false "$@"
}

# fixture <name> -> sets ROOT to a fresh $TMP_ROOT/<name> holding a bare origin plus a
# `git clone` of it as the main checkout, one commit deep on main.
fixture() {
  ROOT="$TMP_ROOT/$1"
  must mkdir -p "$ROOT"
  must git init --quiet --bare -b main "$ROOT/origin.git"
  must git init --quiet -b main "$ROOT/seed"
  must printf 'node_modules/\n' >"$ROOT/seed/.gitignore"
  must printf 'base\n' >"$ROOT/seed/file.txt"
  must gitc "$ROOT/seed" add -A
  must gitc "$ROOT/seed" commit --quiet -m base
  must gitc "$ROOT/seed" remote add origin "$ROOT/origin.git"
  must gitc "$ROOT/seed" push --quiet origin main
  must rm -rf "$ROOT/seed"
  must git clone --quiet "$ROOT/origin.git" "$ROOT/main"
}

# add_wt <branch> <dirname> -> linked worktree at $ROOT/<dirname> on a new branch cut from main.
add_wt() {
  must git -C "$ROOT/main" worktree add --quiet -b "$1" "$ROOT/$2" main
}

# commit_in <dir> <message> -> one commit that no other branch has.
commit_in() {
  must printf '%s\n' "$2" >>"$1/file.txt"
  must gitc "$1" add -A
  must gitc "$1" commit --quiet -m "$2"
}

# advance_main <message> -> a commit on main pushed to origin, i.e. what a squash-merge of
# somebody else's branch looks like from here: origin/main moved, by a commit nobody's
# branch tip equals.
advance_main() {
  commit_in "$ROOT/main" "$1"
  must gitc "$ROOT/main" push --quiet origin main
}

# advance_origin <message> -> a commit pushed to origin from a throwaway clone: main moves
# behind this fixture's main checkout's back, so its refs/remotes/origin/main is provably
# stale until something fetches. That staleness is what makes a fetch observable at all —
# origin_head and tracking_ref below differ exactly while no fetch has happened.
advance_origin() {
  must rm -rf "$ROOT/upstream"
  must git clone --quiet "$ROOT/origin.git" "$ROOT/upstream"
  commit_in "$ROOT/upstream" "$1"
  must gitc "$ROOT/upstream" push --quiet origin main
}

# merged_after_update_branch <fixture-name> -> a fixture whose worktree $ROOT/wt is on `feat`,
# squash-merged, but where the PR branch was advanced by a real `gh pr update-branch` first.
# Sets `tip` (the local branch tip) and `merge_oid` (the update-branch merge commit). Shared by
# the reap and rebranch cases below: they assert different scripts, but if the shape of this
# fixture were wrong both would be wrong in the same way, so it is built once.
#
# The merge is made in a throwaway clone and pushed, never here. That the local object store
# has never seen the PR's head is the incident's defining feature, not incidental setup: a
# fixture that left merge_oid in this repo would go green against an is_merged that fetched and
# ran merge-base locally — the implementation production has already shown does not work.
#
# -X ours because commit_in and advance_main both append to file.txt, so the merge conflicts on
# content. gh refuses to update-branch a conflicting PR at all, so a clean resolution is the
# only shape that reaches production; the fixture is about the commit graph, not the tree.
merged_after_update_branch() {
  fixture "$1"
  add_wt feat wt
  commit_in "$ROOT/wt" work
  tip=$(git -C "$ROOT/main" rev-parse refs/heads/feat) || exit 2
  must gitc "$ROOT/main" push --quiet origin feat
  advance_main squash-of-feat

  must git clone --quiet "$ROOT/origin.git" "$ROOT/pr"
  must gitc "$ROOT/pr" switch --quiet feat
  # Not `must`: a content merge announces "Auto-merging file.txt" on stderr even under
  # --quiet, which would litter the harness's own report. Holding the output and printing it
  # only on failure is strictly more informative than must would be here.
  merge_log=$(gitc "$ROOT/pr" merge --no-ff -X ours -m update-branch origin/main 2>&1) || {
    printf 'FATAL harness setup failed: update-branch merge: %s\n' "$merge_log" >&2
    exit 2
  }
  merge_oid=$(git -C "$ROOT/pr" rev-parse HEAD) || exit 2
  must gitc "$ROOT/pr" push --quiet origin feat
  must rm -rf "$ROOT/pr"

  if git -C "$ROOT/main" merge-base --is-ancestor "$tip" refs/remotes/origin/main; then
    bad "fixture is wrong: tip is an ancestor of origin/main, so the gh path is untested"
  fi
  git -C "$ROOT/origin.git" merge-base --is-ancestor "$tip" "$merge_oid" ||
    bad "fixture is wrong: the PR head does not descend from the tip, so nothing here is merged"
  if git -C "$ROOT/main" cat-file -e "$merge_oid" 2>/dev/null; then
    bad "fixture is wrong: the update-branch merge commit is in the local store, so a local merge-base would answer here and cannot in production"
  fi
}

origin_head() { git -C "$ROOT/origin.git" rev-parse refs/heads/main; }
tracking_ref() { git -C "$ROOT/main" rev-parse refs/remotes/origin/main; }

# expect_stale_fixture — origin really is ahead of the main checkout's tracking ref, so
# "the ref did not move" means "nothing fetched" rather than "there was nothing to fetch".
expect_stale_fixture() {
  [ "$(origin_head)" != "$(tracking_ref)" ] ||
    bad "fixture is wrong: origin/main is already up to date, so a fetch would be a no-op"
}

gh_stub_prs() { # <path> <sha> — gh reporting one merged PR whose head was <sha>
  # No `commits` key, and that omission is load-bearing rather than laziness. Case 5 is the
  # only case that pins is_merged's head-equality arm AND its tolerance of a missing or null
  # commit list, independently of the containment arm gh_stub_pr_updated exercises. Hand this
  # stub a `commits` key and deleting the head-equality comparison stops being a failure
  # anything notices.
  cat >"$1" <<EOF
#!/usr/bin/env bash
printf '[{"headRefOid":"%s"}]\n' "$2"
EOF
  must chmod +x "$1"
}

gh_stub_pr_updated() { # <path> <head-oid> <tip-oid> — gh reporting one merged PR whose head is
  # <head-oid> and whose commit list contains <tip-oid>: the shape `gh pr update-branch` leaves
  # behind when it merges main into the PR branch before the squash.
  cat >"$1" <<EOF
#!/usr/bin/env bash
printf '[{"headRefOid":"%s","commits":[{"oid":"%s"},{"oid":"%s"}]}]\n' "$2" "$3" "$2"
EOF
  must chmod +x "$1"
}

gh_stub_none() { # <path> — gh reporting no merged PR for the branch
  cat >"$1" <<'EOF'
#!/usr/bin/env bash
printf '[]\n'
EOF
  must chmod +x "$1"
}

gh_stub_stdin_eater() { # <path> — gh that drains stdin before answering, as a pager or a
  # prompt-reading tool would. Whatever it swallows, its caller never sees.
  cat >"$1" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
printf '[]\n'
EOF
  must chmod +x "$1"
}

gh_stub_broken() { # <path> — gh that fails, as it does offline or unauthenticated
  cat >"$1" <<'EOF'
#!/usr/bin/env bash
echo 'gh: could not reach github.com' >&2
exit 1
EOF
  must chmod +x "$1"
}

pnpm_stub() { # <path> <logfile> — records cwd and args instead of installing
  cat >"$1" <<EOF
#!/usr/bin/env bash
printf '%s | %s\n' "\$PWD" "\$*" >>"$2"
EOF
  must chmod +x "$1"
}

run_reap() { # run_reap <gh-cmd> <min-age-minutes> <args...>
  local gh="$1" min_age="$2"
  shift 2
  capture env WORKTREE_GH_CMD="$gh" WORKTREE_MIN_AGE_MINUTES="$min_age" \
    bash "$SCRIPTS/reap-worktree.sh" "$@"
}

# run_reap_default_age <gh-cmd> <args...> — reap with the min-age guard at its shipped default.
# Every other reaping case pins the guard to 0, which means none of them can see a guard that
# never lets anything through; -u makes sure an inherited env var cannot quietly do the same.
run_reap_default_age() {
  local gh="$1"
  shift
  capture env -u WORKTREE_MIN_AGE_MINUTES WORKTREE_GH_CMD="$gh" \
    bash "$SCRIPTS/reap-worktree.sh" "$@"
}

# backdate_git_dir <worktree> — make the worktree's admin dir look untouched for years, i.e.
# what an abandoned worktree looks like to the min-age probe.
backdate_git_dir() {
  local git_dir
  git_dir=$(git -C "$1" rev-parse --absolute-git-dir) || {
    printf 'FATAL harness setup failed: no git dir for %s\n' "$1" >&2
    exit 2
  }
  must find "$git_dir" -exec touch -t 200001010000 {} +
  # Belt and braces: the walk above touches the dir itself first, and nothing after that
  # should re-stamp it, but assert the state the case depends on rather than assuming it.
  must touch -t 200001010000 "$git_dir"
}

# ==========================================================================================
# 1. every lifecycle script parses
# ==========================================================================================
begin "all four lifecycle scripts parse (bash -n)"
for script in worktree-lib.sh reap-worktree.sh rebranch-worktree.sh sweep-worktrees.sh; do
  expect_parses "$SCRIPTS/$script"
done
end

# ==========================================================================================
# 2. reap refuses a dirty worktree
# ==========================================================================================
begin "reap keeps a worktree with an untracked file"
fixture dirty
add_wt feat wt
must printf 'scratch\n' >"$ROOT/wt/notes.txt"
gh_stub_prs "$ROOT/gh" "$(git -C "$ROOT/main" rev-parse refs/heads/feat)"
run_reap "$ROOT/gh" 0 "$ROOT/wt"
expect_rc 1 "$rc"
expect_out "— dirty"
expect_exists "$ROOT/wt/notes.txt"
expect_branch "$ROOT/main" feat
end

# ==========================================================================================
# 3. reap refuses a branch GitHub has never merged
# ==========================================================================================
begin "reap keeps a worktree whose unique commit was never merged"
fixture unmerged
add_wt feat wt
commit_in "$ROOT/wt" work
gh_stub_none "$ROOT/gh"
run_reap "$ROOT/gh" 0 "$ROOT/wt"
expect_rc 1 "$rc"
expect_out "— unmerged"
expect_exists "$ROOT/wt"
expect_branch "$ROOT/main" feat
end

# ==========================================================================================
# 4. reap removes a clean, ancestor-merged worktree
# ==========================================================================================
begin "reap removes a clean worktree whose tip is an ancestor of origin/main"
fixture ancestor
add_wt feat wt
# Deliberately a failing gh stub: if the ancestry fast path ever stops firing, this case
# turns into unverifiable-merge and fails rather than passing for the wrong reason.
gh_stub_broken "$ROOT/gh"
run_reap "$ROOT/gh" 0 "$ROOT/wt"
expect_rc 0 "$rc"
expect_out "REAPED"
expect_gone "$ROOT/wt"
expect_no_branch "$ROOT/main" feat
end

# ==========================================================================================
# 5. reap removes a squash-merged worktree (tip is NOT an ancestor of main)
# ==========================================================================================
begin "reap removes a squash-merged worktree via the gh head-sha check"
fixture squash
add_wt feat wt
commit_in "$ROOT/wt" work
tip=$(git -C "$ROOT/main" rev-parse refs/heads/feat) || exit 2
advance_main squash-of-feat
if git -C "$ROOT/main" merge-base --is-ancestor "$tip" refs/remotes/origin/main; then
  bad "fixture is wrong: tip is an ancestor of origin/main, so the gh path is untested"
fi
gh_stub_prs "$ROOT/gh" "$tip"
run_reap "$ROOT/gh" 0 "$ROOT/wt"
expect_rc 0 "$rc"
expect_out "REAPED"
expect_gone "$ROOT/wt"
expect_no_branch "$ROOT/main" feat
end

# ==========================================================================================
# 6. reap refuses when the merge state cannot be established
# ==========================================================================================
begin "reap keeps a worktree when gh fails (unverifiable merge state)"
fixture unverifiable
add_wt feat wt
commit_in "$ROOT/wt" work
gh_stub_broken "$ROOT/gh"
run_reap "$ROOT/gh" 0 "$ROOT/wt"
expect_rc 1 "$rc"
expect_out "— unverifiable-merge"
expect_exists "$ROOT/wt"
expect_branch "$ROOT/main" feat
end

# ==========================================================================================
# 7. reap refuses a locked worktree
# ==========================================================================================
begin "reap keeps a locked worktree"
fixture locked
add_wt feat wt
must git -C "$ROOT/main" worktree lock "$ROOT/wt"
gh_stub_broken "$ROOT/gh"
run_reap "$ROOT/gh" 0 "$ROOT/wt"
expect_rc 1 "$rc"
expect_out "— locked"
expect_exists "$ROOT/wt"
expect_branch "$ROOT/main" feat
must git -C "$ROOT/main" worktree unlock "$ROOT/wt"
end

# ==========================================================================================
# 8. reap refuses while a process holds a cwd inside the worktree
# ==========================================================================================
begin "reap keeps a worktree with a live session inside it"
fixture live
add_wt feat wt
gh_stub_broken "$ROOT/gh"
(cd "$ROOT/wt" && exec sleep 30) &
holder=$!
bg_pids="$bg_pids $holder"
# lsof must actually be able to see the holder before the assertion means anything.
visible=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if lsof -a -d cwd -p "$holder" -Fn 2>/dev/null | grep -qx "n$ROOT/wt"; then
    visible=1
    break
  fi
  sleep 0.2
done
[ "$visible" = "1" ] || bad "harness could not observe the holder process cwd via lsof"
run_reap "$ROOT/gh" 0 "$ROOT/wt"
expect_rc 1 "$rc"
expect_out "— live-session"
expect_exists "$ROOT/wt"
kill "$holder" 2>/dev/null
wait "$holder" 2>/dev/null
end

# ==========================================================================================
# 9. reap refuses the main checkout
# ==========================================================================================
begin "reap keeps the main checkout"
fixture mainpath
gh_stub_broken "$ROOT/gh"
run_reap "$ROOT/gh" 0 "$ROOT/main"
expect_rc 1 "$rc"
expect_out "— main-checkout"
expect_exists "$ROOT/main/file.txt"
end

# ==========================================================================================
# 10. --dry-run removes nothing
# ==========================================================================================
begin "reap --dry-run reports WOULD-REAP and removes nothing"
fixture dryrun
add_wt feat wt
gh_stub_broken "$ROOT/gh"
run_reap "$ROOT/gh" 0 "$ROOT/wt" --dry-run
expect_rc 0 "$rc"
expect_out "WOULD-REAP"
expect_exists "$ROOT/wt/file.txt"
expect_branch "$ROOT/main" feat
end

# ==========================================================================================
# 11. ignored files do not block a reap
# ==========================================================================================
begin "reap removes a worktree that still has ignored files in it"
fixture ignored
add_wt feat wt
must mkdir -p "$ROOT/wt/node_modules/pkg"
must printf 'installed\n' >"$ROOT/wt/node_modules/pkg/index.js"
expect_eq "ignored file counts as clean" "$(git -C "$ROOT/wt" status --porcelain)" ""
gh_stub_broken "$ROOT/gh"
run_reap "$ROOT/gh" 0 "$ROOT/wt"
expect_rc 0 "$rc"
expect_out "REAPED"
expect_gone "$ROOT/wt"
end

# ==========================================================================================
# 12. the min-age guard keeps a fresh worktree
# ==========================================================================================
begin "reap keeps a freshly created worktree when the min-age guard is on"
fixture freshness
add_wt feat wt
gh_stub_broken "$ROOT/gh"
run_reap "$ROOT/gh" 60 "$ROOT/wt"
expect_rc 1 "$rc"
expect_out "— recently-active"
expect_exists "$ROOT/wt"
expect_branch "$ROOT/main" feat
end

# ==========================================================================================
# 13. the min-age guard lets a long-idle worktree through at the SHIPPED default
# ==========================================================================================
# The guard proving it can say no (case 12) is only half the contract; a guard that can never
# say yes makes the whole sweeper inert in production, and no case that pins
# WORKTREE_MIN_AGE_MINUTES=0 can tell the two apart. So: default min age, idle fixture, and the
# assertion is that reap gets all the way to the end.
begin "reap reaps a long-idle worktree at the default min age"
fixture backdated
add_wt feat wt
gh_stub_broken "$ROOT/gh"
backdate_git_dir "$ROOT/wt"
run_reap_default_age "$ROOT/gh" "$ROOT/wt" --dry-run
expect_rc 0 "$rc"
expect_out "WOULD-REAP"
expect_not_out "recently-active"
expect_exists "$ROOT/wt/file.txt"
expect_branch "$ROOT/main" feat
end

# ==========================================================================================
# 14. reap refuses the worktree it is running inside
# ==========================================================================================
begin "reap keeps the worktree its own cwd sits in"
fixture owncwd
add_wt feat wt
gh_stub_broken "$ROOT/gh"
capture -C "$ROOT/wt" env WORKTREE_GH_CMD="$ROOT/gh" WORKTREE_MIN_AGE_MINUTES=0 \
  bash "$SCRIPTS/reap-worktree.sh" "$ROOT/wt"
expect_rc 1 "$rc"
# The reason is the assertion, not the refusal: with the own-cwd guard gone the live-session
# check usually catches this anyway, so expecting only rc 1 would pass on a broken guard.
expect_out "— own-cwd"
expect_exists "$ROOT/wt/file.txt"
expect_branch "$ROOT/main" feat
end

# ==========================================================================================
# 15. reap refuses a detached-HEAD worktree
# ==========================================================================================
begin "reap keeps a worktree on a detached HEAD"
fixture detachedhead
add_wt feat wt
must git -C "$ROOT/wt" checkout --quiet --detach
gh_stub_broken "$ROOT/gh"
run_reap "$ROOT/gh" 0 "$ROOT/wt"
expect_rc 1 "$rc"
expect_out "— detached"
expect_exists "$ROOT/wt/file.txt"
expect_branch "$ROOT/main" feat
end

# ==========================================================================================
# 16. rebranch happy path
# ==========================================================================================
begin "rebranch moves a merged worktree onto a new branch at origin/main"
fixture rebranch
add_wt feat wt
advance_main later-work
gh_stub_broken "$ROOT/gh"
pnpm_stub "$ROOT/pnpm" "$ROOT/pnpm.log"
capture -C "$ROOT/wt" env WORKTREE_GH_CMD="$ROOT/gh" WORKTREE_PNPM_CMD="$ROOT/pnpm" \
  bash "$SCRIPTS/rebranch-worktree.sh" next
expect_rc 0 "$rc"
expect_out "REBRANCHED feat -> next at"
expect_eq "worktree HEAD" \
  "$(git -C "$ROOT/wt" rev-parse HEAD)" \
  "$(git -C "$ROOT/main" rev-parse refs/remotes/origin/main)"
expect_eq "current branch" "$(git -C "$ROOT/wt" branch --show-current)" next
expect_no_branch "$ROOT/main" feat
# --no-track is deliberate (see rebranch-worktree.sh): the new branch has no upstream.
if git -C "$ROOT/wt" rev-parse --abbrev-ref --symbolic-full-name "next@{upstream}" >/dev/null 2>&1; then
  bad "new branch should have no upstream (--no-track)"
fi
if [ -f "$ROOT/pnpm.log" ]; then
  # Through capture rather than `out=$(cat …)`: expect_out reads BOTH slots, so assigning out
  # by hand would leave $err holding the rebranch run's stderr and let this assertion pass on
  # text the package manager never wrote.
  capture cat "$ROOT/pnpm.log"
  expect_out "install --frozen-lockfile"
  expect_out "$ROOT/wt"
else
  bad "package manager was never invoked"
fi
end

# ==========================================================================================
# 17. rebranch refusals
# ==========================================================================================
begin "rebranch refuses an existing target branch and a dirty tree"
fixture refusals
add_wt feat wt
gh_stub_broken "$ROOT/gh"
pnpm_stub "$ROOT/pnpm" "$ROOT/pnpm.log"
must git -C "$ROOT/main" branch taken main

capture -C "$ROOT/wt" env WORKTREE_GH_CMD="$ROOT/gh" WORKTREE_PNPM_CMD="$ROOT/pnpm" \
  bash "$SCRIPTS/rebranch-worktree.sh" taken
expect_rc 1 "$rc"
expect_out "REFUSED"
expect_out "already exists"

must printf 'scratch\n' >"$ROOT/wt/notes.txt"
capture -C "$ROOT/wt" env WORKTREE_GH_CMD="$ROOT/gh" WORKTREE_PNPM_CMD="$ROOT/pnpm" \
  bash "$SCRIPTS/rebranch-worktree.sh" fresh
expect_rc 1 "$rc"
expect_out "REFUSED"
expect_out "uncommitted or untracked"

expect_eq "still on the old branch" "$(git -C "$ROOT/wt" branch --show-current)" feat
expect_no_branch "$ROOT/main" fresh
expect_gone "$ROOT/pnpm.log"
end

# ==========================================================================================
# 18. rebranch refuses to retire an unmerged branch
# ==========================================================================================
# rebranch ends in `git branch -D`, so this refusal is the last thing standing between an
# unmerged branch and reflog-only recovery. Case 16's happy path resolves via merged-ancestor
# and cases 17's refusals fire earlier, so without this case the whole is_merged arm of the
# most destructive script in the set is unexercised.
begin "rebranch refuses when the old branch has unmerged commits"
fixture rebranch_unmerged
add_wt feat wt
commit_in "$ROOT/wt" work
gh_stub_none "$ROOT/gh"
pnpm_stub "$ROOT/pnpm" "$ROOT/pnpm.log"
tip=$(git -C "$ROOT/wt" rev-parse HEAD) || exit 2
capture -C "$ROOT/wt" env WORKTREE_GH_CMD="$ROOT/gh" WORKTREE_PNPM_CMD="$ROOT/pnpm" \
  bash "$SCRIPTS/rebranch-worktree.sh" next
expect_rc 1 "$rc"
expect_out "REFUSED"
expect_out "feat is not merged"
expect_eq "still on the old branch" "$(git -C "$ROOT/wt" branch --show-current)" feat
expect_eq "commit still reachable from the branch" "$(git -C "$ROOT/main" rev-parse refs/heads/feat)" "$tip"
expect_no_branch "$ROOT/main" next
expect_gone "$ROOT/pnpm.log"
end

# ==========================================================================================
# 19. rebranch refuses when the merge state cannot be established
# ==========================================================================================
begin "rebranch refuses when gh cannot confirm the old branch was merged"
fixture rebranch_unverifiable
add_wt feat wt
commit_in "$ROOT/wt" work
gh_stub_broken "$ROOT/gh"
pnpm_stub "$ROOT/pnpm" "$ROOT/pnpm.log"
tip=$(git -C "$ROOT/wt" rev-parse HEAD) || exit 2
capture -C "$ROOT/wt" env WORKTREE_GH_CMD="$ROOT/gh" WORKTREE_PNPM_CMD="$ROOT/pnpm" \
  bash "$SCRIPTS/rebranch-worktree.sh" next
expect_rc 1 "$rc"
expect_out "REFUSED"
expect_out "could not verify whether feat is merged"
expect_eq "still on the old branch" "$(git -C "$ROOT/wt" branch --show-current)" feat
expect_eq "commit still reachable from the branch" "$(git -C "$ROOT/main" rev-parse refs/heads/feat)" "$tip"
expect_no_branch "$ROOT/main" next
expect_gone "$ROOT/pnpm.log"
end

# ==========================================================================================
# 20. sweep end to end over a mixed fixture
# ==========================================================================================
begin "sweep reaps only the finished worktree and warns about an off-main checkout"
fixture sweep
# 'done' is quoted everywhere it appears below because it is a branch name that collides with
# a shell keyword. Bash parses it as a plain word in argument position either way, but the
# quotes say "data, not syntax" to both readers and shellcheck (SC1010).
add_wt 'done' wt-done
add_wt messy wt-dirty
add_wt stranded wt-unmerged
must printf 'scratch\n' >"$ROOT/wt-dirty/notes.txt"
commit_in "$ROOT/wt-unmerged" work
# The main checkout is meant to sit parked on main; sweep must say so and sweep it anyway.
must git -C "$ROOT/main" switch --quiet -c parked
gh_stub_none "$ROOT/gh"
capture -C "$ROOT/main" env WORKTREE_GH_CMD="$ROOT/gh" WORKTREE_MIN_AGE_MINUTES=0 \
  bash "$SCRIPTS/sweep-worktrees.sh"
expect_rc 0 "$rc"
expect_out "WARN main checkout is on 'parked'"
expect_out "REAPED $ROOT/wt-done (done)"
expect_out "KEPT $ROOT/wt-dirty — dirty"
expect_out "KEPT $ROOT/wt-unmerged — unmerged"
expect_out "swept 1, kept 2"
expect_gone "$ROOT/wt-done"
expect_exists "$ROOT/wt-dirty/notes.txt"
expect_exists "$ROOT/wt-unmerged/file.txt"
expect_no_branch "$ROOT/main" 'done'
expect_branch "$ROOT/main" messy
expect_branch "$ROOT/main" stranded
expect_exists "$ROOT/main/file.txt"
end

# ==========================================================================================
# 21. sweep --dry-run changes nothing and does not claim to have swept anything
# ==========================================================================================
begin "sweep --dry-run leaves a vanished worktree's admin entry intact and reports would-sweep counts"
fixture sweepdry
add_wt 'done' wt-done
add_wt messy wt-dirty
add_wt gone wt-gone
must printf 'scratch\n' >"$ROOT/wt-dirty/notes.txt"
# A directory that has vanished is the only case `git worktree prune` ever fires on — reap
# removes worktrees via `worktree remove`, which cleans up its own admin dir. A dry run that
# prunes it destroys the one thing that makes the directory restorable.
must mv "$ROOT/wt-gone" "$ROOT/wt-gone-stashed"
gh_stub_broken "$ROOT/gh"
capture -C "$ROOT/main" env WORKTREE_GH_CMD="$ROOT/gh" WORKTREE_MIN_AGE_MINUTES=0 \
  bash "$SCRIPTS/sweep-worktrees.sh" --dry-run
expect_rc 0 "$rc"
expect_out "WOULD-REAP $ROOT/wt-done (done)"
expect_out "KEPT $ROOT/wt-dirty — dirty"
expect_out "WARN stale worktree admin entries"
# A safety tool must not report deletions it did not perform.
expect_out "would sweep 1, kept 2"
expect_not_out "swept 1"
expect_not_out "REAPED"
expect_exists "$ROOT/wt-done/file.txt"
expect_branch "$ROOT/main" 'done'
expect_exists "$ROOT/main/.git/worktrees/wt-gone"
must mv "$ROOT/wt-gone-stashed" "$ROOT/wt-gone"
# Restoring the directory must give back a usable worktree; a pruned entry cannot be repaired.
git -C "$ROOT/wt-gone" rev-parse --absolute-git-dir >/dev/null 2>&1 ||
  bad "restored worktree is unusable — its admin entry was pruned by a dry run"
end

# ==========================================================================================
# 22. sweep's exit-code contract: 0 swept, 1 kept, anything else failed
# ==========================================================================================
# reap owns every safety decision; sweep owns only the mapping from reap's exit codes. Filing
# an unexpected failure under "kept" would make a backstop that has stopped working look like
# a backstop with nothing to do, so this case stubs reap to produce all three outcomes
# deterministically — a real reap has no reliable way to exit 2 on demand.
begin "sweep counts an unexpected reap failure as failed, not kept"
fixture sweeprc
add_wt a wt-a
add_wt b wt-b
add_wt c wt-c
must mkdir -p "$ROOT/scripts"
must cp "$SCRIPTS/sweep-worktrees.sh" "$SCRIPTS/worktree-lib.sh" "$ROOT/scripts/"
cat >"$ROOT/scripts/reap-worktree.sh" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  *wt-a) printf 'REAPED %s (a)\n' "$1" ;;
  *wt-b)
    printf 'KEPT %s — stub\n' "$1"
    exit 1
    ;;
  *)
    echo "stub reap failed unexpectedly" >&2
    exit 2
    ;;
esac
EOF
must chmod +x "$ROOT/scripts/reap-worktree.sh"
capture -C "$ROOT/main" bash "$ROOT/scripts/sweep-worktrees.sh"
expect_rc 2 "$rc"
expect_out "ERROR reap-worktree.sh exited 2 for $ROOT/wt-c"
expect_out "swept 1, kept 1, failed 1"
end

# ==========================================================================================
# 23. a stdin-reading child cannot eat the worktree list out from under the sweep
# ==========================================================================================
# The loop reads its candidates from the sweep's own stdin, so before `< /dev/null` the first
# child inherited the rest of the list. reap runs a caller-supplied $WORKTREE_GH_CMD, which is
# where a stdin reader realistically comes from. The damage is silent rather than destructive:
# skipped worktrees are kept, and the summary line looks healthy either way — which is why the
# assertion is the per-worktree lines AND the count.
begin "sweep gives each reap its own stdin, so a stdin-reading child cannot eat the worktree list"
fixture sweepstdin
add_wt a wt-a
add_wt b wt-b
add_wt c wt-c
# Unmerged commits are what make reap consult gh at all: an ancestor-merged branch never
# reaches the stub, so the fixture has to give every candidate a reason to ask.
commit_in "$ROOT/wt-a" work-a
commit_in "$ROOT/wt-b" work-b
commit_in "$ROOT/wt-c" work-c
gh_stub_stdin_eater "$ROOT/gh"
capture -C "$ROOT/main" env WORKTREE_GH_CMD="$ROOT/gh" WORKTREE_MIN_AGE_MINUTES=0 \
  bash "$SCRIPTS/sweep-worktrees.sh"
expect_rc 0 "$rc"
expect_out "KEPT $ROOT/wt-a — unmerged"
expect_out "KEPT $ROOT/wt-b — unmerged"
expect_out "KEPT $ROOT/wt-c — unmerged"
expect_out "swept 0, kept 3"
end

# ==========================================================================================
# 24. the min-age probe measures the target's admin dir, not the enclosing repo's
# ==========================================================================================
# Cumulo nests worktrees inside the main checkout, so a worktree that has lost its .git file
# answers every "which repo are you?" question with the MAIN checkout — and reap used to ask
# exactly that question, via `rev-parse --absolute-git-dir` run inside the target. The fixture
# makes the two answers disagree: the worktree's own admin dir has been idle for years while
# the main checkout was touched a moment ago.
begin "reap's min-age probe reads the worktree's own admin dir, not the enclosing repo's"
fixture adminnested
# Mirrors the real layout: .gitignore carries .claude/worktrees/ so nested worktrees are
# invisible to the main checkout's status.
must printf 'wt/\n' >>"$ROOT/main/.gitignore"
must gitc "$ROOT/main" add -A
must gitc "$ROOT/main" commit --quiet -m ignore-nested-worktrees
must gitc "$ROOT/main" push --quiet origin main
add_wt feat main/wt
commit_in "$ROOT/main/wt" work
backdate_git_dir "$ROOT/main/wt"
must rm "$ROOT/main/wt/.git"
must touch "$ROOT/main/.git/index" "$ROOT/main/.git"
gh_stub_none "$ROOT/gh"
# Guard ON: this case is about which directory the guard looks at, so pinning it to 0 would
# test nothing.
run_reap "$ROOT/gh" 60 "$ROOT/main/wt"
expect_rc 1 "$rc"
# The refusal must come from the merge state — the truthful answer for this branch — and not
# from a min-age probe that measured the main checkout and mistook it for this worktree.
expect_out "— unmerged"
expect_not_out "recently-active"
expect_exists "$ROOT/main/wt/file.txt"
expect_branch "$ROOT/main" feat
end

# ==========================================================================================
# 25. --dry-run writes nothing, including remote-tracking refs
# ==========================================================================================
# is_merged used to fetch on every call, so a dry sweep updated origin/main (and pulled
# objects) for each candidate it inspected. Nothing was destroyed, but a dry run that mutates
# the repository is not the promise the flag makes.
begin "sweep --dry-run fetches nothing, leaving origin/main exactly where it was"
fixture sweepdryfetch
add_wt feat wt
advance_origin upstream-work
expect_stale_fixture
stale=$(tracking_ref) || exit 2
gh_stub_none "$ROOT/gh"
capture -C "$ROOT/main" env WORKTREE_GH_CMD="$ROOT/gh" WORKTREE_MIN_AGE_MINUTES=0 \
  bash "$SCRIPTS/sweep-worktrees.sh" --dry-run
expect_rc 0 "$rc"
expect_out "WOULD-REAP"
expect_eq "origin/main after a dry sweep" "$(tracking_ref)" "$stale"
end

# ==========================================================================================
# 26. a real sweep refreshes the base ref once, for the whole run
# ==========================================================================================
# Hoisting the fetch is only correct if the sweep still does it and the children stop doing it,
# so the stub reap here reports the signal it was handed and cannot fetch anything itself: any
# movement of origin/main during this run therefore came from the sweep's single fetch. Case 27
# is the other half — that a reap handed that signal really does skip its fetch.
begin "a non-dry sweep refreshes origin/main itself and tells its children not to fetch again"
fixture sweepfetchonce
add_wt a wt-a
add_wt b wt-b
advance_origin upstream-work
expect_stale_fixture
ahead=$(origin_head) || exit 2
must mkdir -p "$ROOT/scripts"
must cp "$SCRIPTS/sweep-worktrees.sh" "$SCRIPTS/worktree-lib.sh" "$ROOT/scripts/"
cat >"$ROOT/scripts/reap-worktree.sh" <<'EOF'
#!/usr/bin/env bash
printf 'KEPT %s — stub (fetch-knob=%s)\n' "$1" "${WORKTREE_FETCH_MAIN-unset}"
exit 1
EOF
must chmod +x "$ROOT/scripts/reap-worktree.sh"
capture -C "$ROOT/main" bash "$ROOT/scripts/sweep-worktrees.sh"
expect_rc 0 "$rc"
expect_out "fetch-knob=0"
expect_not_out "fetch-knob=unset"
expect_out "swept 0, kept 2"
expect_eq "origin/main after a real sweep" "$(tracking_ref)" "$ahead"
end

# ==========================================================================================
# 27. reap fetches for itself, unless its caller says it already did
# ==========================================================================================
# Negative control on the signal case 26 asserts the sweep sends: run the real reap both ways
# over the same stale fixture. If the knob were dead, both halves would leave the same ref.
begin "reap refreshes origin/main by default and skips it when the caller already has"
fixture reapfetch
add_wt a wt-a
add_wt b wt-b
advance_origin upstream-work
expect_stale_fixture
stale=$(tracking_ref) || exit 2
ahead=$(origin_head) || exit 2
# A gh that fails keeps the case honest: both halves must resolve via ancestry, so neither can
# pass by accidentally consulting GitHub.
gh_stub_broken "$ROOT/gh"

capture env WORKTREE_GH_CMD="$ROOT/gh" WORKTREE_MIN_AGE_MINUTES=0 WORKTREE_FETCH_MAIN=0 \
  bash "$SCRIPTS/reap-worktree.sh" "$ROOT/wt-a"
expect_rc 0 "$rc"
expect_out "REAPED"
expect_eq "origin/main with WORKTREE_FETCH_MAIN=0" "$(tracking_ref)" "$stale"

run_reap "$ROOT/gh" 0 "$ROOT/wt-b"
expect_rc 0 "$rc"
expect_out "REAPED"
expect_eq "origin/main with the knob at its default" "$(tracking_ref)" "$ahead"
end

# ==========================================================================================
# 28. a direct reap --dry-run writes nothing either
# ==========================================================================================
# The fetch guard has two halves — the dry-run mode and the parent's no-fetch signal — and
# case 27 only exercises the signal. `reap-worktree.sh <path> --dry-run` run by hand is a
# documented entry point with no sweep above it to carry the signal, so without this case the
# whole `dry_run` half could be deleted and the suite would not notice.
begin "reap --dry-run fetches nothing even with no parent telling it not to"
fixture reapdryfetch
add_wt feat wt
advance_origin upstream-work
expect_stale_fixture
stale=$(tracking_ref) || exit 2
# gh must never be reached: the fixture resolves via ancestry against the stale ref, so a
# failing stub turns any detour through GitHub into a visible failure rather than a pass.
gh_stub_broken "$ROOT/gh"
# -u, not merely "we did not set it": an inherited WORKTREE_FETCH_MAIN=0 would make this case
# pass by testing case 27's half of the guard all over again.
capture env -u WORKTREE_FETCH_MAIN WORKTREE_GH_CMD="$ROOT/gh" WORKTREE_MIN_AGE_MINUTES=0 \
  bash "$SCRIPTS/reap-worktree.sh" "$ROOT/wt" --dry-run
expect_rc 0 "$rc"
expect_out "WOULD-REAP"
expect_eq "origin/main after a dry reap" "$(tracking_ref)" "$stale"
expect_exists "$ROOT/wt/file.txt"
expect_branch "$ROOT/main" feat
end

# ==========================================================================================
# 29. reap accepts a merged PR that CONTAINS the tip, not only one whose head equals it
# ==========================================================================================
# The whole of #204. `gh pr update-branch` before a squash replaces the PR's head with a merge
# commit this repository has never held, so head-equality called genuinely merged branches
# unmerged and every lifecycle script refused (PRs #203/#205/#207, plus stuck agent-*
# worktrees). Containment reaches the same verdict from the commit list gh already returns,
# without fetching a single object.
begin "reap removes a worktree merged after a real update-branch (headRefOid descends from the tip)"
merged_after_update_branch updatebranch
gh_stub_pr_updated "$ROOT/gh" "$merge_oid" "$tip"
run_reap "$ROOT/gh" 0 "$ROOT/wt"
expect_rc 0 "$rc"
expect_out "REAPED"
expect_gone "$ROOT/wt"
expect_no_branch "$ROOT/main" feat
end

# ==========================================================================================
# 30. rebranch, too — the issue's "no manual ref surgery" acceptance
# ==========================================================================================
# Same defect, the other entry point: rebranch ends in `git branch -D`, so it consults
# is_merged on its own and refused the same worktrees. Reaping alone would leave the recycle
# path broken.
begin "rebranch recycles a worktree merged after a real update-branch"
merged_after_update_branch updatebranch_rb
gh_stub_pr_updated "$ROOT/gh" "$merge_oid" "$tip"
pnpm_stub "$ROOT/pnpm" "$ROOT/pnpm.log"
capture -C "$ROOT/wt" env WORKTREE_GH_CMD="$ROOT/gh" WORKTREE_PNPM_CMD="$ROOT/pnpm" \
  bash "$SCRIPTS/rebranch-worktree.sh" next
expect_rc 0 "$rc"
expect_out "REBRANCHED feat -> next at"
expect_eq "worktree HEAD" \
  "$(git -C "$ROOT/wt" rev-parse HEAD)" \
  "$(git -C "$ROOT/main" rev-parse refs/remotes/origin/main)"
expect_no_branch "$ROOT/main" feat
end

# ==========================================================================================
# 31. containment is membership, not "there was a merged PR"
# ==========================================================================================
# The widening this fix could have shipped instead: accepting any merged PR that carries any
# commits at all. The branch here holds one commit the merged PR contained and one it never
# did, so reaping it would strand work — which is the exact harm is_merged exists to prevent,
# and the only case in the suite that can see the difference.
begin "reap keeps a branch holding a commit the merged PR never contained"
fixture strandedpr
add_wt feat wt
commit_in "$ROOT/wt" work
c1=$(git -C "$ROOT/wt" rev-parse HEAD) || exit 2
commit_in "$ROOT/wt" stranded
gh_stub_pr_updated "$ROOT/gh" "$c1" "$c1"
run_reap "$ROOT/gh" 0 "$ROOT/wt"
expect_rc 1 "$rc"
expect_out "— unmerged"
expect_exists "$ROOT/wt/file.txt"
expect_branch "$ROOT/main" feat
end

# ==========================================================================================
# 32. sweep runs its sibling through bash, so the exec bit is not load-bearing
# ==========================================================================================
# `git show <rev>:…` writes mode 644, which is how these scripts arrive whenever they are
# extracted rather than checked out — this harness's own negative-control recipe, a bisect, a
# review of an older revision. A sweep that EXECUTES its sibling turns that into "swept 0,
# kept 0, failed N": every candidate reported as an unexpected failure, and nothing swept.
# The fixture pins mode 644 explicitly rather than inheriting whatever cp handed it, and both
# invocation sites are exercised, so reverting either `bash ` prefix alone reds this case.
begin "sweep runs reap through bash, so 644 extracted copies still sweep"
fixture sweep644
add_wt feat wt
must mkdir -p "$ROOT/scripts644"
must cp "$SCRIPTS/sweep-worktrees.sh" "$SCRIPTS/reap-worktree.sh" "$SCRIPTS/worktree-lib.sh" \
  "$ROOT/scripts644/"
# cp preserves the source's 755, so the mode this case is about has to be set, not assumed.
must chmod 644 "$ROOT/scripts644"/*.sh
# The branch is an unmoved cut of main, so ancestry alone settles it and a failing gh keeps the
# case from passing by way of GitHub.
gh_stub_broken "$ROOT/gh"

capture -C "$ROOT/main" env WORKTREE_GH_CMD="$ROOT/gh" WORKTREE_MIN_AGE_MINUTES=0 \
  bash "$ROOT/scripts644/sweep-worktrees.sh" --dry-run
expect_rc 0 "$rc"
expect_out "WOULD-REAP"
expect_not_out "ERROR"
expect_exists "$ROOT/wt/file.txt"

capture -C "$ROOT/main" env WORKTREE_GH_CMD="$ROOT/gh" WORKTREE_MIN_AGE_MINUTES=0 \
  bash "$ROOT/scripts644/sweep-worktrees.sh"
expect_rc 0 "$rc"
expect_out "REAPED $ROOT/wt (feat)"
expect_out "swept 1, kept 0"
expect_not_out "ERROR"
end

# ==========================================================================================

finish
