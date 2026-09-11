#!/usr/bin/env bash
#
# The merge ritual, as one idempotent script.
#
# The merge owner ran this chain by hand for every PR — update-branch first, a
# pending-aware checks poll, merge only on CLEAN, squash for a single issue and
# rebase for a batch, and for a humanAlways PR the review-feedback verdict on the
# branch before the merge and the label off only after it. Retyped each time, it
# failed in every way a hand-typed chain can: one chain took the label off on
# CI-green rather than on merge (PR #469), one skipped update-branch and hit
# BEHIND (PR #484), and one died mid-poll on `error connecting to api.github.com`
# and left the PR open with no signal at all (PR #488). docs/friction-log.md's
# 2026-09-11 entry records the class.
#
# So the chain is a script, and the property that matters most is that it is
# RE-RUNNABLE FROM ANY STATE. Nothing is remembered between runs; every step
# reads the PR's current state and decides whether it is still owed. A run that
# dies mid-poll is repaired by running it again, which is also why every failure
# exits non-zero with the STEP named — the name is where the next run resumes.
#
# What this script will never do is fill in a verdict. A humanAlways PR whose
# docs/review-feedback.md entry still carries the literal `pending — filled at
# merge` placeholder is REFUSED, because that placeholder means the owner has not
# decided yet, and the whole point of the form (docs/review-feedback.md's
# `## Entry format`) is that a filled verdict stays distinguishable from an
# unfilled one. CI's merge-ritual-gate cannot make that distinction —
# .github/workflows/ci.yml comment (d) says so in terms: it sees that the file is
# in the diff and nothing beyond that, so a placeholder clears it exactly as a
# real entry does. This refusal is that gap, and it is the one step here that is
# a gate rather than a convenience.
#
# Usage:
#   merge-pr.sh [--method squash|rebase] <pr-number> [repo-root]
#
#     pr-number   the PR to merge
#     repo-root   the repository to act in (default: the one holding this script)
#     --method    override the squash/rebase inference (see the classify step)
#
# Exit:  0 the chain completed (or had already completed on an earlier run)
#        1 a step failed or refused — the message names it; fix the cause and re-run
#        2 the script could not reach a verdict at all (usage, no node, no repo)
#
set -uo pipefail
export PATH="/opt/homebrew/bin:$PATH"

# The caller's working directory, captured BEFORE anything cds: the worktree step
# must never reap the directory the operator is standing in, and after a `cd` to
# the repository root there is no way left to ask where that was.
caller_cwd="$PWD"

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2
# shellcheck source=./worktree-lib.sh
. "$script_dir/worktree-lib.sh"

# Env knobs, all overridable — the harness pins the waits to zero, and an operator
# on a slow lane can widen the poll without editing the script.
: "${MERGE_PR_GH_CMD:=gh}"                             # GitHub CLI; the one seam the harness stubs
: "${MERGE_PR_REAP_CMD:=$script_dir/reap-worktree.sh}" # the reaper, which owns its own safety checks
: "${MERGE_PR_POLL_INTERVAL_SECONDS:=20}"              # between checks polls
: "${MERGE_PR_POLL_TIMEOUT_SECONDS:=1800}"             # total budget for the checks poll
: "${MERGE_PR_UPDATE_RETRIES:=3}"                      # update-branch attempts against the head-sha race
: "${MERGE_PR_RETRY_SECONDS:=10}"                      # between those attempts, and between state re-reads
: "${MERGE_PR_EXPECTED_CHECKS:=0}"                     # a floor the operator can raise; see the checks step
: "${MERGE_PR_CONFIRM_RETRIES:=5}"                     # re-reads allowed for an eventually-consistent state

# `files` is deliberately NOT in this list. `gh pr view --json files` is
# `files(first: 100)` with no truncation signal, and the humanAlways decision made
# off a silently-truncated file list fails in the one direction that cannot be
# taken back: a PR touching CLAUDE.md as its 120th file would classify AUTO and
# merge without the owner. The file list is read separately, paginated, exactly as
# .github/workflows/ci.yml's merge-ritual-gate reads it and for the reason its
# comment (c) gives. `commits` carries the same cap and is left on this list: it
# feeds only the curated-history check, whose comparison is against a member count
# of two to six, so a truncated answer refuses rather than merges.
PR_JSON_FIELDS='body,commits,headRefName,headRefOid,labels,mergeStateStatus,number,state,statusCheckRollup,url'

# The numeric knobs are validated here rather than where they are used. Under
# `set -u` without `set -e`, a `[ "$x" -gt 0 ]` on a non-numeric value prints an
# error, returns 2, and the script carries on with whichever branch that happens
# to select — so a fat-fingered override would silently change a gate. Refusing
# up front makes it a usage error instead.
for knob in MERGE_PR_POLL_INTERVAL_SECONDS MERGE_PR_POLL_TIMEOUT_SECONDS \
  MERGE_PR_UPDATE_RETRIES MERGE_PR_RETRY_SECONDS MERGE_PR_EXPECTED_CHECKS \
  MERGE_PR_CONFIRM_RETRIES; do
  case "${!knob}" in
    '' | *[!0-9]*)
      printf 'merge-pr: %s must be a non-negative integer, got "%s"\n' "$knob" "${!knob}" >&2
      exit 2
      ;;
  esac
