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
: "${MERGE_PR_RETRY_SECONDS:=10}"                      # between those attempts, between state re-reads, and after a union push
: "${MERGE_PR_EXPECTED_CHECKS:=0}"                     # a floor the operator can raise; see the checks step
: "${MERGE_PR_CONFIRM_RETRIES:=5}"                     # re-reads allowed for an eventually-consistent state
: "${MERGE_PR_PRETTIER_CMD:=pnpm exec prettier}"       # formatter the tech-debt union re-runs; see that step

# `files` is deliberately NOT in this list. `gh pr view --json files` is
# `files(first: 100)` with no truncation signal, and the humanAlways decision made
# off a silently-truncated file list fails in the one direction that cannot be
# taken back: a PR touching CLAUDE.md as its 120th file would classify AUTO and
# merge without the owner. The file list is read separately and paginated, the
# same endpoint and flags .github/workflows/ci.yml's merge-ritual-gate step uses
# to read the same list (its comment (c) is about why that job needs no checkout,
# which is a different argument — what is borrowed here is the call, not the
# reasoning). `commits` carries the same cap and is left on this list: it feeds
# only the curated-history check, whose first test is a count comparison against
# the Closes count, so a list truncated at 100 refuses rather than merges for any
# PR closing fewer than 100 issues.
PR_JSON_FIELDS='baseRefName,body,commits,headRefName,headRefOid,labels,mergeStateStatus,number,state,statusCheckRollup,url'

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
  put("baseRefName", pr.baseRefName);
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
pr_base_ref=""
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
  pr_base_ref=""
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
      baseRefName) pr_base_ref="$a" ;;
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
# Two independent classifications, and every refusal the MERGE-METHOD one implies
# taken HERE — before update-branch has touched the branch and before the poll has
# spent a CI round. A refusal that arrives at the merge step has already cost what
# it exists to save. (The humanAlways classification's own refusal is the feedback
# step below, which needs a second call to read the diff; it still lands before
# update-branch, which is the property that matters.)

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
# whole PR rather than its first 100 files — the PR_JSON_FIELDS comment above says
# why that matters here.
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

# Deferring either of these to the merge step would mean refusing AFTER
# update-branch had written to the branch and the poll had waited out a full CI
# run — the cost this script exists to save.
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
# the literal while explaining it, so a PR editing that section — itself a
# plausible humanAlways change — would otherwise be refused with a message about
# an unfilled verdict it does not have. Safe direction, wrong diagnosis, and a
# refusal whose stated reason is false teaches the reader to stop believing it.
#
# What this step reads is the PATH docs/review-feedback.md and the LITERAL
# "pending — filled at merge". Both are owned elsewhere — `.claude/workflow.json`'s
# feedbackLog for the path, docs/review-feedback.md's `## Entry format` for the
# literal — so both are ledgered there (architecture.md rule 9), and this comment
# is the pointer back. The two fail in OPPOSITE directions if they move without
# this file, and the difference is the whole reason the ledgers matter:
#
#   - the PATH moving is loud and closed. The awk target finds nothing under the
#     old name, the added-lines set comes back empty, and the step refuses with a
#     message naming the stale path. `is_human` is computed from merge.humanAlways
#     independently, so the refusal still fires on exactly the PRs it should.
#   - the LITERAL moving is a QUIET PASS. The field lines are `- **Category**:`
#     and `- **Verdict**:`, a different string, so they go on matching; only the
#     placeholder test below stops matching, and a gate that stops matching is a
#     gate that opens. Nothing anywhere says so — which is why the ledger in
#     docs/review-feedback.md names this file as the literal's one executable
#     carrier, and why that ledger is the only thing standing between a reworded
#     placeholder and a humanAlways PR merged with no verdict.

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

# --- the docs/tech-debt.md append collision ------------------------------------------------------
#
# Four PRs on 2026-09-11 (#492, #499, #511, #512) arrived DIRTY for one reason:
# every lane appends its SYSTEMIC findings to the tail of docs/tech-debt.md, so any
# two lanes that both log debt collide on the last line. The resolution was the same
# three moves each time — main's appended entries first, the branch's after, markers
# stripped, prettier — and it was done by hand at the merge owner's keyboard, because
# .claude/agents/ticket-agent.md rule 1 forbids the lane from doing it. Issue #513 is
# that resolution, and ONLY that.
#
# The scope is deliberately narrow, and narrow in the refusing direction. What is
# automated is the one collision whose correct answer is arithmetic rather than
# judgement: both sides appended whole entries to the tail, and everything above that
# tail merges on its own. Everything else — a second conflicted file, a side that
# edited the base's last entry or anything else from its final `## ` heading down,
# two sides that changed the region above that heading in ways git cannot reconcile, a
# side that appended into the last entry's body rather than starting a new one — is a
# REFUSAL naming the file and the region, and lands back at
# the merge owner's keyboard exactly as it does today. The cost of refusing wrongly is
# one hand resolution; the cost of unioning wrongly is a silently mangled log that the
# squash merge then makes permanent, which is why every unclear case refuses.
#
# The analysis happens in the repository root and touches no worktree, no branch and
# no commit: nothing a refusal would leave for the merge owner to undo. What it does
# write is a fetch's own writes, plus the unreachable tree merge-tree --write-tree
# leaves behind. (Deliberately not enumerated further. Two passes running, a careful
# list of what a `git fetch` writes has been falsified by one more thing it writes —
# FETCH_HEAD, then the remote-tracking refs — and a claim that cannot be completed is
# better made in the form that does not need completing.) Only once every test has
# passed is anything applied, and then only in the lane's own worktree.
#
# Note for a future rename: this step matches the literal path docs/tech-debt.md and
# is therefore an EXECUTABLE carrier of it, the way the feedback step is for
# docs/review-feedback.md. That path's restatement ledger is the paragraph under
# `# Tech-debt log` in docs/tech-debt.md itself — go there first, and note that the
# harness next door carries the literal too. The failure direction here is at least
# quiet-and-closed rather than quiet-and-open: a renamed log stops conflicting under
# this name, merge-tree reports the new name, and the conflicted-set test refuses
# with that name in the message.

