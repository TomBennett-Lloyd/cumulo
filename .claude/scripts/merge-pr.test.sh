#!/usr/bin/env bash
# Test harness for merge-pr.sh, its neighbour in this directory.
#
# The assertion vocabulary is harness-lib.sh next door. The subject's entire input
# is what GitHub says about a PR, so `gh` is stubbed — the WORKTREE_GH_CMD seam in
# worktree-lib.sh is the precedent, and MERGE_PR_GH_CMD is the same idea. The stub
# is a state directory rather than a fixed answer: `pr view` serves a SEQUENCE
# (view.1, view.2, … falling back to view.default), and once `pr merge` has been
# called it serves view.merged instead. That is what makes ordering assertable —
# "the label came off after the merge" is a claim about two calls, not about one.
#
# Everything the stub is asked is appended to calls.log, so a case can assert both
# what was called and what was NOT. The negative assertions are the load-bearing
# half here: a refusal that still merged would pass every positive assertion.
#
# What the fixtures do NOT stub is git. The repository the subject is pointed at is
# a real one, because the worktree step reads `git worktree list --porcelain` and a
# stub for that is a stub for the thing under test. reap-worktree.sh IS stubbed —
# it has its own harness (worktree-lifecycle.test.sh) and re-testing its guards
# here would assert the same thing twice; what these cases assert is the
# DELEGATION, and the one decision merge-pr.sh makes before it: never the caller's
# own working directory.
#
# The bias every case is written against: this script can only be wrong in one
# direction. Refusing a merge that should have happened costs a re-run. Merging one
# that should have been refused — on a red check, on an unfilled verdict, on a
# BEHIND head — is a defect nobody can take back, which is why every refusal case
# asserts the absence of `pr merge` in calls.log rather than only the exit code.
#
# Usage: bash .claude/scripts/merge-pr.test.sh  (or `pnpm test:scripts`)
# Exit:  0 every case PASS, 1 at least one FAIL, 2 the harness itself broke.
set -uo pipefail

SCRIPTS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2
SUBJECT="$SCRIPTS/merge-pr.sh"

# shellcheck source=./harness-lib.sh
. "$SCRIPTS/harness-lib.sh"
harness_init_tmp

PR=490
HEAD_REF=490-lane
HUMAN_ALWAYS_DEFAULT='["docs/adr/**",".claude/workflow.json","CLAUDE.md"]'

ROOT=""
STATE=""
REPO=""

# Identity is passed per-command: the harness must not depend on (or write) any git config.
gitc() {
  local dir="$1"
  shift
  git -C "$dir" -c user.email=test@test -c user.name=test -c commit.gpgsign=false "$@"
}

# --- the JSON a `gh pr view --json` answer is made of ---------------------------------------
#
# Held in V_* globals rather than passed as eight positional arguments: a case that
# changes one field should say which one, and `V_CHECKS="ci:COMPLETED:FAILURE"` is
# the whole of what a red-check case differs by.

V_STATE=""
V_MSST=""
V_OID=""
V_LABELS=""
V_FILES=""
V_CHECKS=""
V_COMMITS=""
V_BODY=""

reset_view() {
  V_STATE="OPEN"
  V_MSST="CLEAN"
  V_OID="aaa111"
  V_LABELS=""
  V_FILES="docs/notes.md"
  V_CHECKS="checks:COMPLETED:SUCCESS,gitleaks:COMPLETED:SUCCESS"
  V_COMMITS="#12: the change"
  V_BODY="What and why. Closes #12"
}

# json_objects <key> <comma-separated values> -> [{"<key>":"v"},…]
# A here-doc-fed read loop rather than IFS word splitting: the values carry spaces
# (commit subjects do), and splitting on whitespace would silently shard them.
json_objects() {
  local key="$1" first=1 v
  printf '['
  while IFS= read -r v; do
    [ -n "$v" ] || continue
    [ "$first" = "1" ] || printf ','
    printf '{"%s":"%s"}' "$key" "$v"
    first=0
  done <<EOF
$(printf '%s' "$2" | tr ',' '\n')
EOF
  printf ']'
}