done

usage() {
  cat >&2 <<'EOF'
usage: merge-pr.sh [--method squash|rebase] <pr-number> [repo-root]

  pr-number   the PR to merge
  repo-root   the repository to act in (default: the one holding this script)
  --method    override the squash/rebase inference (see the classify step)

Exit: 0 chain complete, 1 a step failed or refused (a re-run resumes there), 2 no verdict.
EOF
  exit 2
}

pr_number=""
repo_root=""
method_override=""
while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help) usage ;;
    --method)
      shift
      case "${1-}" in
        squash | rebase) method_override="$1" ;;
        *)
          printf 'merge-pr: --method takes squash or rebase, got "%s"\n' "${1-}" >&2
          usage
          ;;
      esac
      ;;
    -*)
      printf 'merge-pr: unknown option %s\n' "$1" >&2
      usage
      ;;
    *)
      if [ -z "$pr_number" ]; then
        pr_number="$1"
      elif [ -z "$repo_root" ]; then
        repo_root="$1"
      else
        printf 'merge-pr: expected at most two arguments, got a third: %s\n' "$1" >&2
        usage
      fi
      ;;
  esac
  shift
done

[ -n "$pr_number" ] || usage
case "$pr_number" in
  '' | *[!0-9]*)
    printf 'merge-pr: <pr-number> must be a number, got "%s"\n' "$pr_number" >&2
    usage
    ;;
esac

if [ -z "$repo_root" ]; then
  repo_root=$(git -C "$script_dir" rev-parse --show-toplevel) || {
    printf 'merge-pr: %s is not inside a git repository, and no repo-root was given\n' "$script_dir" >&2
    exit 2
  }
fi
[ -d "$repo_root" ] || {
  printf 'merge-pr: %s is not a directory\n' "$repo_root" >&2
  exit 2
}
repo_root=$(canon "$repo_root") || exit 2
caller_cwd=$(canon "$caller_cwd") || exit 2

# Every `gh` call infers its repository from the working directory, so the whole
# chain runs from the repository root rather than from wherever the operator was.
cd "$repo_root" || exit 2

# --- reporting ------------------------------------------------------------------------------
#
# One line per step on stdout, and nothing else there: a run's transcript is meant
# to read as the ritual it performs. Diagnostics go to stderr, where they cannot
# be mistaken for a step that happened.

step() { # step <name> <detail>
  printf 'merge-pr: %s — %s\n' "$1" "$2"
}

fail() { # fail <step> <message> — exit 1, naming the step a re-run resumes from
  printf 'merge-pr: %s — FAILED: %s\n' "$1" "$2" >&2
  printf 'merge-pr: nothing after "%s" ran. Fix the cause and re-run "merge-pr.sh %s"; it resumes from that step.\n' "$1" "$pr_number" >&2
  exit 1
}

# Deferred failures: things that are wrong but that no longer have anything to
# stop. Once the PR is merged, an unclosed `Closes` issue or an unfilled verdict
# can only be reported, so the remaining post-merge steps still run and the run
# ends non-zero with all of them named at once.
deferred=()
defer() { # defer <step> <message>
  deferred+=("$1 — $2")
}

# --- JSON, read by node ----------------------------------------------------------------------
#
# node is the repo's declared runtime (package.json engines) and worktree-lib.sh
# has already refused to load without it. Parsing is one pass that emits
# TAB-separated records for bash to read — deliberately not `gh --jq`, which would
# put jq in the stub's contract too, and deliberately not `eval` of a generated
# assignment block, which would make a PR body a code-execution surface.

pr_facts() { # stdin: a `gh pr view --json` object; stdout: <kind>\t<a>[\t<b>\t<c>] records
  node -e '
let raw = "";
process.stdin.on("data", (d) => (raw += d)).on("end", () => {
  let pr;
  try {
    pr = JSON.parse(raw);
  } catch (e) {
    process.stderr.write("gh returned output that is not JSON: " + e.message + "\n");
    process.exit(2);
  }
  const out = [];
  // Tabs and newlines are the record separators, so anything carrying them is
  // flattened rather than allowed to invent extra fields or extra records.
  const put = (...f) =>
    out.push(f.map((v) => String(v == null ? "" : v).replace(/[\t\r\n]/g, " ")).join("\t"));
  put("state", pr.state);
  put("headRefName", pr.headRefName);
  put("headRefOid", pr.headRefOid);
  put("mergeStateStatus", pr.mergeStateStatus);
  put("url", pr.url);
  for (const l of pr.labels || []) put("label", l && l.name);
  for (const c of pr.commits || []) put("commit", c && c.messageHeadline);
  for (const c of pr.statusCheckRollup || []) {
    // Two shapes share this array. A CheckRun carries status + conclusion; a
    // StatusContext (the older commit-status API, which the rollup still mixes
    // in) carries only "state". Normalising here gives the caller one vocabulary,
    // and an unrecognised shape reports an empty status, which the caller counts
    // as pending rather than as passing.
    const name = (c && (c.name || c.context)) || "(unnamed check)";
    let status = c && c.status;
    let conclusion = c && c.conclusion;
    if (!status && c && c.state) {
      status = c.state === "PENDING" || c.state === "EXPECTED" ? "PENDING" : "COMPLETED";
      conclusion = c.state;
    }
    put("check", name, status, conclusion);
  }
  // The closing keywords GitHub itself honours, and the reason this is read from
  // the body rather than from "closingIssuesReferences": the body is what the PR
  // author wrote and what a reviewer read, and the squash-vs-rebase decision has
  // to turn on the same text a human would count.
  const seen = new Set();
  const re = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;
  let m;
  while ((m = re.exec(pr.body || ""))) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      put("closes", m[1]);
    }
  }
  process.stdout.write(out.join("\n") + "\n");
});
'
}

