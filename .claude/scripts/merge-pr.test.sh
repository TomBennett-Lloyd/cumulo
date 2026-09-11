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

# `gh pr update-branch`'s two answers, and the only distinction the subject draws
# between them: the no-op it prints when the branch is already current, and
# anything else, which means it wrote a merge commit onto the branch.
UPDATE_NOOP='PR branch already up-to-date'
UPDATE_WROTE="Updated branch $HEAD_REF"

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
  # `files` is present here and the subject must IGNORE it — GitHub still answers
  # the field, capped at 100. Case 17b is what proves the ignoring: only the api
  # list carries the humanAlways path there, and the run still comes out HUMAN.
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
  # The changed-file list is NOT part of the `pr view` answer — the subject reads
  # it through a paginated `gh api …/files` call, because `--json files` caps at
  # 100 with no truncation signal. It is refreshed here so a case sets V_FILES
  # once and both reads agree.
  printf '%s' "$V_FILES" | tr ',' '\n' >"$STATE/files"
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
  "api "*)
    [ -f "\$state/files" ] && cat "\$state/files"
    rc=0
    [ -f "\$state/files.rc" ] && read -r rc <"\$state/files.rc"
    exit "\$rc"
    ;;
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
  # The no-op is the default answer, so that a case saying "updated" has to move
  # headRefOid on the reads that follow — an update that reports a write and
  # leaves the head where it was is a state GitHub does not produce, and the
  # subject now refuses it (case 12c).
  must printf '%s\n' "$UPDATE_NOOP" >"$STATE/update-branch.out"
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
must printf '%s\n' "$UPDATE_WROTE" >"$STATE/update-branch.out"
write_view 1
V_OID="bbb222"
write_view default
write_merged_view
run_merge
expect_rc 0
expect_stdout 'single issue #12 -> squash'
expect_stdout 'AUTO'
expect_stdout 'not owed (no humanAlways path in the diff)'
expect_stdout 'updated onto the base (attempt 1)'
expect_stdout 'the update moved the head aaa111 -> bbb222'
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
expect_stderr 'still reads the literal "pending — filled at merge"'
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
must printf '%s\n' "$UPDATE_WROTE" >"$STATE/update-branch.out"
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
if [ "$update_at" -le 0 ] || [ "$update_at" -ge "$merge_at" ]; then
  bad "update-branch must run before the merge (update at $update_at, merge at $merge_at)"
fi
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
# 9. a batch of Closes lines merges --rebase, and is NEVER update-branch'd
# ==========================================================================================
# `gh pr update-branch` writes a merge commit, which breaks the one-commit-per-member
# invariant and blocks rebase-merge outright (run-issue step 4, and the bounce
# paragraphs in task-orchestrator). Running it and then refusing at the merge step
# would pollute the branch first — so the skip, not a late refusal, is the property.
begin "a multi-Closes PR merges --rebase and is never update-branch'd"
fixture batch
V_BODY="Closes #21 and Closes #22"
V_COMMITS="#21: the first,#22: the second"
write_view default
write_merged_view
run_merge
expect_rc 0
expect_stdout 'batch of 2 issues (#21 #22) -> rebase'
expect_stdout "skipped — a --rebase batch is curated and force-pushed by its owner"
expect_not_called "pr update-branch $PR"
expect_called "pr merge $PR --rebase"
expect_not_called "pr merge $PR --squash"
expect_stdout 'closed by the merge: #21 #22'
end

# ==========================================================================================
# 10. a batch whose history is not curated is refused BEFORE anything is touched
# ==========================================================================================
begin "a batch whose commits do not match its member issues is refused at classify"
fixture batch-uncurated
V_BODY="Closes #21 and Closes #22"
V_COMMITS="#21: the only commit"
write_view default
write_merged_view
run_merge
expect_rc 1
expect_stderr 'classify — FAILED'
expect_stderr 'curated history: 1 commit(s) for 2 member issue(s)'
expect_not_called "pr merge $PR --rebase"
expect_not_called "pr update-branch $PR"
end