# json_checks <comma-separated name:status:conclusion> -> the statusCheckRollup array.
# An empty conclusion is spelled by leaving the third field empty ("web-e2e:IN_PROGRESS:"),
# which is exactly how GitHub answers for a check that has not finished.
json_checks() {
  local first=1 spec name rest status conclusion
  printf '['
  while IFS= read -r spec; do
    [ -n "$spec" ] || continue
    name=${spec%%:*}
    rest=${spec#*:}
    status=${rest%%:*}
    conclusion=${rest#*:}
    [ "$first" = "1" ] || printf ','
    printf '{"__typename":"CheckRun","name":"%s","status":"%s","conclusion":"%s"}' \
      "$name" "$status" "$conclusion"
    first=0
  done <<EOF
$(printf '%s' "$1" | tr ',' '\n')
EOF
  printf ']'
}

pr_json() {
  printf '{"number":%s,"state":"%s","url":"https://example.test/pull/%s",' "$PR" "$V_STATE" "$PR"
  printf '"headRefName":"%s","headRefOid":"%s","mergeStateStatus":"%s","body":"%s",' \
    "$HEAD_REF" "$V_OID" "$V_MSST" "$V_BODY"
  printf '"labels":'
  json_objects name "$V_LABELS"
  printf ',"files":'
  json_objects path "$V_FILES"
  printf ',"commits":'
  json_objects messageHeadline "$V_COMMITS"
  printf ',"statusCheckRollup":'
  json_checks "$V_CHECKS"
  printf '}\n'
}

write_view() { # write_view <slot: default|1|2|…|merged>
  pr_json >"$STATE/view.$1"
}

# write_merged_view — the answer the stub serves once `pr merge` has been called.
# MERGED PRs really do report mergeStateStatus UNKNOWN (verified against PR #489),
# so the fixture says so: a subject that read that field after the merge would be
# reading a value that means nothing, and this is what makes that a red case.
write_merged_view() {
  local keep_state="$V_STATE" keep_msst="$V_MSST"
  V_STATE="MERGED"
  V_MSST="UNKNOWN"
  write_view merged
  V_STATE="$keep_state"
  V_MSST="$keep_msst"
}

# --- stubs ------------------------------------------------------------------------------------

gh_stub() { # gh_stub <path> <state dir>
  cat >"$1" <<EOF
#!/usr/bin/env bash
state="$2"
printf '%s\n' "\$*" >>"\$state/calls.log"
case "\$1 \$2" in
  "pr view")
    if [ -f "\$state/merged" ] && [ -f "\$state/view.merged" ]; then
      cat "\$state/view.merged"
      exit 0
    fi
    n=0
    [ -f "\$state/view.count" ] && read -r n <"\$state/view.count"
    n=\$((n + 1))
    printf '%s' "\$n" >"\$state/view.count"
    if [ -f "\$state/view.\$n" ]; then
      cat "\$state/view.\$n"
    else
      cat "\$state/view.default"
    fi
    rc=0
    [ -f "\$state/view.\$n.rc" ] && read -r rc <"\$state/view.\$n.rc"
    exit "\$rc"
    ;;
  "pr diff")
    [ -f "\$state/diff" ] && cat "\$state/diff"
    exit 0
    ;;
  "pr update-branch")
    [ -f "\$state/update-branch.out" ] && cat "\$state/update-branch.out"
    rc=0
    [ -f "\$state/update-branch.rc" ] && read -r rc <"\$state/update-branch.rc"
    exit "\$rc"
    ;;
  "pr merge")
    : >"\$state/merged"
    exit 0
    ;;
  "pr edit")
    : >"\$state/label-edited"
    exit 0
    ;;
  "issue view")
    if [ -f "\$state/issue.\$3" ]; then
      cat "\$state/issue.\$3"
    else
      printf '{"number":%s,"state":"CLOSED"}\n' "\$3"
    fi
    exit 0
    ;;
esac
printf 'gh stub: unexpected call: %s\n' "\$*" >&2
exit 1
EOF
  must chmod +x "$1"
}

reap_stub() { # reap_stub <path> <state dir>
  cat >"$1" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"$2/reap.log"
printf 'REAPED %s (stub)\n' "\$1"
EOF
  must chmod +x "$1"
}