json_field() { # json_field <key>; stdin: a JSON object; stdout: that key as a string
  node -e '
let raw = "";
process.stdin.on("data", (d) => (raw += d)).on("end", () => {
  try {
    const o = JSON.parse(raw);
    const v = o[process.argv[1]];
    process.stdout.write((v == null ? "" : String(v)) + "\n");
  } catch (e) {
    process.stderr.write("expected a JSON object: " + e.message + "\n");
    process.exit(2);
  }
});
' "$1"
}

# --- PR state ---------------------------------------------------------------------------------

pr_state=""
pr_head_ref=""
pr_head_sha=""
pr_merge_state=""
pr_url=""
pr_labels=()
pr_closes=()
pr_commits=()
check_names=()
check_statuses=()
check_conclusions=()
last_error=""

read_pr() { # read_pr -> 0 and the globals refreshed, or 1 with $last_error set
  local json facts rc kind a b c
  json=$("$MERGE_PR_GH_CMD" pr view "$pr_number" --json "$PR_JSON_FIELDS" 2>&1)
  rc=$?
  if [ "$rc" -ne 0 ]; then
    last_error="gh pr view exited $rc: $json"
    return 1
  fi
  facts=$(printf '%s' "$json" | pr_facts 2>&1)
  rc=$?
  if [ "$rc" -ne 0 ]; then
    last_error="could not parse gh's answer: $facts"
    return 1
  fi

  pr_state=""
  pr_head_ref=""
  pr_head_sha=""
  pr_merge_state=""
  pr_url=""
  pr_labels=()
  pr_closes=()
  pr_commits=()
  check_names=()
  check_statuses=()
  check_conclusions=()

  # A heredoc, not a pipe: piping into the loop would run it in a subshell and
  # every global it sets would be discarded at the closing `done`.
  while IFS=$'\t' read -r kind a b c; do
    case "$kind" in
      state) pr_state="$a" ;;
      headRefName) pr_head_ref="$a" ;;
      headRefOid) pr_head_sha="$a" ;;
      mergeStateStatus) pr_merge_state="$a" ;;
      url) pr_url="$a" ;;
      label) pr_labels+=("$a") ;;
      closes) pr_closes+=("$a") ;;
      commit) pr_commits+=("$a") ;;
      check)
        check_names+=("$a")
        check_statuses+=("$b")
        check_conclusions+=("$c")
        ;;
    esac
  done <<EOF
$facts
EOF

  if [ -z "$pr_state" ]; then
    last_error="gh's answer carried no PR state — PR #$pr_number may not exist"
    return 1
  fi
  return 0
}

read_pr || fail 'classify' "$last_error"

case "$pr_state" in
  OPEN | MERGED) ;;
  CLOSED) fail 'classify' "PR #$pr_number is CLOSED without being merged — there is no ritual to run" ;;
  *) fail 'classify' "PR #$pr_number is in an unrecognised state '$pr_state'" ;;
esac

already_merged=0
[ "$pr_state" = "MERGED" ] && already_merged=1

# --- step: classify ----------------------------------------------------------------------------
#
# Two independent classifications, and every refusal either of them implies, all
# resolved HERE — before update-branch has touched the branch and before the poll
# has spent a CI round. A refusal that arrives at the merge step has already cost
# what it exists to save.

merge_method=""
case "${#pr_closes[@]}" in
  0) merge_reason="no Closes line in the PR body" ;;
  1)
    merge_method="--squash"
    merge_reason="single issue #${pr_closes[0]} -> squash"
    ;;
  *)
    merge_method="--rebase"
    closes_list=$(printf ' #%s' "${pr_closes[@]}")
    merge_reason="batch of ${#pr_closes[@]} issues (${closes_list# }) -> rebase"
    ;;
esac

# An explicit --method overrides the inference, and exists because the inference
# is a heuristic rather than a fact. "Batch" is a run-issue lane property —
# `orchestration.routeRule`'s 2-6 members, one agent, one in-flight row — and a
# Closes count only correlates with it: PR #414 carried four Closes lines and was
# squash-merged. The inference stays the default because the issue asks for it;
# an operator who knows the lane says so and is believed.
if [ -n "$method_override" ]; then
  merge_method="--$method_override"
  merge_reason="$merge_reason, overridden to $method_override"