# ==========================================================================================
# 10b. a batch that is not CLEAN is bounced to its owner, never updated from here
# ==========================================================================================
begin "a BEHIND --rebase batch is refused with the curate-onto-main bounce"
fixture batch-behind
V_BODY="Closes #21 and Closes #22"
V_COMMITS="#21: the first,#22: the second"
V_MSST="BEHIND"
write_view default
write_merged_view
run_merge
expect_rc 1
expect_stderr 'merge — FAILED'
expect_stderr 'curate onto latest main'
expect_not_called "pr update-branch $PR"
expect_not_called "pr merge $PR --rebase"
end

# ==========================================================================================
# 10b-ii. …but the bounce is prescribed only for the states it repairs
# ==========================================================================================
# BLOCKED is branch protection, not a stale branch. Telling a merge owner to bounce
# an agent into a rebase-and-force-push when the blocker is a required review sends
# them to a wrong and expensive repair, so only BEHIND and DIRTY get that message.
begin "a BLOCKED --rebase batch is refused by state, with no curate-onto-main advice"
fixture batch-blocked
V_BODY="Closes #21 and Closes #22"
V_COMMITS="#21: the first,#22: the second"
V_MSST="BLOCKED"
write_view default
write_merged_view
run_merge
expect_rc 1
expect_stderr 'merge — FAILED'
expect_stderr "mergeStateStatus is 'BLOCKED', not CLEAN"
expect_not_stderr 'curate onto latest main'
expect_not_called "pr merge $PR --rebase"
end

# ==========================================================================================
# 10c. --method overrides the inference, and the squash path updates the branch again
# ==========================================================================================
# The inference is a heuristic: PR #414 carried four Closes lines and was squashed.
# An operator who knows the lane says so, and the update-branch skip — which is a
# property of the REBASE path, not of the Closes count — goes with the method.
begin "--method squash overrides a multi-Closes inference, update-branch included"
fixture method-override
V_BODY="Closes #21 and Closes #22"
V_COMMITS="#21: the first,#22: the second"
write_view default
write_merged_view
capture -C "$REPO" env \
  MERGE_PR_GH_CMD="$ROOT/gh" MERGE_PR_REAP_CMD="$ROOT/reap" \
  MERGE_PR_POLL_INTERVAL_SECONDS=0 MERGE_PR_POLL_TIMEOUT_SECONDS=30 \
  MERGE_PR_RETRY_SECONDS=0 MERGE_PR_CONFIRM_RETRIES=2 \
  bash "$SUBJECT" --method squash "$PR" "$REPO"
expect_rc 0
expect_stdout 'overridden to squash'
expect_called "pr update-branch $PR"
expect_called "pr merge $PR --squash"
expect_not_called "pr merge $PR --rebase"
end