# --- fixtures ---------------------------------------------------------------------------------

fixture() { # fixture <name> [humanAlways JSON array]
  ROOT="$TMP_ROOT/$1"
  STATE="$ROOT/state"
  REPO="$ROOT/repo"
  must mkdir -p "$STATE" "$REPO/.claude"
  must git init --quiet -b main "$REPO"
  must printf '{"merge":{"humanAlways":%s}}\n' "${2:-$HUMAN_ALWAYS_DEFAULT}" >"$REPO/.claude/workflow.json"
  must gitc "$REPO" add -A
  must gitc "$REPO" commit --quiet -m base
  gh_stub "$ROOT/gh" "$STATE"
  reap_stub "$ROOT/reap" "$STATE"
  : >"$STATE/calls.log"
  reset_view
}

reset_calls() { # a second run of the subject against the same state, from the top
  : >"$STATE/calls.log"
  must rm -f "$STATE/view.count"
}

POLL_TIMEOUT=30

run_merge() { # run_merge [caller's working directory]
  capture -C "${1:-$REPO}" env \
    MERGE_PR_GH_CMD="$ROOT/gh" \
    MERGE_PR_REAP_CMD="$ROOT/reap" \
    MERGE_PR_POLL_INTERVAL_SECONDS=0 \
    MERGE_PR_POLL_TIMEOUT_SECONDS="$POLL_TIMEOUT" \
    MERGE_PR_RETRY_SECONDS=0 \
    MERGE_PR_UPDATE_RETRIES=3 \
    MERGE_PR_CONFIRM_RETRIES=2 \
    bash "$SUBJECT" "$PR" "$REPO"
}

called() { # called <exact calls.log line>
  grep -qxF -- "$1" "$STATE/calls.log"
}

expect_called() {
  called "$1" || bad "gh was never called as: $1 (log: $(tr '\n' '|' <"$STATE/calls.log"))"
}

expect_not_called() {
  ! called "$1" || bad "gh should not have been called as: $1"
}

call_line() { # call_line <prefix> -> 1-based line number of the first matching call, or 0
  local n
  n=$(grep -n -- "^$1" "$STATE/calls.log" | head -1 | cut -d: -f1)
  printf '%s\n' "${n:-0}"
}

# ==========================================================================================
# 1. the script parses
# ==========================================================================================
begin "merge-pr.sh parses (bash -n)"
expect_parses "$SUBJECT"
end

# ==========================================================================================
# 2. a single-issue PR squashes, and the whole chain reports one line per step
# ==========================================================================================
begin "a single-issue PR merges --squash and every step reports"
fixture single
write_view default
write_merged_view
run_merge
expect_rc 0
expect_stdout 'single issue #12 -> squash'
expect_stdout 'AUTO'
expect_stdout 'not owed (no humanAlways path in the diff)'
expect_stdout 'updated onto the base (attempt 1)'
expect_stdout '2 check(s) complete'
expect_stdout 'merged squash (rc=0), state MERGED'
expect_stdout 'closed by the merge: #12'
expect_stdout "none holds '$HEAD_REF'"
expect_stdout "done — PR #$PR MERGED"
expect_called "pr merge $PR --squash"
expect_not_called "pr merge $PR --rebase"
end

# ==========================================================================================
# 3. the label comes off AFTER the merge, never before
# ==========================================================================================
# The defect this is written against is PR #469, where the hand-typed chain took
# the label off on CI-green. Asserting the message is not enough — the message
# could be printed in the wrong order and still read correctly — so the assertion
# is on the two calls' positions in the log.
begin "'awaiting-review' is removed only after the PR reports MERGED"
fixture label-order
V_LABELS="awaiting-review"
V_FILES="CLAUDE.md,docs/notes.md"
cat >"$STATE/diff" <<'EOF'
diff --git a/docs/review-feedback.md b/docs/review-feedback.md
--- a/docs/review-feedback.md
+++ b/docs/review-feedback.md
@@ -1,0 +2,4 @@
+## 2026-09-11 — PR #490 — merge-ritual-script
+
+- **Category**: approved-no-changes
+- **Verdict**: Approved without changes — owner, in chat.
EOF
write_view default
write_merged_view
run_merge
expect_rc 0
expect_stdout 'HUMAN (humanAlways: CLAUDE.md)'
expect_stdout 'entry on the branch, both placeholders filled'
expect_stdout "'awaiting-review' removed, after the merge"
expect_called "pr edit $PR --remove-label awaiting-review"
merge_at=$(call_line "pr merge $PR")
edit_at=$(call_line "pr edit $PR")
[ "$merge_at" -gt 0 ] || bad "the PR never merged"
[ "$edit_at" -gt 0 ] || bad "the label was never removed"
[ "$merge_at" -lt "$edit_at" ] ||
  bad "the label came off at call $edit_at, the merge at call $merge_at — the label must come off after"