fi

# The changed-file list, paginated. `--paginate` is what makes the answer the
# whole PR rather than its first 100 files (see the PR_JSON_FIELDS comment), and
# the shape is lifted verbatim from .github/workflows/ci.yml's merge-ritual-gate
# step, which reads the same list for the same reason.
pr_files=()
files_out=$("$MERGE_PR_GH_CMD" api "repos/{owner}/{repo}/pulls/$pr_number/files" \
  --paginate --jq '.[].filename' 2>&1)
files_rc=$?
[ "$files_rc" -eq 0 ] || fail 'classify' "could not read the changed-file list (gh api exited $files_rc): $files_out"
while IFS= read -r path; do
  [ -n "$path" ] || continue
  pr_files+=("$path")
done <<EOF
$files_out
EOF
# A PR with no files is not a thing GitHub produces, so an empty list means the
# read answered something this script does not understand — and an empty list is
# exactly what classifies every humanAlways PR as AUTO.
[ "${#pr_files[@]}" -gt 0 ] || fail 'classify' "the changed-file list came back empty for PR #$pr_number — refusing to classify humanAlways against nothing"

# humanAlways matching, against the list .claude/workflow.json owns. The glob
# subset understood is exactly two shapes — a literal path, and a `<dir>/**`
# prefix — and a pattern of any other shape is REFUSED rather than quietly
# treated as a literal, because the failure direction of a mis-read pattern is a
# humanAlways PR classified AUTO and merged without the owner ever seeing it.
human_hits=$(node -e '
const fs = require("fs");
let wf;
try {
  wf = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
} catch (e) {
  process.stderr.write("could not read the humanAlways list: " + e.message + "\n");
  process.exit(2);
}
const pats = wf && wf.merge && wf.merge.humanAlways;
if (!Array.isArray(pats) || pats.length === 0) {
  process.stderr.write("merge.humanAlways is missing or empty in " + process.argv[1] + "\n");
  process.exit(2);
}
const files = process.argv.slice(2);
const hits = [];
for (const p of pats) {
  let match;
  if (typeof p !== "string" || p.length === 0) {
    process.stderr.write("merge.humanAlways holds a pattern that is not a non-empty string\n");
    process.exit(3);
  } else if (p.endsWith("/**")) {
    const prefix = p.slice(0, -2); // keeps the trailing slash: docs/adr/** -> docs/adr/
    if (/[*?[\]]/.test(prefix)) {
      process.stderr.write("unsupported humanAlways pattern: " + p + "\n");
      process.exit(3);
    }
    match = (f) => f.startsWith(prefix);
  } else if (/[*?[\]]/.test(p)) {
    process.stderr.write("unsupported humanAlways pattern: " + p + "\n");
    process.exit(3);
  } else {
    match = (f) => f === p;
  }
  for (const f of files) if (match(f) && !hits.includes(f)) hits.push(f);
}
process.stdout.write(hits.join(" "));
' "$repo_root/.claude/workflow.json" ${pr_files[@]+"${pr_files[@]}"} 2>&1)
human_rc=$?
[ "$human_rc" -eq 0 ] || fail 'classify' "cannot classify humanAlways: $human_hits"

is_human=0
class_summary="AUTO"
if [ -n "$human_hits" ]; then
  is_human=1
  class_summary="HUMAN (humanAlways: $human_hits)"
fi

curated_history_ok() { # -> 0, or 1 with the reason on stdout
  # .claude/skills/run-issue/SKILL.md step 4 makes --rebase conditional on this:
  # one commit per surviving member, each naming its member issue. A script that
  # took the rebase branch without checking would merge batches on terms the repo
  # forbids, so the check travels with the branch that needs it.
  local n m found
  if [ "${#pr_commits[@]}" -ne "${#pr_closes[@]}" ]; then
    printf 'curated history: %s commit(s) for %s member issue(s) — a batch merges --rebase only when those match\n' \
      "${#pr_commits[@]}" "${#pr_closes[@]}"
    return 1
  fi
  for n in "${pr_closes[@]}"; do
    found=0
    for m in "${pr_commits[@]}"; do
      case "$m" in
        *"#$n"*)
          found=1
          break
          ;;
      esac
    done
    if [ "$found" = "0" ]; then
      printf 'curated history: no commit subject references member issue #%s\n' "$n"
      return 1
    fi
  done
  return 0
}

step 'classify' "PR #$pr_number is $pr_state on '$pr_head_ref'; $merge_reason; $class_summary"

# Every refusal the classification already implies is taken HERE, while the branch
# is still untouched and no CI round has been spent. Deferring either of these to
# the merge step would mean refusing AFTER update-branch had written to the branch
# and the poll had waited out a full run — the cost this script exists to save.
if [ "$already_merged" = "0" ]; then
  [ -n "$merge_method" ] || fail 'classify' \
    "$merge_reason — cannot tell a single-issue squash from a batch rebase. Add the Closes line to the body, or pass --method squash|rebase"
  if [ "$merge_method" = "--rebase" ]; then
    curated_reason=$(curated_history_ok) || fail 'classify' "$curated_reason"
  fi