TECH_DEBT_PATH='docs/tech-debt.md'

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

# tech_debt_union_plan <merge-base blob> <base-tip blob> <branch blob> <out-file> <scratch dir>
#   -> 0 the union is written to <out-file>, a one-line summary on stdout
#      1 refused, the reason on stdout
#      2 the question could not be asked at all, the reason on stdout
#
# The whole decision, and none of the consequences. Three blobs are read — the file
# at the merge base (O), at the base tip (A) and at the branch head (B).
#
# #513 tested the WHOLE BLOB: A and B each had to begin with O byte for byte. That is
# a test of the file, and the thing being resolved is a conflict. Its first live run
# (PR #524, issue #525) refused a tail-only collision because #513's own merge had
# added a restatement ledger to this log's header, so main's line 14 no longer matched
# the merge base — a clean, already-merged edit nowhere near the conflict, and the
# strictly-stronger test was strictly stronger than the truth.
#
# What is tested now is the CONFLICT REGION, which is what issue #513 proposed in the
# first place: every conflicted hunk must lie after the base's final `## ` heading,
# and must hold no deletion against the base on either side. Both halves are asked
# through the base's final heading line H, which anchors all three blobs:
#
#   1. H is O's last line starting with `## `, and must appear exactly ONCE in each of
#      O, A and B. A side that no longer holds it has renamed or deleted the base's
#      last entry heading, and there is then no anchor and no tail. Refuse, naming it.
#   2. Split each blob at the start of its H: O = Ohead + Orest, and likewise A and B.
#   3. `git merge-file -p Ahead Ohead Bhead`, over slices written to <scratch dir> —
#      which is the mktemp -d tech_debt_union made, and is a parameter rather than a
#      path derived from <out-file> so that "this function writes nowhere but the
#      scratch directory" is visible in the signature. Exit 0 means the region ABOVE
#      the final heading merges cleanly, so no conflicted hunk lies there: the issue's
#      "every hunk sits after the base's final `## ` heading", asked of the merger
#      rather than reconstructed from marker line numbers. A conflict count back from
#      merge-file is the refusal; a failure to run it at all is rc 2, and the two are
#      kept apart because one is an answer and the other is a broken question.
#   4. Orest must be an exact string prefix of Arest and of Brest. Within the region
#      the hunks live in, that is the issue's "no `-` lines against the base on either
#      side", plus a narrowing: additions must come at the END of that region rather
#      than spliced into the base's last entry. A side that is not an extension gets
#      the first line it changed, and H — which is the only `## ` heading Orest can
#      contain — because "docs/tech-debt.md conflicts" is not something a merge owner
#      can act on.
#
# So the refusal #513 wrote for "a side edited text the base already had" has NARROWED,
# deliberately and in exactly one direction: from the whole file to the region from H
# down. An edit above H is now the merger's business, and step 3 is where it is settled.
#
# Why not parse merge-file's own markers and map the hunks back to base line numbers:
# `-p` output carries none, and the hunk that matters here — both sides appending at
# EOF — has an EMPTY base section, so its position in the base is exactly the thing
# that cannot be recovered from the output. Asking the merger about the head region
# decides the same question with the answer it does give.
#
# Each tail must then OPEN A NEW `## ` ENTRY, and this survives the change to the
# region test rather than being subsumed by it — sitting after the base's final
# heading is PRECISELY what a body-continuation append does. The reason is a shape
# this log has already recorded about itself (its 2026-09-11 entry "An Update appended
# to a sweep-defined entry joins that entry's own sweep"): text appended at EOF with
# no heading of its own extends the LAST EXISTING ENTRY, and concatenating the two
# sides would then interleave one entry's body with another entry's heading. Whole
# entries or nothing.
tech_debt_union_plan() {
  node -e '
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const [oPath, aPath, bPath, outPath, scratch, target] = process.argv.slice(1);

const say = (code, msg) => {
  process.stdout.write(msg + "\n");
  process.exit(code);
};
const refuse = (msg) => say(1, msg);

let O, A, B;
try {
  O = fs.readFileSync(oPath, "utf8");
  A = fs.readFileSync(aPath, "utf8");
  B = fs.readFileSync(bPath, "utf8");
} catch (e) {
  say(2, "could not read the three " + target + " blobs: " + e.message);
}

// No base copy means the file was ADDED on both sides. There is no common prefix to
// append to, so "keep both tails" has no meaning here and the union is a guess.
if (O.length === 0) {
  refuse(
    target +
      ": the merge base has no copy of this file, so neither side is an append to a shared tail — nothing here is arithmetic"
  );
}
if (!O.endsWith("\n")) {
  refuse(
    target +
      ": the merge-base copy does not end with a newline, so an appended entry does not start on a line of its own"
  );
}

const baseLines = O.split("\n");
let anchorAt = -1;
for (let i = baseLines.length - 1; i >= 0; i--) {
  if (baseLines[i].startsWith("## ")) {
    anchorAt = i;
    break;
  }
}
if (anchorAt < 0) {
  refuse(
    target +
      ": the merge-base copy holds no \"## \" entry heading — this is not the append-only log this step knows how to union"
  );
}
// H anchors all three blobs. It has to name exactly one place in each of them, so a
// log that repeats a heading line verbatim is refused rather than split at a guess.
const H = baseLines[anchorAt];
const occurrences = (lines) => lines.filter((l) => l === H).length;
if (occurrences(baseLines) !== 1) {
  refuse(
    target +
      ": the merge-base copy holds " +
      occurrences(baseLines) +
      " lines reading " +
      JSON.stringify(H) +
      " — the tail is anchored on the final entry heading, and a heading repeated verbatim anchors nothing"
  );
}

// Character offset of the start of line <n>, in a text split into <lines>.
const offsetOfLine = (lines, n) => lines.slice(0, n).reduce((a, l) => a + l.length + 1, 0);

const headEnd = offsetOfLine(baseLines, anchorAt);
const oHead = O.slice(0, headEnd);
const oRest = O.slice(headEnd);

// The same cut in a side, made at ITS copy of H rather than at a line number: the
// point of the change is that a side may legitimately have grown or shrunk above H.
const cutAtAnchor = (text, side) => {
  const lines = text.split("\n");
  const n = occurrences(lines);
  if (n === 0) {
    refuse(
      target +
        ": the " +
        side +
        " side no longer holds the line " +
        JSON.stringify(H) +
        ", which is the final entry heading of the merge base and the line this step anchors the tail on — that side has rewritten or removed an entry the base already had"
    );
  }
  if (n > 1) {
    refuse(
      target +
        ": the " +
        side +
        " side holds " +
        n +
        " lines reading " +
        JSON.stringify(H) +
        ", so the merge base final entry heading no longer names one place in it and the tail cannot be cut off"
    );
  }
  const at = offsetOfLine(lines, lines.indexOf(H));
  return [text.slice(0, at), text.slice(at)];
};

const [aHead, aRest] = cutAtAnchor(A, "base");
const [bHead, bRest] = cutAtAnchor(B, "branch");

// The region ABOVE the anchor, put to the merger itself. A clean edit there — one
// side, or both in places git can reconcile — is not this collision and must not
// refuse; a conflict there is, and does. Slices go to the scratch directory the
// caller passed, which is the one place this function is allowed to write.
const slice = (name, text) => {
  const p = path.join(scratch, name);
  fs.writeFileSync(p, text);
  return p;
};
let mergedHead;
try {
  mergedHead = execFileSync(
    "git",
    [
      "merge-file",
      "-p",
      "--quiet",
      slice("head-base", aHead),
      slice("head-merge-base", oHead),
      slice("head-branch", bHead),
    ],
    // maxBuffer is declared rather than defaulted: the head slice is almost the whole
    // log (H sits near EOF), the log only grows between triage passes, and Node caps
    // a child at 1 MiB unless told otherwise. Past the ceiling execFileSync throws
    // with status null, which lands on say(2) — the safe direction, but a refusal
    // whose reason is a buffer size is a bad afternoon for whoever reads it.
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }
  );
} catch (e) {
  // git merge-file exits with the number of conflicts it left, and with something
  // >= 128 when it could not run at all — a distinction worth keeping, because the
  // first is an answer and the second is a broken question.
  if (typeof e.status === "number" && e.status > 0 && e.status < 128) {
    refuse(
      target +
        ": the region above " +
        JSON.stringify(H) +
        " — the final entry heading of the merge base — does not merge: git merge-file leaves " +
        e.status +
        " conflict(s) there. This step unions tail appends, and only when everything above the tail merges on its own"
    );
  }
  say(2, "could not merge the region above " + JSON.stringify(H) + " in " + target + ": " + e.message);
}
// mergedHead needs no trailing-newline check before oRest is concatenated onto it:
// all three slices are cut at a line start, so each is either empty or ends in a
// newline, and merge-file over newline-terminated inputs answers in kind.