end

# ==========================================================================================
# 4. a humanAlways PR whose verdict is still a placeholder is REFUSED
# ==========================================================================================
begin "a humanAlways PR with a 'pending — filled at merge' placeholder is refused"
fixture placeholder
V_FILES="docs/adr/0007-thing.md,docs/notes.md"
cat >"$STATE/diff" <<'EOF'
diff --git a/docs/review-feedback.md b/docs/review-feedback.md
--- a/docs/review-feedback.md
+++ b/docs/review-feedback.md
@@ -1,0 +2,4 @@
+## 2026-09-11 — issue #490 — merge-ritual-script
+
+- **Category**: pending — filled at merge
+- **Verdict**: pending — filled at merge
EOF
write_view default
write_merged_view
run_merge
expect_rc 1
expect_stderr 'feedback — FAILED'
expect_stderr 'placeholder'
expect_stdout 'HUMAN (humanAlways: docs/adr/0007-thing.md)'
expect_not_called "pr merge $PR --squash"
expect_not_called "pr update-branch $PR"
[ -f "$STATE/merged" ] && bad "the PR was merged despite the placeholder"
end

# ==========================================================================================
# 5. a humanAlways PR with no review-feedback entry at all is refused
# ==========================================================================================
begin "a humanAlways PR whose branch adds no review-feedback entry is refused"
fixture no-entry
V_FILES="CLAUDE.md"
cat >"$STATE/diff" <<'EOF'
diff --git a/CLAUDE.md b/CLAUDE.md
--- a/CLAUDE.md
+++ b/CLAUDE.md
@@ -1,0 +2,1 @@
+a new line
EOF
write_view default
write_merged_view
run_merge
expect_rc 1
expect_stderr 'feedback — FAILED'
expect_stderr 'adds no lines to docs/review-feedback.md'
expect_not_called "pr merge $PR --squash"
end

# ==========================================================================================
# 6. an unsupported humanAlways pattern refuses rather than classifying AUTO
# ==========================================================================================
# The one direction a mis-read pattern must never fail in.
begin "a humanAlways pattern the matcher does not understand is refused, not ignored"
fixture bad-pattern '["docs/*.md"]'
write_view default
run_merge
expect_rc 1
expect_stderr 'classify — FAILED'
expect_stderr 'unsupported humanAlways pattern: docs/*.md'
expect_not_called "pr merge $PR --squash"
end

# ==========================================================================================
# 7. BEHIND: update-branch runs first, and the merge is taken from the refreshed head
# ==========================================================================================
begin "a BEHIND PR is updated first and merges from the new head"
fixture behind
V_MSST="BEHIND"
write_view default
write_view 1
# What the refreshed head looks like: a new oid, CLEAN, and its own green checks.
V_MSST="CLEAN"
V_OID="bbb222"
write_view 2
write_merged_view
run_merge
expect_rc 0
expect_called "pr update-branch $PR"
expect_stdout 'updated onto the base (attempt 1)'
expect_stdout '2 check(s) complete on bbb222'
expect_called "pr merge $PR --squash"
update_at=$(call_line "pr update-branch $PR")
merge_at=$(call_line "pr merge $PR")
[ "$update_at" -gt 0 ] && [ "$update_at" -lt "$merge_at" ] ||
  bad "update-branch must run before the merge (update at $update_at, merge at $merge_at)"
end

