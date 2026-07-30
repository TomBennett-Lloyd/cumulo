#!/usr/bin/env bash
# Test harness for the worktree lifecycle scripts (reap / rebranch / sweep).
#
# Self-contained on purpose: no test framework, no network, no gh, no pnpm. Every fixture is
# a throwaway repo under a single `mktemp -d` that a trap deletes on exit, so the harness can
# exercise the destructive paths (real `worktree remove`, real `branch -D`) without ever
# being able to touch the repository it ships in.
#
# Usage: bash .claude/scripts/worktree-lifecycle.test.sh   (or `pnpm test:scripts`)
# Exit:  0 every case PASS, 1 at least one FAIL, 2 the harness itself broke.
set -u
export PATH="/opt/homebrew/bin:$PATH"

SCRIPTS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2

tmp_raw=$(mktemp -d) || exit 2
bg_pids=""
cleanup() {
  for pid in $bg_pids; do
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
  done
  rm -rf "$tmp_raw"
}
trap cleanup EXIT INT TERM
# Canonical from the start: macOS hides temp dirs behind /var -> /private/var, and the
# scripts under test report realpaths, so fixtures must be built from realpaths too.
TMP_ROOT=$(cd "$tmp_raw" && pwd -P) || exit 2

passed=0
failed=0
case_name=""
case_failed=0
out=""
rc=0

# --- harness plumbing --------------------------------------------------------------------

must() {
  "$@" || {
    printf 'FATAL harness setup failed: %s\n' "$*" >&2
    exit 2
  }
}

begin() {
  case_name="$1"
  case_failed=0
}

end() {
  if [ "$case_failed" = "0" ]; then
    printf 'PASS %s\n' "$case_name"
    passed=$((passed + 1))
  else
    printf 'FAIL %s\n' "$case_name"
    failed=$((failed + 1))
  fi
}

bad() {
  printf '  ! %s\n' "$1" >&2
  case_failed=1
}

expect_rc() { # expect_rc <expected> <actual>
  [ "$1" = "$2" ] || bad "exit code: expected $1, got $2"
}

expect_out() { # expect_out <substring>
  case "$out" in
    *"$1"*) ;;
    *) bad "output missing '$1'; got: $out" ;;
  esac
}

expect_not_out() { # expect_not_out <substring>
  case "$out" in
    *"$1"*) bad "output should not contain '$1'; got: $out" ;;
  esac
}

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

gh_stub_prs() { # <path> <sha> — gh reporting one merged PR whose head was <sha>
  cat >"$1" <<EOF
#!/usr/bin/env bash
printf '[{"headRefOid":"%s"}]\n' "$2"
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
  out=$(env WORKTREE_GH_CMD="$gh" WORKTREE_MIN_AGE_MINUTES="$min_age" \
    bash "$SCRIPTS/reap-worktree.sh" "$@" 2>&1)
  rc=$?
}