// H is the LAST "## " line of O and oRest starts at it, so H is the only entry heading
// oRest can contain — every line the test below can object to falls under it.
const restLines = oRest.split("\n");

const mustExtend = (rest, side) => {
  if (rest.startsWith(oRest)) return;
  // Where the two first disagree. The loop always stops below restLines.length once
  // startsWith has failed: a side matching every line INCLUDING the empty element
  // after the trailing newline necessarily begins with oRest, which is the case above.
  const lines = rest.split("\n");
  const n = Math.min(lines.length, restLines.length);
  let i = 0;
  while (i < n && lines[i] === restLines[i]) i++;
  refuse(
    target +
      ": the " +
      side +
      " side " +
      (i >= lines.length ? "deletes" : "changes") +
      " line " +
      (anchorAt + i + 1) +
      " of the merge-base copy, under the entry " +
      JSON.stringify(H) +
      " — from that final heading down, this step unions tail appends and never an edit to text the base already had"
  );
};

mustExtend(aRest, "base");
mustExtend(bRest, "branch");

const entriesIn = (tail) => tail.split("\n").filter((l) => l.startsWith("## ")).length;

const mustOpenAnEntry = (tail, side) => {
  if (tail.length === 0) return; // that side appended nothing; the union is the other tail
  if (!tail.endsWith("\n")) {
    refuse(
      target +
        ": the " +
        side +
        " side appends a tail that does not end with a newline, so concatenating the two sides would run that tail into the line the other one starts with"
    );
  }
  const lines = tail.split("\n");
  let k = 0;
  while (k < lines.length && lines[k].trim() === "") k++;
  if (k >= lines.length) {
    refuse(target + ": the " + side + " side appends only blank lines");
  }
  if (!lines[k].startsWith("## ")) {
    refuse(
      target +
        ": the " +
        side +
        " side appends " +
        JSON.stringify(lines[k]) +
        " with no \"## \" heading of its own, which extends the last existing entry rather than starting a new one — this step unions whole entries only"
    );
  }
};