fi

# --- step: feedback ---------------------------------------------------------------------------
#
# humanAlways only. What is read is the branch's ADDED lines to
# docs/review-feedback.md, straight out of the PR diff, because that is exactly
# the set of lines this PR is responsible for: the entry for this PR is by
# construction something the branch added, and an entry an earlier PR left behind
# is not this run's business. Matching the heading against the PR number would be
# wrong — the declared heading form is `## YYYY-MM-DD — [PR/issue #n — ]<slug>`,
# and real entries use the `issue #n` spelling as often as the `PR #n` one.
#
# The placeholder is looked for in the two FIELDS that declare it, not anywhere in
# the added text. docs/review-feedback.md's own `## Entry format` section quotes
# the literal twice while explaining it, so a PR editing that section — itself a
# plausible humanAlways change — would otherwise be refused with a message about
# an unfilled verdict it does not have. Safe direction, wrong diagnosis, and a
# refusal whose stated reason is false teaches the reader to stop believing it.
#
# What this step reads is the PATH docs/review-feedback.md and the LITERAL
# "pending — filled at merge". Both are owned elsewhere — `.claude/workflow.json`'s
# feedbackLog for the path, docs/review-feedback.md's `## Entry format` for the
# literal — so both are ledgered there (architecture.md rule 9), and this comment
# is the pointer back. The failure direction if either moves without this file:
# the added-lines set comes back empty or the field lines stop matching, and the
# step REFUSES with a message naming the stale path. Loud and closed, never a
# quiet pass.

feedback_state() { # -> 0 entry present and filled; 1 refuse (reason on stdout); 2 unreadable
  local diff rc spool added
  diff=$("$MERGE_PR_GH_CMD" pr diff "$pr_number" 2>&1)
  rc=$?
  if [ "$rc" -ne 0 ]; then
    printf 'gh pr diff exited %s: %s\n' "$rc" "$diff"
    return 2
  fi
  spool=$(mktemp "${TMPDIR:-/tmp}/merge-pr.XXXXXX") || return 2
  printf '%s\n' "$diff" >"$spool"
  # Hunk tracking is what keeps this honest. `+++ b/<path>` is a file header
  # before the first `@@` and an ORDINARY ADDED LINE after it — a diff that adds
  # a line whose text begins `++ ` is spelled exactly that way — so the header
  # rule is guarded on not being inside a hunk rather than on the prefix alone.
  added=$(awk '
    /^diff --git /{ f = ""; hunk = 0; next }
    !hunk && /^\+\+\+ /{ p = $2; sub(/^b\//, "", p); f = p; next }
    !hunk && /^--- /{ next }
    /^@@/{ hunk = 1; next }
    /^\+/{ if (f == target) print substr($0, 2) }
  ' target='docs/review-feedback.md' "$spool")
  rm -f "$spool"

  if [ -z "$added" ]; then
    printf 'the branch adds no lines to docs/review-feedback.md — a humanAlways PR owes an entry there before the label ever goes on\n'
    return 1
  fi
  if ! printf '%s\n' "$added" | grep -q '^## '; then
    printf 'the branch touches docs/review-feedback.md but adds no "## " entry heading\n'
    return 1
  fi

  local fields
  fields=$(printf '%s\n' "$added" | grep -E '^- \*\*(Category|Verdict)\*\*:')
  if ! printf '%s\n' "$fields" | grep -q 'Category'; then
    printf 'the added entry has no "- **Category**:" line — an entry that cannot carry a category cannot record a decision\n'
    return 1
  fi
  if ! printf '%s\n' "$fields" | grep -q 'Verdict'; then
    printf 'the added entry has no "- **Verdict**:" line — the verdict is what the merge is waiting on\n'
    return 1
  fi
  if printf '%s\n' "$fields" | grep -qF 'pending — filled at merge'; then
    printf 'the entry Category or Verdict still reads the literal "pending — filled at merge". A verdict is a human-approved decision and this script will never write one: fill BOTH on the branch, push, then re-run\n'
    return 1
  fi
  return 0
}

if [ "$is_human" = "0" ]; then
  step 'feedback' 'not owed (no humanAlways path in the diff)'
else
  fb_reason=$(feedback_state)
  fb_rc=$?
  case "$fb_rc" in
    0) step 'feedback' 'entry on the branch, both placeholders filled' ;;
    2) fail 'feedback' "$fb_reason" ;;
    *)
      if [ "$already_merged" = "1" ]; then
        # Nothing left to refuse — the merge has happened. Reported rather than
        # enforced, and the run still ends non-zero so the gap is not silent.
        step 'feedback' 'UNFILLED on an already-merged PR (reported below)'
        defer 'feedback' "$fb_reason"
      else
        fail 'feedback' "$fb_reason"
      fi
      ;;
  esac
fi