# ==========================================================================================
# 8. …and a PR that is STILL behind after the update is never merged
# ==========================================================================================
# The companion to case 7, and the one that gives it meaning: update-branch running
# is only half the guarantee. PR #484 merged into a BEHIND state; what forbids that
# is the CLEAN check, so a fixture whose head stays BEHIND must refuse.
begin "a PR still BEHIND after update-branch is refused at the merge step"
fixture still-behind
V_MSST="BEHIND"
write_view default
must printf 'already up to date with the base branch\n' >"$STATE/update-branch.out"
must printf '1\n' >"$STATE/update-branch.rc"
write_merged_view
run_merge
expect_rc 1
expect_stdout 'already up to date with the base'
expect_stderr 'merge — FAILED'
expect_stderr "mergeStateStatus is 'BEHIND', not CLEAN"
expect_not_called "pr merge $PR --squash"
end

# ==========================================================================================
# 9. a batch of Closes lines merges --rebase
# ==========================================================================================
begin "a multi-Closes PR merges --rebase, one commit per member issue"
fixture batch
V_BODY="Closes #21 and Closes #22"
V_COMMITS="#21: the first,#22: the second"
write_view default
write_merged_view
run_merge
expect_rc 0
expect_stdout 'batch of 2 issues (#21 #22) -> rebase'
expect_called "pr merge $PR --rebase"
expect_not_called "pr merge $PR --squash"
expect_stdout 'closed by the merge: #21 #22'
end

# ==========================================================================================
# 10. a batch whose history is not curated is refused
# ==========================================================================================
begin "a batch whose commits do not match its member issues is refused"
fixture batch-uncurated
V_BODY="Closes #21 and Closes #22"
V_COMMITS="#21: the only commit"
write_view default
write_merged_view
run_merge
expect_rc 1
expect_stderr 'merge — FAILED'
expect_stderr 'curated history: 1 commit(s) for 2 member issue(s)'
expect_not_called "pr merge $PR --rebase"
end

# ==========================================================================================
# 11. a failing check exits non-zero and names the check
# ==========================================================================================
begin "a failing check exits non-zero, naming it, and never merges"
fixture red-check
V_CHECKS="checks:COMPLETED:SUCCESS,web-e2e:COMPLETED:FAILURE"
write_view default
write_merged_view
run_merge
expect_rc 1
expect_stderr 'checks — FAILED'
expect_stderr "check 'web-e2e' concluded FAILURE"
expect_not_called "pr merge $PR --squash"
end

# ==========================================================================================
# 12. an empty rollup is not green — "no check is pending" is trivially true of nothing
# ==========================================================================================
# The hole a settle-sleep papers over: immediately after update-branch the new head
# has no checks registered yet. The pre-update count is the floor the new head must
# reach, so an empty rollup polls on and, with no budget left, times out saying so.
begin "a rollup that has not registered yet is never read as green"
fixture unregistered
write_view default
write_view 1
V_CHECKS=""
write_view 2
POLL_TIMEOUT=0
run_merge
POLL_TIMEOUT=30
expect_rc 1
expect_stderr 'checks — FAILED'
expect_stderr 'timed out'
expect_stderr '0 of an expected 2 check(s) present'
expect_not_called "pr merge $PR --squash"
end

# ==========================================================================================
# 13. a run that dies mid-poll leaves nothing behind, and a re-run finishes the chain
# ==========================================================================================
# PR #488: the chain died on `error connecting to api.github.com` and left the PR
# open with no signal. The property under test is that the repair is a re-run —
# the script keeps no state of its own, so the second run re-reads and proceeds.
begin "a re-run after a mid-poll network failure resumes and completes"
fixture resume
write_view default
must printf 'error connecting to api.github.com\n' >"$STATE/view.2"
must printf '1\n' >"$STATE/view.2.rc"
write_merged_view
run_merge
expect_rc 1
expect_stderr 'checks — FAILED'
expect_stderr 'api.github.com'
expect_not_called "pr merge $PR --squash"
[ -f "$STATE/merged" ] && bad "the failed run merged anyway"

must rm -f "$STATE/view.2" "$STATE/view.2.rc"
reset_calls
run_merge
expect_rc 0
expect_called "pr update-branch $PR"
expect_called "pr merge $PR --squash"
expect_stdout "done — PR #$PR MERGED"
end