# ==========================================================================================
# 10d. a PR with no Closes line is refused at classify, before anything is touched
# ==========================================================================================
# Not a corner: retro PRs and campaign batches here routinely carry none, so this is
# the path a merge owner meets in practice. Refusing it at the merge step would mean
# refusing after update-branch had written to the branch and a CI round had been spent.
begin "a PR with no Closes line is refused at classify"
fixture no-closes
V_BODY="What and why, with no closing keyword at all."
write_view default
write_merged_view
run_merge
expect_rc 1
expect_stderr 'classify — FAILED'
expect_stderr 'no Closes line in the PR body'
expect_stderr 'pass --method squash|rebase'
expect_not_called "pr update-branch $PR"
expect_not_called "pr merge $PR --squash"
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
must printf '%s\n' "$UPDATE_WROTE" >"$STATE/update-branch.out"
write_view default
write_view 1
# The new head, with nothing registered on it yet.
V_OID="bbb222"
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
# 12b. the post-update rollup that is still the OLD head's is waited out, in one run
# ==========================================================================================
# PR #501's sequence exactly: update-branch wrote, and the next read answered the
# old head's sha, the old head's rollup — complete, none pending, so the baseline
# floor was satisfied by it — and BLOCKED. The floor cannot separate that answer
# from a fresh one; the sha can. The property is that ONE invocation waits and then
# merges, because the manual repair for this was a second run 90 s later.
begin "a post-update rollup still belonging to the old head is waited out, then merged"
fixture stale-rollup
must printf '%s\n' "$UPDATE_WROTE" >"$STATE/update-branch.out"
V_MSST="BEHIND"
write_view 1
V_MSST="BLOCKED"
write_view 2
V_OID="bbb222"
V_MSST="CLEAN"
write_view 3
write_view default
write_merged_view
run_merge
expect_rc 0
expect_stdout 'updated onto the base (attempt 1)'
expect_stdout 'the update moved the head aaa111 -> bbb222'
expect_stdout '2 check(s) complete on bbb222'
expect_not_stdout 'complete on aaa111'
expect_not_stderr "mergeStateStatus is 'BLOCKED'"
expect_called "pr merge $PR --squash"
# The stale answer was re-read rather than believed: classify, the stale poll, the
# fresh poll, and the post-merge confirmation are four reads, and a subject that
# merged on the first post-update answer would show three.
views=$(grep -c -- "^pr view $PR " "$STATE/calls.log")
[ "$views" -ge 4 ] || bad "expected at least 4 pr view calls, got $views"
end

# ==========================================================================================
# 12c. …and an update that reports a write while the head never moves is refused
# ==========================================================================================
# The companion that gives 12b its meaning: waiting is only half the guarantee, and
# a wait with no end is how the timeout budget gets spent on a PR nobody is going
# to merge. The fixture is otherwise mergeable — CLEAN, two green checks — so a
# subject that skipped the sha would merge it.
begin "an update that reports a write while the head never moves is refused"
fixture head-unmoved
must printf '%s\n' "$UPDATE_WROTE" >"$STATE/update-branch.out"
write_view default
write_merged_view
POLL_TIMEOUT=0
run_merge
POLL_TIMEOUT=30
expect_rc 1
expect_stderr 'checks — FAILED'
expect_stderr 'the head still reads aaa111'
expect_not_called "pr merge $PR --squash"
[ -f "$STATE/merged" ] && bad "the PR merged on a head that never moved"
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
# 17b. the humanAlways decision is made off the PAGINATED file list
# ==========================================================================================
# `gh pr view --json files` is files(first: 100) with no truncation signal, so a PR
# whose only humanAlways path sorts past the cap would classify AUTO and merge with
# no owner review — the one direction that cannot be taken back. The fixture proves
# the subject reads the api list and not the view: only the api list carries
# CLAUDE.md, and the run must still come out HUMAN.
begin "humanAlways is classified from the paginated file list, not the capped one"
fixture paginated-files
V_FILES="docs/notes.md"
write_view default
write_merged_view
must printf 'docs/notes.md\nCLAUDE.md\n' >"$STATE/files"
cat >"$STATE/diff" <<'EOF'
diff --git a/docs/review-feedback.md b/docs/review-feedback.md
--- a/docs/review-feedback.md
+++ b/docs/review-feedback.md
@@ -1,0 +2,3 @@
+## 2026-09-11 — PR #490 — slug
+- **Category**: approved-no-changes
+- **Verdict**: Approved without changes.
EOF
run_merge
expect_rc 0
expect_stdout 'HUMAN (humanAlways: CLAUDE.md)'
expect_called "api repos/{owner}/{repo}/pulls/$PR/files --paginate --jq .[].filename"
end

# ==========================================================================================
# 17c. an empty file list refuses rather than classifying AUTO against nothing
# ==========================================================================================
begin "an empty changed-file list is refused, not read as AUTO"
fixture empty-files
write_view default
must : >"$STATE/files"
run_merge
expect_rc 1
expect_stderr 'classify — FAILED'
expect_stderr 'came back empty'
expect_not_called "pr merge $PR --squash"
end