const aTail = aRest.slice(oRest.length);
const bTail = bRest.slice(oRest.length);
mustOpenAnEntry(aTail, "base");
mustOpenAnEntry(bTail, "branch");

// The order is the rule the four hand resolutions used: main first, the branch after.
// The head region is whatever the merger made of it, which is how an edit above the
// anchor survives the resolution instead of being silently reverted to the base.
try {
  fs.writeFileSync(outPath, mergedHead + oRest + aTail + bTail);
} catch (e) {
  say(2, "could not write the union: " + e.message);
}
say(
  0,
  "base appended " +
    entriesIn(aTail) +
    " entr(ies), the branch " +
    entriesIn(bTail) +
    (mergedHead === oHead
      ? ""
      : "; the region above the final base entry heading had moved and merged cleanly")
);
' "$1" "$2" "$3" "$4" "$5" "$TECH_DEBT_PATH"
}

union_reason=""
union_summary=""
union_new_sha=""

union_abort() { # union_abort <worktree> <scratch dir> <reason> — undo and refuse
  git -C "$1" merge --abort >/dev/null 2>&1
  rm -rf "$2"
  union_reason="$3"
}

# tech_debt_union -> 0 resolved, committed and pushed; 1 refused with $union_reason set.
# Split from the plan function above on the read-only/writing line: everything that
# can say no happens before this function touches anything.
tech_debt_union() {
  local base_sha merge_base tip wt out rc dir conflicted status subject line past_oid
  local seen_paths prettier_cmd
  seen_paths=()
  past_oid=0
  union_reason=""
  union_summary=""

  [ -n "$pr_base_ref" ] || {
    union_reason="gh reported no base branch for this PR, so there is nothing to union against"
    return 1
  }

  # The base by its full ref, so FETCH_HEAD names exactly one thing, and its sha read
  # once and used everywhere after: a second rev-parse could answer a different commit
  # if another process fetches between the two.
  out=$(git -C "$repo_root" fetch --quiet origin "refs/heads/$pr_base_ref" 2>&1)
  rc=$?
  [ "$rc" -eq 0 ] || {
    union_reason="could not fetch the base branch '$pr_base_ref' (git fetch exited $rc): $out"
    return 1
  }
  base_sha=$(git -C "$repo_root" rev-parse FETCH_HEAD 2>&1) || {
    union_reason="could not resolve the fetched base branch '$pr_base_ref': $base_sha"
    return 1
  }

  # The lane's worktree, resolved from the branch exactly as the worktree step does.
  # No worktree means there is nowhere to do this that is not somebody else's checkout,
  # and creating one would make this step the owner of a lifecycle it does not own.
  wt=$(worktree_holding "$pr_head_ref") || {
    union_reason="git worktree list failed in $repo_root"
    return 1
  }
  [ -n "$wt" ] || {
    union_reason="no worktree holds '$pr_head_ref' — this resolution is committed on the branch, and there is nowhere to do that without checking it out somewhere it does not belong"
    return 1
  }
  wt=$(canon "$wt") || {
    union_reason="could not resolve the worktree path for '$pr_head_ref'"
    return 1
  }

  # Dirty means somebody's uncommitted work is in there. A merge would either refuse
  # halfway or sweep it into the resolution commit, and neither is this script's to do.
  status=$(git -C "$wt" --no-optional-locks status --porcelain 2>&1)
  rc=$?
  [ "$rc" -eq 0 ] || {
    union_reason="could not read the status of $wt (git status exited $rc): $status"
    return 1
  }
  [ -z "$status" ] || {
    union_reason="the worktree at $wt is not clean — refusing to touch a tree holding somebody's uncommitted work: $(printf '%s' "$status" | tr '\n' '; ')"
    return 1
  }

  # What is on disk must be what GitHub is talking about. If the lane pushed a commit
  # this checkout has not got — or never pushed one it has — the union would be
  # computed against a branch nobody is merging, and the lease below would be a lease
  # on the wrong sha.
  tip=$(git -C "$wt" rev-parse HEAD 2>&1) || {
    union_reason="could not read HEAD in $wt: $tip"
    return 1
  }
  [ "$tip" = "$pr_head_sha" ] || {
    union_reason="the worktree at $wt is on $tip but the PR's head is $pr_head_sha — refusing to resolve a branch this checkout and GitHub do not agree about. If $tip is a resolution an earlier run committed and failed to push, push it by hand and re-run"
    return 1
  }

  # The conflicted set, without a checkout: merge-tree does the whole merge in the
  # object store. rc 0 means git can merge these two cleanly, so whatever
  # update-branch was complaining about is not a conflict this step can see, and
  # guessing at it is exactly what this step must not do.
  conflicted=$(git -C "$repo_root" merge-tree --write-tree --name-only "$base_sha" "$tip" 2>&1)
  rc=$?
  case "$rc" in
    0)
      union_reason="git merge-tree merges '$pr_base_ref' into this branch cleanly, so the conflict gh reported is not one this step can see or resolve"
      return 1
      ;;
    1) ;;
    *)
      union_reason="git merge-tree exited $rc: $conflicted"
      return 1
      ;;
  esac

  # merge-tree --write-tree prints the merged tree's oid, then one line per conflicted
  # path, then a blank line, then its informational messages. Only the middle section
  # is the conflicted set, so the read stops at the blank line rather than swallowing
  # "CONFLICT (content): Merge conflict in …" as a filename.
  while IFS= read -r line; do
    if [ "$past_oid" = "0" ]; then
      past_oid=1
      continue
    fi
    [ -n "$line" ] || break
    seen_paths+=("$line")
  done <<EOF