# ==========================================================================================
# 14. an already-merged PR runs only what is still owed
# ==========================================================================================
begin "an already-MERGED PR skips the merge steps and finishes the post-merge ones"
fixture idempotent
V_STATE="MERGED"
V_MSST="UNKNOWN"
V_LABELS="awaiting-review"
write_view default
run_merge
expect_rc 0
expect_stdout 'skipped (PR is already MERGED)'
expect_stdout "'awaiting-review' removed, after the merge"
expect_stdout "done — PR #$PR MERGED"
expect_not_called "pr update-branch $PR"
expect_not_called "pr merge $PR --squash"
expect_called "pr edit $PR --remove-label awaiting-review"
end

# ==========================================================================================
# 15. a Closes issue the merge did not close is reported, and the run ends non-zero
# ==========================================================================================
begin "an issue still OPEN after the merge is reported and the run ends non-zero"
fixture open-issue
write_view default
write_merged_view
must printf '{"number":12,"state":"OPEN"}\n' >"$STATE/issue.12"
run_merge
expect_rc 1
expect_stdout 'still OPEN: #12'
expect_stderr 'is merged, but the chain did not finish clean'
expect_stderr 'did not close #12'
# The merge itself still happened, and the steps after the issue check still ran:
# once the PR is merged there is nothing left to stop, only to report.
expect_called "pr merge $PR --squash"
expect_stdout "none holds '$HEAD_REF'"
end

# ==========================================================================================
# 16. the worktree holding the branch is handed to reap-worktree.sh
# ==========================================================================================
begin "a worktree holding the head branch is delegated to reap-worktree.sh"
fixture reap
must gitc "$REPO" worktree add --quiet -b "$HEAD_REF" "$ROOT/wt" HEAD
write_view default
write_merged_view
run_merge
expect_rc 0
expect_stdout 'REAPED'
[ -f "$STATE/reap.log" ] || bad "reap-worktree.sh was never called"
grep -qF -- "$ROOT/wt" "$STATE/reap.log" ||
  bad "reap was not pointed at the worktree holding the branch: $(cat "$STATE/reap.log" 2>/dev/null)"
end

# ==========================================================================================
# 17. …but never the worktree the caller is standing in
# ==========================================================================================
# reap-worktree.sh has its own own-cwd guard and this does not replace it; what is
# asserted here is that merge-pr.sh never even dispatches, so the guarantee does
# not depend on a second script's internals staying as they are.
begin "the worktree the caller is running in is never reaped"
fixture reap-own-cwd
must gitc "$REPO" worktree add --quiet -b "$HEAD_REF" "$ROOT/wt" HEAD
write_view default
write_merged_view
run_merge "$ROOT/wt"
expect_rc 0
expect_stdout "is the caller's own working directory — not reaped"
[ -f "$STATE/reap.log" ] && bad "reap was dispatched against the caller's own cwd"
end

# ==========================================================================================
# 18. usage
# ==========================================================================================
begin "a missing or non-numeric PR number is a usage error, and nothing is called"
fixture usage
write_view default
capture -C "$REPO" env MERGE_PR_GH_CMD="$ROOT/gh" bash "$SUBJECT"
expect_rc 2
expect_stderr 'usage: merge-pr.sh'
case_ctx="non-numeric"
capture -C "$REPO" env MERGE_PR_GH_CMD="$ROOT/gh" bash "$SUBJECT" "#490"
expect_rc 2
expect_stderr 'must be a number'
case_ctx=""
[ -s "$STATE/calls.log" ] && bad "gh was called for a run that never got past argument parsing"
end

# ==========================================================================================
# 19. a non-numeric knob is refused rather than silently changing a gate
# ==========================================================================================
begin "a non-numeric env knob is a usage error"
fixture knob
write_view default
capture -C "$REPO" env MERGE_PR_GH_CMD="$ROOT/gh" MERGE_PR_EXPECTED_CHECKS=lots \
  bash "$SUBJECT" "$PR" "$REPO"
expect_rc 2
expect_stderr 'MERGE_PR_EXPECTED_CHECKS must be a non-negative integer'
end

finish