# run_reap_default_age <gh-cmd> <args...> — reap with the min-age guard at its shipped default.
# Every other reaping case pins the guard to 0, which means none of them can see a guard that
# never lets anything through; -u makes sure an inherited env var cannot quietly do the same.
run_reap_default_age() {
  local gh="$1"
  shift
  out=$(env -u WORKTREE_MIN_AGE_MINUTES WORKTREE_GH_CMD="$gh" \
    bash "$SCRIPTS/reap-worktree.sh" "$@" 2>&1)
  rc=$?
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
  if ! syntax=$(bash -n "$SCRIPTS/$script" 2>&1); then
    bad "$script failed bash -n: $syntax"
  fi
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
out=$(cd "$ROOT/wt" && env WORKTREE_GH_CMD="$ROOT/gh" WORKTREE_MIN_AGE_MINUTES=0 \
  bash "$SCRIPTS/reap-worktree.sh" "$ROOT/wt" 2>&1)
rc=$?
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
out=$(cd "$ROOT/wt" && env WORKTREE_GH_CMD="$ROOT/gh" WORKTREE_PNPM_CMD="$ROOT/pnpm" \
  bash "$SCRIPTS/rebranch-worktree.sh" next 2>&1)
rc=$?
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
  out=$(cat "$ROOT/pnpm.log")
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

out=$(cd "$ROOT/wt" && env WORKTREE_GH_CMD="$ROOT/gh" WORKTREE_PNPM_CMD="$ROOT/pnpm" \
  bash "$SCRIPTS/rebranch-worktree.sh" taken 2>&1)
rc=$?
expect_rc 1 "$rc"
expect_out "REFUSED"
expect_out "already exists"

must printf 'scratch\n' >"$ROOT/wt/notes.txt"
out=$(cd "$ROOT/wt" && env WORKTREE_GH_CMD="$ROOT/gh" WORKTREE_PNPM_CMD="$ROOT/pnpm" \
  bash "$SCRIPTS/rebranch-worktree.sh" fresh 2>&1)
rc=$?
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
out=$(cd "$ROOT/wt" && env WORKTREE_GH_CMD="$ROOT/gh" WORKTREE_PNPM_CMD="$ROOT/pnpm" \
  bash "$SCRIPTS/rebranch-worktree.sh" next 2>&1)
rc=$?
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
out=$(cd "$ROOT/wt" && env WORKTREE_GH_CMD="$ROOT/gh" WORKTREE_PNPM_CMD="$ROOT/pnpm" \
  bash "$SCRIPTS/rebranch-worktree.sh" next 2>&1)
rc=$?
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
add_wt done wt-done
add_wt messy wt-dirty
add_wt stranded wt-unmerged
must printf 'scratch\n' >"$ROOT/wt-dirty/notes.txt"
commit_in "$ROOT/wt-unmerged" work
# The main checkout is meant to sit parked on main; sweep must say so and sweep it anyway.
must git -C "$ROOT/main" switch --quiet -c parked
gh_stub_none "$ROOT/gh"
out=$(cd "$ROOT/main" && env WORKTREE_GH_CMD="$ROOT/gh" WORKTREE_MIN_AGE_MINUTES=0 \
  bash "$SCRIPTS/sweep-worktrees.sh" 2>&1)
rc=$?
expect_rc 0 "$rc"
expect_out "WARN main checkout is on 'parked'"
expect_out "REAPED $ROOT/wt-done (done)"
expect_out "KEPT $ROOT/wt-dirty — dirty"
expect_out "KEPT $ROOT/wt-unmerged — unmerged"
expect_out "swept 1, kept 2"
expect_gone "$ROOT/wt-done"
expect_exists "$ROOT/wt-dirty/notes.txt"
expect_exists "$ROOT/wt-unmerged/file.txt"
expect_no_branch "$ROOT/main" done
expect_branch "$ROOT/main" messy
expect_branch "$ROOT/main" stranded
expect_exists "$ROOT/main/file.txt"
end

# ==========================================================================================
# 21. sweep --dry-run changes nothing and does not claim to have swept anything
# ==========================================================================================
begin "sweep --dry-run leaves a vanished worktree's admin entry intact and reports would-sweep counts"
fixture sweepdry
add_wt done wt-done
add_wt messy wt-dirty
add_wt gone wt-gone
must printf 'scratch\n' >"$ROOT/wt-dirty/notes.txt"
# A directory that has vanished is the only case `git worktree prune` ever fires on — reap
# removes worktrees via `worktree remove`, which cleans up its own admin dir. A dry run that
# prunes it destroys the one thing that makes the directory restorable.
must mv "$ROOT/wt-gone" "$ROOT/wt-gone-stashed"
gh_stub_broken "$ROOT/gh"
out=$(cd "$ROOT/main" && env WORKTREE_GH_CMD="$ROOT/gh" WORKTREE_MIN_AGE_MINUTES=0 \
  bash "$SCRIPTS/sweep-worktrees.sh" --dry-run 2>&1)
rc=$?
expect_rc 0 "$rc"
expect_out "WOULD-REAP $ROOT/wt-done (done)"
expect_out "KEPT $ROOT/wt-dirty — dirty"
expect_out "WARN stale worktree admin entries"
# A safety tool must not report deletions it did not perform.
expect_out "would sweep 1, kept 2"
expect_not_out "swept 1"
expect_not_out "REAPED"
expect_exists "$ROOT/wt-done/file.txt"
expect_branch "$ROOT/main" done
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
out=$(cd "$ROOT/main" && bash "$ROOT/scripts/sweep-worktrees.sh" 2>&1)
rc=$?
expect_rc 2 "$rc"
expect_out "ERROR reap-worktree.sh exited 2 for $ROOT/wt-c"
expect_out "swept 1, kept 1, failed 1"
end

# ==========================================================================================

printf '\n%d passed, %d failed\n' "$passed" "$failed"
[ "$failed" = "0" ] || exit 1