$conflicted
EOF

  if [ "${#seen_paths[@]}" -ne 1 ] || [ "${seen_paths[0]}" != "$TECH_DEBT_PATH" ]; then
    union_reason="the conflicted set is$(printf ' %s' ${seen_paths[@]+"${seen_paths[@]}"}) — this step resolves $TECH_DEBT_PATH and only $TECH_DEBT_PATH, alone"
    return 1
  fi

  merge_base=$(git -C "$repo_root" merge-base "$base_sha" "$tip" 2>&1) || {
    union_reason="could not find the merge base of '$pr_base_ref' and '$pr_head_ref': $merge_base"
    return 1
  }

  dir=$(mktemp -d "${TMPDIR:-/tmp}/merge-pr-union.XXXXXX") || {
    union_reason="could not create a scratch directory for the union"
    return 1
  }
  # `git show` of a path that does not exist at that commit exits non-zero and writes
  # nothing; an empty base blob is a case tech_debt_union_plan refuses by name, so the
  # failure is allowed through to it rather than handled twice.
  git -C "$repo_root" show "$merge_base:$TECH_DEBT_PATH" >"$dir/base" 2>/dev/null
  git -C "$repo_root" show "$base_sha:$TECH_DEBT_PATH" >"$dir/a" 2>/dev/null
  git -C "$repo_root" show "$tip:$TECH_DEBT_PATH" >"$dir/b" 2>/dev/null

  out=$(tech_debt_union_plan "$dir/base" "$dir/a" "$dir/b" "$dir/union" "$dir")
  rc=$?
  if [ "$rc" -ne 0 ]; then
    union_reason="$out"
    rm -rf "$dir"
    return 1
  fi
  union_summary="$out"

  # ---- from here on the worktree is being written to; every failure runs union_abort,
  # which puts the tree back the way it was found before it refuses.

  # --no-ff, because this is precisely the merge commit `gh pr update-branch` would
  # have written had it been able to resolve the conflict itself.
  out=$(git -C "$wt" -c core.commentChar=';' merge --no-ff --no-commit "$base_sha" 2>&1)
  rc=$?
  if [ "$rc" -eq 0 ]; then
    union_abort "$wt" "$dir" "git merge of '$pr_base_ref' into '$pr_head_ref' reported no conflict, which contradicts what merge-tree just said — refusing rather than committing a merge nobody analysed"
    return 1
  fi

  conflicted=$(git -C "$wt" diff --name-only --diff-filter=U 2>&1)
  if [ "$conflicted" != "$TECH_DEBT_PATH" ]; then
    union_abort "$wt" "$dir" "the merge left $(printf '%s' "$conflicted" | tr '\n' ' ')unresolved, not $TECH_DEBT_PATH alone — the tree moved under the analysis"
    return 1
  fi

  cat "$dir/union" >"$wt/$TECH_DEBT_PATH" || {
    union_abort "$wt" "$dir" "could not write the union into $wt/$TECH_DEBT_PATH"
    return 1
  }

  # Prettier, because format:check is part of `pnpm verify` and a resolution that
  # reddens it just moves the merge owner's work rather than removing it. Read into an
  # array so the knob can carry arguments without this line word-splitting a variable.
  read -r -a prettier_cmd <<<"$MERGE_PR_PRETTIER_CMD"
  out=$( (cd "$wt" && "${prettier_cmd[@]}" --write "$TECH_DEBT_PATH") 2>&1)
  rc=$?
  if [ "$rc" -ne 0 ]; then
    union_abort "$wt" "$dir" "prettier exited $rc over $TECH_DEBT_PATH: $out"
    return 1
  fi

  # The marker sweep .claude/skills/review-loop/SKILL.md step 5 requires of every
  # conflict resolution, in both of its spellings — the ERE grep and `git diff HEAD
  # --check`, which reads staged and unstaged content alike and so speaks whether or
  # not the resolved file has been added yet. The union is built from whole blobs
  # rather than from merge-file output, so a marker here would mean the resolution is
  # not what this step thinks it is.
  if grep -nE '^(<<<<<<<|=======|>>>>>>>)' "$wt/$TECH_DEBT_PATH" >/dev/null 2>&1; then
    union_abort "$wt" "$dir" "the resolved $TECH_DEBT_PATH still holds conflict markers — refusing to commit it"
    return 1
  fi

  out=$(git -C "$wt" add -- "$TECH_DEBT_PATH" 2>&1) || {
    union_abort "$wt" "$dir" "could not stage the resolved $TECH_DEBT_PATH: $out"
    return 1
  }

  out=$(git -C "$wt" diff HEAD --check 2>&1)
  rc=$?
  if [ "$rc" -ne 0 ]; then
    union_abort "$wt" "$dir" "git diff HEAD --check rejected the resolution: $out"
    return 1
  fi

  # Both overrides, and the real reason for each — measured on git 2.50.1 rather than
  # carried over from the rebase rule, which is about a different mechanism:
  #
  #   - commit.cleanup=strip so the message does not depend on repo-local config. The
  #     `prepare` script in package.json writes commit.cleanup=whitespace, and a clone
  #     that has not run it has git's own default instead. `-m` defaults to whitespace
  #     either way today, so this is belt and braces, not a repair.
  #   - core.commentChar=';' because it MUST travel with strip. Every commit subject
  #     here begins '#<issue>', strip deletes comment lines, and
  #     `git -c commit.cleanup=strip commit -m '#513: …'` aborts with "empty commit
  #     message" — the subject is the whole message. With the swap it survives.
  #
  # What this pairing is NOT: it is not the rebase trap. `commit -m` never reads
  # MERGE_MSG, so there is no ';'-prefixed Conflicts block here to preserve — that is
  # .claude/skills/review-loop/SKILL.md step 5's rule, about `rebase`, and the artifact
  # it warns of is recorded in docs/friction-log.md's 2026-08-11 entry (#366's
  # commentChar repair), not its 2026-09-11 one.
  #
  # This commit runs the repo's own pre-commit hook, and that is a dependency worth
  # naming rather than discovering: .githooks/pre-commit hard-fails without gitleaks and
  # without node_modules, and runs lint-staged over the WHOLE staged index — which,
  # mid-merge, is every file the base brought in, not the one file resolved here. It
  # fails in the safe direction (a non-zero commit reaches union_abort and the run
  # refuses), but it does make the one-invocation path conditional on the lane
  # worktree's toolchain, and the operator meets the hook's own text wrapped in "could
  # not commit the resolution". --no-verify is deliberately not used: this commit puts
  # somebody else's merged content into a tree, and a secret scan is the one check that
  # is cheaper to run than to skip.
  #
  # The '#<issue>:' prefix is the repo's subject form, and it is conditional because the
  # Closes list can legitimately be empty here: a PR with no Closes line reaches the
  # merge steps only under an explicit --method, and classify has already refused it
  # otherwise. An empty array indexed under `set -u` aborts the run, which would turn a
  # resolvable collision into a crash with a merge left in progress.
  subject="$TECH_DEBT_PATH — union with '$pr_base_ref' (both sides appended entries)"
  [ "${#pr_closes[@]}" -gt 0 ] && subject="#${pr_closes[0]}: $subject"
  out=$(git -C "$wt" -c core.commentChar=';' -c commit.cleanup=strip commit -m "$subject" 2>&1)
  rc=$?
  if [ "$rc" -ne 0 ]; then
    union_abort "$wt" "$dir" "could not commit the resolution (git commit exited $rc): $out"
    return 1
  fi

  # A lease, never a bare --force. The push is a fast-forward — the branch only gained
  # a merge commit — so the lease is not what makes it legal; it is what makes it
  # REFUSE if the remote moved while the analysis ran, which is the one way the whole
  # decision above could have been taken against a branch that no longer exists. The
  # expected value is GitHub's own headRefOid, not a remote-tracking ref, so it does
  # not depend on this checkout having fetched recently.
  out=$(git -C "$wt" push --force-with-lease="$pr_head_ref:$pr_head_sha" \
    origin "HEAD:refs/heads/$pr_head_ref" 2>&1)
  rc=$?
  if [ "$rc" -ne 0 ]; then
    # NOT aborted: the merge is already committed, and `git merge --abort` has nothing
    # left to undo. This is also the one failure a bare re-run does NOT repair, which is
    # the opposite of how the rest of this script behaves and so is said out loud: the
    # worktree tip is now the resolution commit while GitHub still answers the old head,
    # so the tip guard above refuses the next run with a message about a disagreement
    # rather than about this push. The repair is to push the branch by hand and re-run.
    rm -rf "$dir"
    union_reason="the resolution is committed on '$pr_head_ref' but the push failed (git push exited $rc). A re-run will NOT retry it — push $wt by hand, then re-run: $out"
    return 1
  fi

  # The sha the resolution put on the branch. update_branch_step needs it: if the
  # retried update-branch WRITES rather than answering the no-op, the head it replaced
  # is this one and not the head read at classify time.
  union_new_sha=$(git -C "$wt" rev-parse HEAD 2>/dev/null)

  rm -rf "$dir"
  return 0
}

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