# ==========================================================================================
# 17d. the placeholder is looked for in the two declared FIELDS, not in any added line
# ==========================================================================================
# docs/review-feedback.md's own `## Entry format` section quotes the literal
# while explaining it. A humanAlways PR editing that section must not be refused
# with a message about a verdict it does not have: a refusal whose stated reason is
# false teaches the reader to stop believing the next one.
begin "the placeholder quoted in the Entry-format prose is not read as an unfilled verdict"
fixture placeholder-in-prose
V_FILES="CLAUDE.md"
cat >"$STATE/diff" <<'EOF'
diff --git a/docs/review-feedback.md b/docs/review-feedback.md
--- a/docs/review-feedback.md
+++ b/docs/review-feedback.md
@@ -1,0 +2,6 @@
+A pre-label entry writes both Category and Verdict as the literal
+`pending — filled at merge`, and whoever merges fills them on the branch.
+
+## 2026-09-11 — PR #490 — slug
+- **Category**: convention
+- **Verdict**: Approved without changes.
EOF
write_view default
write_merged_view
run_merge
expect_rc 0
expect_stdout 'entry on the branch, both placeholders filled'
expect_called "pr merge $PR --squash"
end

# ==========================================================================================
# 17e. an entry missing its Verdict line is refused
# ==========================================================================================
begin "an added entry with no Verdict line is refused"
fixture no-verdict
V_FILES="CLAUDE.md"
cat >"$STATE/diff" <<'EOF'
diff --git a/docs/review-feedback.md b/docs/review-feedback.md
--- a/docs/review-feedback.md
+++ b/docs/review-feedback.md
@@ -1,0 +2,2 @@
+## 2026-09-11 — PR #490 — slug
+- **Category**: convention
EOF
write_view default
write_merged_view
run_merge
expect_rc 1
expect_stderr 'feedback — FAILED'
expect_stderr 'no "- **Verdict**:" line'
expect_not_called "pr merge $PR --squash"
end

# ==========================================================================================
# 17f. an already-merged humanAlways PR with an unfilled verdict is reported, not refused
# ==========================================================================================
# Once the PR is merged there is nothing left to stop — but "a merged entry still
# reading pending is a verdict nobody filled", so the run still ends non-zero and
# the remaining post-merge steps still run.
begin "an unfilled verdict on an already-merged PR is deferred, not refused"
fixture merged-unfilled
V_STATE="MERGED"
V_MSST="UNKNOWN"
V_FILES="CLAUDE.md"
cat >"$STATE/diff" <<'EOF'
diff --git a/docs/review-feedback.md b/docs/review-feedback.md
--- a/docs/review-feedback.md
+++ b/docs/review-feedback.md
@@ -1,0 +2,3 @@
+## 2026-09-11 — PR #490 — slug
+- **Category**: pending — filled at merge
+- **Verdict**: pending — filled at merge
EOF
write_view default
run_merge
expect_rc 1
expect_stdout 'UNFILLED on an already-merged PR'
expect_stderr 'is merged, but the chain did not finish clean'
expect_stdout 'closed by the merge: #12'
expect_stdout "none holds '$HEAD_REF'"
end

# ==========================================================================================
# 17g. a CLOSED-but-unmerged PR has no ritual to run
# ==========================================================================================
begin "a CLOSED PR that was never merged is refused outright"
fixture closed
V_STATE="CLOSED"
write_view default
run_merge
expect_rc 1
expect_stderr 'classify — FAILED'
expect_stderr 'CLOSED without being merged'
expect_not_called "pr merge $PR --squash"
expect_not_called "pr update-branch $PR"
end