# --- step: update-branch -----------------------------------------------------------------------
#
# FIRST, per .claude/skills/review-loop/SKILL.md step 5: a green watch on a stale
# head is not a mergeable state, and the bounce costs a whole second CI round to
# discover (#229, #241). "Unconditional" in that sentence means "never skipped
# because a watch looked green" — it is NOT unconditional across merge methods.
#
# A --rebase batch never runs it. `gh pr update-branch` writes a MERGE COMMIT, and
# .claude/skills/run-issue/SKILL.md step 4 says why that is fatal there: a merge
# commit breaks the one-commit-per-member invariant and blocks rebase-merge
# outright, so a batch that is BEHIND or conflicted gets a "curate onto latest
# main" bounce to the branch's owner instead (the same rule is carried by
# .claude/agents/task-orchestrator.md's bounce paragraphs and mirrored in
# docs/design/task-orchestrator.md). Running it anyway would pollute the branch
# first and only then refuse at the merge step — a refusal that costs exactly what
# it exists to prevent.

checks_baseline=0

update_branch_step() {
  local attempt=1 out lower rc
  while [ "$attempt" -le "$MERGE_PR_UPDATE_RETRIES" ]; do
    out=$("$MERGE_PR_GH_CMD" pr update-branch "$pr_number" 2>&1)
    rc=$?
    # Matched against a lowercased copy rather than with `shopt -s nocasematch`:
    # that shell option is global, and a function that leaves it set changes how
    # every later `case` in the script matches.
    lower=$(printf '%s' "$out" | tr '[:upper:]' '[:lower:]')
    if [ "$rc" -eq 0 ]; then
      # gh reports the no-op case on the SUCCESS path ("PR branch already
      # up-to-date"), and the API has also been seen rejecting it as a 422. Both
      # spellings are read here, because which one you get is gh's business and
      # the distinction this step reports is updated-or-not.
      case "$lower" in
        *"already up to date"* | *"already up-to-date"* | *"not behind"*)
          step 'update-branch' 'already up to date with the base'
          ;;
        *) step 'update-branch' "updated onto the base (attempt $attempt)" ;;
      esac
      return 0
    fi
    case "$lower" in
      *"already up to date"* | *"already up-to-date"* | *"not behind"*)
        step 'update-branch' 'already up to date with the base'
        return 0
        ;;
      # The head-sha race. gh drives this through the GraphQL
      # `updatePullRequestBranch` mutation, whose argument is `expectedHeadOid`,
      # while the REST endpoint spells the same thing `expected_head_sha` — so
      # both vocabularies are matched rather than whichever one a given gh build
      # happens to surface. An unmatched spelling falls to the `*)` arm and fails
      # the run, which is the safe direction: a re-run is the repair.
      *"head sha"* | *"head oid"* | *"expected head"* | *"expectedheadoid"* | \
        *"out of date"* | *"stale"*)
        if [ "$attempt" -ge "$MERGE_PR_UPDATE_RETRIES" ]; then
          fail 'update-branch' "the head moved under every one of $MERGE_PR_UPDATE_RETRIES attempts: $out"
        fi
        sleep "$MERGE_PR_RETRY_SECONDS"
        attempt=$((attempt + 1))
        ;;
      *)
        fail 'update-branch' "gh pr update-branch exited $rc: $out"
        ;;
    esac
  done
  fail 'update-branch' "gave up after $MERGE_PR_UPDATE_RETRIES attempts"
}

if [ "$already_merged" = "1" ]; then
  step 'update-branch' 'skipped (PR is already MERGED)'
elif [ "$merge_method" = "--rebase" ]; then
  checks_baseline=${#check_names[@]}
  step 'update-branch' 'skipped — a --rebase batch is curated and force-pushed by its owner, never updated from here (a merge commit would block rebase-merge)'
else
  # The count of checks on the PRE-update head is the floor the post-update head
  # must reach. After an update-branch the rollup is briefly empty or short while
  # the new head's workflows register, and "no check is pending" is trivially true
  # of a rollup with no checks in it yet; the floor is what makes the poll wait for
  # the ones that have not arrived. Derived from this PR rather than from the base
  # branch, because the base branch's workflow set is not this PR's.
  #
  # What the floor does NOT deliver, stated so nobody trusts it for more: it is a
  # floor, not a required-checks list. A head whose PREVIOUS read also had no
  # checks — a PR polled for the first time seconds after its push — yields a floor
  # of 1, so one green check would clear the poll. What stops a merge there is
  # branch protection, which this script deliberately does not restate: the merge
  # runs only from mergeStateStatus CLEAN, and a head missing a required check is
  # BLOCKED, not CLEAN. MERGE_PR_EXPECTED_CHECKS raises the floor for an operator
  # who wants the poll itself to wait rather than the merge step to refuse.
  checks_baseline=${#check_names[@]}
  update_branch_step
fi

# --- step: checks -------------------------------------------------------------------------------

checks_verdict() { # -> ready:<n> | pending:<present>:<expected>:<pending> | failed:<name>:<conclusion>
  local expected i total pending
  expected="$checks_baseline"
  [ "$MERGE_PR_EXPECTED_CHECKS" -gt "$expected" ] && expected="$MERGE_PR_EXPECTED_CHECKS"
  [ "$expected" -lt 1 ] && expected=1
  total=${#check_names[@]}
  pending=0
  for ((i = 0; i < total; i++)); do
    case "${check_conclusions[$i]}" in
      FAILURE | TIMED_OUT | CANCELLED | STARTUP_FAILURE | ACTION_REQUIRED | ERROR)
        printf 'failed:%s:%s\n' "${check_names[$i]}" "${check_conclusions[$i]}"
        return 0
        ;;
    esac
    case "${check_statuses[$i]}" in
      COMPLETED)
        # A COMPLETED check with no conclusion has not settled, and counting it as
        # passing is the one direction this poll must never be wrong in.
        [ -n "${check_conclusions[$i]}" ] || pending=$((pending + 1))
        ;;
      *) pending=$((pending + 1)) ;;
    esac
  done
  if [ "$total" -ge "$expected" ] && [ "$pending" -eq 0 ]; then
    printf 'ready:%s\n' "$total"
    return 0
  fi
  printf 'pending:%s:%s:%s\n' "$total" "$expected" "$pending"
}