# What the checks step needs from this one: the heads this run is replacing,
# whether they were replaced at all, and the answer that claimed so. GitHub goes on
# answering the old sha and the old rollup after the write lands (the checks step
# says why that matters), so "is this still one of the heads we superseded" is what
# separates the stale answer from the fresh one — and gh's own words are what tell
# a head that has not moved YET from one that was never going to.
#
# TWO shas, not one, and the plural is load-bearing. A run can supersede a head
# twice: the tech-debt union pushes over the head read at classify time, and a
# retried update-branch can then write over the union's own head. The gate is an
# inequality, so excluding only the LATEST superseded sha leaves the earlier one
# admissible — and the earlier one is exactly what a lagging GitHub answers. That
# is not hypothetical: it is what the first version of this fix did, and a probe
# case caught the run taking its merge on the pre-union head's rollup. Both are
# excluded, and superseded_union_sha stays empty on every run that did not union.
pre_update_sha=""
superseded_union_sha=""
await_new_head=0
update_answer=""

# The tech-debt union is attempted AT MOST ONCE per run. A second conflict after a
# resolution that reported success means either main moved again — which a re-run
# handles, and which this run has no budget to chase — or the step resolved something
# other than what update-branch was complaining about. Retrying either would spend
# attempts on a loop with no end, so the second conflict fails the run and the message
# says so.
union_attempted=0

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
        *)
          await_new_head=1
          update_answer=${out%%$'\n'*}
          # A write after a tech-debt resolution replaced the sha that resolution
          # pushed, so that sha joins the superseded set — ADDED to it, never swapped
          # for the classify-time head, which GitHub can still be answering.
          [ -n "$union_new_sha" ] && superseded_union_sha="$union_new_sha"
          step 'update-branch' "updated onto the base (attempt $attempt)"
          ;;
      esac
      return 0
    fi
    case "$lower" in
      *"already up to date"* | *"already up-to-date"* | *"not behind"*)
        step 'update-branch' 'already up to date with the base'
        return 0
        ;;
      # The conflicted update. GitHub answers this 422 when the base and the head have
      # both changed the same region, and by far the commonest instance here is the one
      # #513 is about: two lanes that both appended an entry to docs/tech-debt.md.
      #
      # Matching on the bare word is broad on purpose, in the only direction it can be
      # safely broad: every arm here leads either to the union step — which makes its
      # own decision from scratch, against git rather than against this message, and
      # refuses everything it is not certain of — or to the `*)` arm, which fails the
      # run. A spelling matched wrongly costs one merge-tree call and a refusal; a
      # spelling NOT matched falls through to `*)` and fails, which is where this was
      # before the step existed.
      *"conflict"* | *"not mergeable"*)
        if [ "$union_attempted" = "1" ]; then
          fail 'update-branch' "gh reports a conflict again after the $TECH_DEBT_PATH resolution this run already pushed. Either the base moved under it, in which case re-run, or the conflict was never the one that step resolves — gh said: $out"
        fi
        union_attempted=1
        step 'update-branch' "gh reports a conflict; asking whether it is the $TECH_DEBT_PATH append collision"
        if ! tech_debt_union; then
          fail 'update-branch' "the conflict is not one this script may resolve: $union_reason"
        fi
        # The head has moved, and the gate that makes the checks step wait for it is
        # armed HERE rather than left to the next attempt. Without this, the retry below
        # answers "already up to date" — correctly, the branch now contains the base —
        # and every read after it is evaluated against whatever head GitHub is still
        # caching, which is PR #501's defect reached through a different door.
        await_new_head=1
        pre_update_sha="$pr_head_sha"
        update_answer="merge-pr resolved the $TECH_DEBT_PATH append collision on the branch and pushed it"
        step 'update-branch' "$TECH_DEBT_PATH unioned and pushed ($union_summary); re-running update-branch"
        # No attempt is consumed. The attempt budget bounds the head-sha race; this arm
        # is bounded by union_attempted, which allows exactly one pass through it. Taking
        # an attempt here would make MERGE_PR_UPDATE_RETRIES=1 fall out of the loop with
        # "gave up after 1 attempts" AFTER a resolution it had successfully pushed.
        #
        # The wait is the same one the head-sha arm takes, for the same reason: gh has
        # just been told about a push and answers the mergeability it computed before
        # it. An update-branch issued in the same second can come back 422 on the state
        # it is replacing, and union_attempted would turn that into a hard failure
        # rather than a retry — losing the one-invocation property this step exists for.
        # The harness pins the interval to 0, so no case waits.
        sleep "$MERGE_PR_RETRY_SECONDS"
        ;;
      # The head-sha race, in every spelling it is known to arrive in. The REST
      # endpoint's documented 422 is `expected_head_sha didn't match pull request
      # head.` — UNDERSCORES, which is why `head sha` with a space never matched
      # it and an arm written only that way would have failed the run on the
      # exact race this loop exists for. gh also drives the same update through
      # the GraphQL `updatePullRequestBranch` mutation, whose argument is
      # `expectedHeadOid`, so that vocabulary is matched too. An unmatched
      # spelling still falls to the `*)` arm and fails the run, which is the safe
      # direction: a re-run is the repair.
      *"expected_head_sha"* | *"head_sha"* | *"head sha"* | *"head oid"* | \
        *"expectedheadoid"* | *"expected head"* | *"out of date"* | *"stale"*)
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
  pre_update_sha="$pr_head_sha"
  update_branch_step