# ==========================================================================================
# 17h. a PR merged elsewhere while this run was working finishes the chain, it does not fail
# ==========================================================================================
# A merged PR reports mergeStateStatus UNKNOWN, the same answer GitHub gives while
# it is still computing a merge, so the merge step cannot read that status alone.
# What this case pins is the STATE guard the merge block opens with: without it the
# run would refuse a PR that is merged. It does NOT pin the MERGED arm of the
# re-read loop above — that arm only saves the remaining sleeps, and deleting it
# leaves this case green, which is the honest thing to say about a case rather than
# claim coverage the mutation does not support.
begin "a PR merged elsewhere mid-run finishes the post-merge steps instead of failing"
fixture merged-elsewhere
V_LABELS="awaiting-review"
write_view default
write_view 1
# The poll's read: checks are ready, but the merge state has not settled, which is
# what sends the merge step into its UNKNOWN re-read loop.
V_MSST="UNKNOWN"
write_view 2
# What that loop reads: merged, and still answering UNKNOWN — which is what a
# merged PR always answers, and the reason the loop cannot watch the status alone.
V_STATE="MERGED"
write_view 3
run_merge
expect_rc 0
expect_stdout 'skipped (the PR was merged elsewhere while this run was working)'
expect_stdout "'awaiting-review' removed, after the merge"
expect_stdout "done — PR #$PR MERGED"
expect_not_called "pr merge $PR --squash"
end

# ==========================================================================================
# 17i. gh's no-op answer is read on the SUCCESS path, where it actually arrives
# ==========================================================================================
# gh prints "PR branch already up-to-date" and exits 0. A step that reported every
# rc=0 as "updated onto the base" would claim a write that never happened — and the
# checks baseline it implies is the difference between waiting for a new head's
# workflows and merging on the old head's results.
begin "an rc=0 'already up-to-date' answer is reported as a no-op, not as an update"
fixture noop-success
write_view default
must printf 'PR branch already up-to-date\n' >"$STATE/update-branch.out"
must printf '0\n' >"$STATE/update-branch.rc"
write_merged_view
run_merge
expect_rc 0
expect_stdout 'already up to date with the base'
expect_not_stdout 'updated onto the base'
expect_called "pr merge $PR --squash"
end

# ==========================================================================================
# 17j. the head-sha race is retried, in the spelling GitHub actually uses
# ==========================================================================================
# The REST 422 reads `expected_head_sha didn't match pull request head.` —
# underscores. An arm matching only "head sha" with a space never sees it, and the
# run fails on the exact race the retry loop exists for.
begin "an expected_head_sha 422 is retried rather than failing the run"
fixture headsha-race
write_view default
must printf "expected_head_sha didn't match pull request head.\n" >"$STATE/update-branch.out"
must printf '1\n' >"$STATE/update-branch.rc"
write_merged_view
run_merge
expect_rc 1
expect_stderr 'update-branch — FAILED'
expect_stderr 'the head moved under every one of 3 attempts'
expect_not_called "pr merge $PR --squash"
# Retried, not refused on the first answer: three attempts, one call each.
attempts=$(grep -c -- "^pr update-branch $PR\$" "$STATE/calls.log")
[ "$attempts" = "3" ] || bad "expected 3 update-branch attempts, got $attempts"
end

# ==========================================================================================
# 17k. an entry with no Category line is refused
# ==========================================================================================
begin "an added entry with no Category line is refused"
fixture no-category
V_FILES="CLAUDE.md"
cat >"$STATE/diff" <<'EOF'
diff --git a/docs/review-feedback.md b/docs/review-feedback.md
--- a/docs/review-feedback.md
+++ b/docs/review-feedback.md
@@ -1,0 +2,2 @@
+## 2026-09-11 — PR #490 — slug
+- **Verdict**: Approved without changes.
EOF
write_view default
write_merged_view
run_merge
expect_rc 1
expect_stderr 'feedback — FAILED'
expect_stderr 'no "- **Category**:" line'
expect_not_called "pr merge $PR --squash"
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