if [ "$already_merged" = "1" ]; then
  step 'checks' 'skipped (PR is already MERGED)'
else
  poll_deadline=$((SECONDS + MERGE_PR_POLL_TIMEOUT_SECONDS))
  while :; do
    read_pr || fail 'checks' "$last_error"
    if [ "$pr_state" = "MERGED" ]; then
      # Somebody merged it while we polled. Not an error — the post-merge steps
      # below are exactly what is still owed.
      already_merged=1
      step 'checks' 'PR was merged elsewhere during the poll'
      break
    fi
    verdict=$(checks_verdict)
    case "$verdict" in
      ready:*)
        step 'checks' "${verdict#ready:} check(s) complete on $pr_head_sha, none pending, none failing"
        break
        ;;
      failed:*)
        rest=${verdict#failed:}
        fail 'checks' "check '${rest%:*}' concluded ${rest##*:}"
        ;;
    esac
    if [ "$SECONDS" -ge "$poll_deadline" ]; then
      rest=${verdict#pending:}
      present=${rest%%:*}
      rest=${rest#*:}
      fail 'checks' "timed out after ${MERGE_PR_POLL_TIMEOUT_SECONDS}s — ${present} of an expected ${rest%%:*} check(s) present, ${rest##*:} still pending"
    fi
    sleep "$MERGE_PR_POLL_INTERVAL_SECONDS"
  done
fi

# --- step: merge ---------------------------------------------------------------------------------

if [ "$already_merged" = "1" ]; then
  step 'merge' 'skipped (PR is already MERGED)'
else
  # The curated-history check ran at classify time; re-running it here would read
  # the same commits. What is re-read is the merge state, which the poll may have
  # moved.
  #
  # mergeStateStatus is eventually consistent: GitHub answers UNKNOWN while it is
  # still computing the merge, so that one state is re-read rather than refused —
  # and the loop watches for MERGED as well, because a merged PR ALSO reports
  # UNKNOWN, so a PR merged by someone else during this window would otherwise
  # burn every retry and then fail on a PR that is merged.
  attempt=1
  while [ "$pr_merge_state" = "UNKNOWN" ] && [ "$pr_state" != "MERGED" ] &&
    [ "$attempt" -lt "$MERGE_PR_CONFIRM_RETRIES" ]; do
    sleep "$MERGE_PR_RETRY_SECONDS"
    read_pr || fail 'merge' "$last_error"
    attempt=$((attempt + 1))
  done
fi

if [ "$already_merged" = "0" ] && [ "$pr_state" = "MERGED" ]; then
  already_merged=1
  step 'merge' 'skipped (the PR was merged elsewhere while this run was working)'
elif [ "$already_merged" = "0" ]; then
  if [ "$pr_merge_state" != "CLEAN" ] && [ "$merge_method" = "--rebase" ]; then
    # A batch's repair is never gh pr update-branch — see the update-branch step.
    fail 'merge' "mergeStateStatus is '$pr_merge_state', not CLEAN, and this is a --rebase batch: the repair is a \"curate onto latest main\" bounce to the branch's owner, force-pushed, not an update from here"
  fi
  [ "$pr_merge_state" = "CLEAN" ] || fail 'merge' "mergeStateStatus is '$pr_merge_state', not CLEAN — a merge is only ever taken from CLEAN"

  merge_out=$("$MERGE_PR_GH_CMD" pr merge "$pr_number" "$merge_method" 2>&1)
  merge_rc=$?
  [ "$merge_rc" -eq 0 ] || fail 'merge' "gh pr merge $merge_method exited $merge_rc: $merge_out"

  # Merged is not what gh's exit code says; it is what the PR says.
  attempt=1
  while :; do
    read_pr || fail 'merge' "merged with rc=0 but the state could not be confirmed: $last_error"
    [ "$pr_state" = "MERGED" ] && break
    if [ "$attempt" -ge "$MERGE_PR_CONFIRM_RETRIES" ]; then
      fail 'merge' "gh pr merge exited 0 but the PR is still '$pr_state' after $MERGE_PR_CONFIRM_RETRIES re-reads"
    fi
    attempt=$((attempt + 1))
    sleep "$MERGE_PR_RETRY_SECONDS"
  done
  already_merged=1
  step 'merge' "merged ${merge_method#--} (rc=$merge_rc), state MERGED"
fi

# --- step: label ------------------------------------------------------------------------------
#
# Everything below this line is gated on state == MERGED, which the block above
# either confirmed or short-circuited into. PR #469 took the label off on
# CI-green; this step living after the merge is the whole of that repair.

[ "$pr_state" = "MERGED" ] || fail 'label' "refusing the post-merge steps: the PR is '$pr_state', not MERGED"

has_awaiting=0
for label in ${pr_labels[@]+"${pr_labels[@]}"}; do
  [ "$label" = "awaiting-review" ] && has_awaiting=1
done

if [ "$has_awaiting" = "0" ]; then
  step 'label' "'awaiting-review' not present — nothing to remove"
else
  label_out=$("$MERGE_PR_GH_CMD" pr edit "$pr_number" --remove-label awaiting-review 2>&1)
  label_rc=$?
  [ "$label_rc" -eq 0 ] || fail 'label' "gh pr edit --remove-label exited $label_rc: $label_out"
  step 'label' "'awaiting-review' removed, after the merge"
fi

# --- step: issues -----------------------------------------------------------------------------

if [ "${#pr_closes[@]}" -eq 0 ]; then
  step 'issues' "$merge_reason — nothing to verify"
else
  open_issues=""
  read_failures=""
  for n in "${pr_closes[@]}"; do
    attempt=1
    while :; do
      issue_json=$("$MERGE_PR_GH_CMD" issue view "$n" --json number,state 2>&1)
      issue_rc=$?
      if [ "$issue_rc" -ne 0 ]; then
        read_failures="$read_failures #$n"
        break
      fi
      issue_state=$(printf '%s' "$issue_json" | json_field state)
      [ "$issue_state" = "CLOSED" ] && break
      if [ "$attempt" -ge "$MERGE_PR_CONFIRM_RETRIES" ]; then
        open_issues="$open_issues #$n"
        break
      fi
      attempt=$((attempt + 1))
      sleep "$MERGE_PR_RETRY_SECONDS"
    done
  done
  if [ -n "$read_failures" ]; then
    fail 'issues' "could not read issue(s)${read_failures} — the merge stands; re-run to finish the chain"
  fi
  if [ -n "$open_issues" ]; then
    step 'issues' "still OPEN:${open_issues} (reported below)"
    defer 'issues' "the merge did not close${open_issues} — check the Closes spelling in the PR body, then close them by hand"
  else
    step 'issues' "closed by the merge:$(printf ' #%s' "${pr_closes[@]}")"
  fi
fi

# --- step: worktree ----------------------------------------------------------------------------
#
# Delegated to reap-worktree.sh, which already owns every safety check worth
# having — own-cwd, locked, detached, dirty, min-age, live-session, merge-state —
# and answers KEPT with a reason rather than guessing. The caller's cwd is checked
# here as well, and reap is run FROM that cwd so its own guard sees the same
# truth: a guard that depends on this script not having cd'd is a guard that one
# refactor removes.

worktree_holding() { # worktree_holding <branch> -> that worktree's path on stdout, or nothing
  local list line cur=""
  list=$(git -C "$repo_root" worktree list --porcelain 2>&1) || return 1
  while IFS= read -r line; do
    case "$line" in
      "worktree "*) cur=${line#worktree } ;;
      "branch refs/heads/$1")
        printf '%s\n' "$cur"
        return 0
        ;;
    esac
  done <<EOF
$list
EOF
  return 0
}

wt=$(worktree_holding "$pr_head_ref") || fail 'worktree' "git worktree list failed in $repo_root"

if [ -z "$wt" ]; then
  step 'worktree' "none holds '$pr_head_ref'"
else
  wt=$(canon "$wt") || fail 'worktree' "could not resolve $wt"
  case "$caller_cwd" in
    "$wt" | "$wt"/*)
      step 'worktree' "$wt is the caller's own working directory — not reaped"
      ;;
    *)
      reap_out=$( (cd "$caller_cwd" && bash "$MERGE_PR_REAP_CMD" "$wt") 2>&1)
      reap_rc=$?
      reap_line=${reap_out%%$'\n'*}
      case "$reap_rc" in
        0) step 'worktree' "${reap_line:-reaped $wt}" ;;
        1) step 'worktree' "${reap_line:-kept $wt}" ;;
        *)
          step 'worktree' "reap-worktree.sh exited $reap_rc (reported below)"
          defer 'worktree' "reap-worktree.sh reached no verdict on $wt: ${reap_line:-no output}"
          ;;
      esac
      ;;
  esac
fi

# --- verdict ------------------------------------------------------------------------------------

if [ "${#deferred[@]}" -gt 0 ]; then
  printf 'merge-pr: PR #%s is merged, but the chain did not finish clean:\n' "$pr_number" >&2
  for d in "${deferred[@]}"; do
    printf '  - %s\n' "$d" >&2
  done
  exit 1
fi

step 'done' "PR #$pr_number MERGED — $pr_url"