fi

# --- step: checks -------------------------------------------------------------------------------
#
# An update-branch that wrote is not visible at once: for the window
# .claude/skills/review-loop/SKILL.md step 5 names — it names the same trap for the
# hand-typed chain — `gh pr view` still answers the PREVIOUS head's sha, that
# head's rollup, and BLOCKED, and every verdict this step and the merge step take
# reads one of those three. On PR #501 the answer was the old head's checks,
# complete and none pending, so the baseline floor was satisfied by a rollup
# belonging to a commit that no longer existed, and the merge step then refused on
# the BLOCKED that came with it. A re-run 90 s later merged. The floor cannot catch
# this on its own: the stale rollup has the same count as the head it came from.
#
# So nothing is evaluated until every sha this run superseded is gone — which shas
# those are is the update-branch step's business, stated where pre_update_sha and
# superseded_union_sha are declared, and deliberately not re-argued here. Bounded by
# the same poll budget the checks themselves get. A head that never moves is REFUSED
# rather than merged on: the alternative reading — clear the gate on a CLEAN
# unmoved read, since the stale answer is BLOCKED — turns one observation into a
# gate, and gets a merge taken on a head whose checks nobody looked at when it is
# wrong. The refusal costs a re-run, which is the direction this script is wrong in
# everywhere else, and it quotes gh's answer because the OTHER cause of an unmoved
# head is a no-op spelling the arm above does not know.

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
  verdict=""
  while :; do
    read_pr || fail 'checks' "$last_error"
    if [ "$pr_state" = "MERGED" ]; then
      # Somebody merged it while we polled. Not an error — the post-merge steps
      # below are exactly what is still owed.
      already_merged=1
      step 'checks' 'PR was merged elsewhere during the poll'
      break
    fi
    if [ "$await_new_head" = "1" ] && [ "$pr_head_sha" != "$pre_update_sha" ] &&
      { [ -z "$superseded_union_sha" ] || [ "$pr_head_sha" != "$superseded_union_sha" ]; }; then
      await_new_head=0
      step 'checks' "the update moved the head ${pre_update_sha}${superseded_union_sha:+/$superseded_union_sha} -> $pr_head_sha; reading that head"
    fi
    if [ "$await_new_head" = "0" ]; then
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
    fi
    if [ "$SECONDS" -ge "$poll_deadline" ]; then
      [ "$await_new_head" = "0" ] || fail 'checks' \
        "timed out after ${MERGE_PR_POLL_TIMEOUT_SECONDS}s — gh answered \"$update_answer\", which this step read as a write, but the head still reads $pr_head_sha, one of the sha(s) this run superseded (${pre_update_sha}${superseded_union_sha:+, $superseded_union_sha}), so every check and merge state here is a replaced head's. Either the update has not landed yet (re-run), or that answer is a no-op spelling update-branch does not recognise, in which case the branch is already current and the spelling belongs in that step's no-op arm"
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
  # still computing the merge, so that one state is re-read rather than refused.
  # The MERGED arm leaves the loop early rather than deciding anything — a merged
  # PR also answers UNKNOWN, so without it a PR merged elsewhere during this
  # window sleeps out every remaining retry before the block below reaches the
  # same verdict. Time, not correctness: the guard on that block is what decides.
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
  # The bounce is prescribed only for the two states it is the repair for. The
  # rule is scoped that way at both its carriers — run-issue step 4 and
  # docs/design/task-orchestrator.md both say "a batch that is BEHIND or
  # conflicted" — and the scoping is load-bearing rather than pedantic: BLOCKED
  # (branch protection), UNKNOWN (GitHub still computing) and DRAFT all reach this
  # point too. The residual, so nobody rediscovers it as a bug: a batch that is
  # BOTH stale and blocked reports BLOCKED, so it falls through to the generic
  # refusal and is told its state with no repair named. It is never merged; the
  # merge owner reads the state and finds the second blocker. Prescribing a
  # force-push bounce for BLOCKED was the worse of the two errors. And telling a
  # merge owner to bounce an agent into a
  # rebase-and-force-push when the blocker is a required review is walking them
  # into a wrong and expensive repair. Everything else falls to the generic
  # refusal below, which names the state and prescribes nothing.
  if [ "$merge_method" = "--rebase" ]; then
    case "$pr_merge_state" in
      BEHIND | DIRTY)
        fail 'merge' "mergeStateStatus is '$pr_merge_state' and this is a --rebase batch: the repair is a \"curate onto latest main\" bounce to the branch's owner, force-pushed, never an update from here — gh pr update-branch would write a merge commit and block the rebase-merge outright"
        ;;
    esac
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
#
# worktree_holding is defined above, beside the tech-debt union step: that step
# runs during update-branch and resolves the lane's worktree the same way, and a
# helper cannot be defined after its first caller.

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
