# Proposal: per-issue task-orchestrator (Opus), top-level session as merge owner

Design record for
[#336 — adopt the task-orchestrator workflow](https://github.com/TomBennett-Lloyd/cumulo/issues/336),
covering the delegated orchestration layer: what one task-orchestrator owns for its ticket set,
what the top-level session keeps, and the report contracts between them.

**Approved by the owner 2026-08-10**
([pre-approval comment](https://github.com/TomBennett-Lloyd/cumulo/issues/336#issuecomment-5234760505))
**and adopted by the commit that added this file** (`4faeba7`), which holds the body as reviewed.
The body below keeps it, trued in place where a carried value moved and less the copies the third
amendment below cuts, so where it calls itself a proposal, calls its drafts drafts, or describes
itself as draft for owner review and final pending that review, it is describing its state at
review time, not its state now.

This document is the rationale and the record of the decisions; the operative copies are
[`.claude/agents/task-orchestrator.md`](../../.claude/agents/task-orchestrator.md) and
[`.claude/skills/run-issue/SKILL.md`](../../.claude/skills/run-issue/SKILL.md), with the mode in
`.claude/workflow.json`'s `orchestration` block, along with the boundary one-liners §9.3 places in
`.claude/skills/execute/SKILL.md`, `.claude/skills/review-loop/SKILL.md`,
`.claude/skills/retro/SKILL.md` and the `CLAUDE.md` Workflow bullet. Where this document and those
files disagree, the files win — they are the ones the agents read.

One amendment was made at adoption and is deliberately not folded into the body: **the agent
file's must-NOT list sanctions worktree-lifecycle writes** — `git worktree add`, and
`git worktree prune` on its documented recovery path, both per `execute` step 1 — as a second
main-checkout exception alongside the read-only `git -C <main-checkout> pull`. Found in review:
as written, §8's "never write to the main checkout" forbade the first thing `execute` step 1 tells
a task-orchestrator to do, so an agent reading the list as a hard rule would have had to refuse
its own first step or learn that the list can be broken.

A second amendment, later and larger, and likewise not folded into the body: since
`.claude/workflow.json` → `orchestration.mode` became `ticket-agent` on 2026-09-10 (#468), a
single issue takes the ticket-agent lane (`.claude/agents/ticket-agent.md`) and this design
governs batches. Where the body below describes a single issue's delegated run in the present
tense, it is describing the routing at review time, not the live routing.

A third amendment, folded into the body (#632): §4's report templates, §7's dispatch table and
§9.1's draft of the agent file restated `.claude/agents/task-orchestrator.md` with nothing keeping
them in step, and §7's and §9.1's had drifted, so each now cites that file instead. #655 cut
§9.2's draft of `.claude/skills/run-issue/SKILL.md` and §9.3's drafted amendments the same way,
and §4's account of the templates' shape.

Status: draft for owner review. If accepted, lands via the retro-PR route — this touches
`.claude/workflow.json` and `CLAUDE.md`, both `humanAlways` paths, so the owner decides.

## 1. Summary

One new agent — `task-orchestrator` (Opus) — owns one issue's full lifecycle inside its own
worktree: plan → execute waves → review loop → push → PR → CI watch → classification. It runs the
three existing skills (`plan-issue`, `execute`, `review-loop`) _by reading them_, so every hard-won
rule in them applies unmodified and stays stated once. **The agent is persistent for its ticket's
whole life**: each phase ends with a report, but the agent is not discarded — it stays addressable
by name (`SendMessage` resumes it with transcript intact) through merge fallout, owner feedback
rounds, and post-merge verification, until the top-level explicitly releases it; its final act is
handing over its retro/friction observations from warm context. Three structural rules make the
design safe:

1. **A mandatory plan checkpoint.** The task-orchestrator's first run _ends_ after planning, with a
   `PLAN CHECKPOINT` report carrying the predicted file footprint and any `planApproval` stops. It
   cannot execute until the top-level session continues it (`SendMessage`) with an explicit
   `PROCEED`. This is simultaneously the overlap-scheduling gate and the plan-approval gate — the
   agent structurally cannot bypass either, because proceeding requires a message it cannot send
   to itself.
2. **A merge-readiness return contract.** The task report (template in `.claude/agents/task-orchestrator.md`) carries captured
   evidence — HEAD sha, verify exit code, review verdict + cycle count + demotions, workflow.json
   classification with extension evidence, full changed-file list — sufficient for the top-level to
   decide mergeability without re-reading the diff. The top-level session keeps exclusive ownership
   of the merge chain (update-branch → union-conflict routine → checks watch → merge → ritual →
   worktree fate → `/retro`), serialized across all in-flight issues.
3. **Kept-alive-until-released, over durable state.** "Alive" means _addressable and resumable,
   not discarded_ — the harness property is `SendMessage`-resumability of a returned agent. Warm
   context is a convenience layer: bounce-backs (merge-conflict fallout, humanAlways review
   feedback, a post-merge verification failure) resume with zero re-acquisition cost, and the
   owner can ask the agent questions through the top-level at any point. It is **never** a
   replacement for durable state: the issue-comment ledger remains the record, every resumed round
   starts by reconciling disk state, and an expired/compacted agent degrades to a fresh `RESUME`
   dispatch that reads the same ledger. Release is a top-level decision with a checklist (§3), and
   the price of release is the agent's **retro handover** — its first-hand process observations,
   captured while context is warm, for the top-level's `/retro` pass.

The top-level session's per-issue cost drops from "every dispatch, every verify, every review
cycle" to: one dispatch, one checkpoint decision, one merge, one release. That buys parallel
issues. The owner has confirmed (2026-08-09) what the scarce resource actually is: not the
plan's usage limits, which have never been the observed bottleneck, but the **top-level
session's context window** — the thing that forces frequent compaction today. Top-level context
consumed per issue is therefore this design's success metric #1, and it is exactly what the
checkpoint/report templates are built to minimize: the top-level holds reports and a table, never
diffs, transcripts, or screenshots. This is a property the design _delivers_, never a budget the
top-level _rations work against_ — delegation itself is what fixes the compaction problem, and
admission exists to maximize safe parallelism, not to slow down (§5).

A task-orchestrator's unit of work is a **ticket set**: usually one issue, but the top-level may
admit a **batch** of small same-surface tickets as one set (§5a) — overlapping footprints among
small tickets being precisely the signal to batch rather than to hold. One agent, one worktree,
one branch, one PR closing several issues; the checkpoint, TASK REPORT, and release protocol gain
a per-ticket dimension rather than multiplying.

## 2. Ownership map

| Step                                                                                                                     | Today (flat)                   | Proposed                                                                            |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------ | ----------------------------------------------------------------------------------- |
| Pick issue / compose a batch, check overlap vs in-flight                                                                 | top-level (eyeball)            | top-level, using checkpoint footprints (§5, §5a)                                    |
| Budget-mode read before Fable dispatch                                                                                   | top-level                      | task-orchestrator (rule lives in CLAUDE.md, unchanged)                              |
| Planner dispatch + plan validation + post                                                                                | top-level                      | task-orchestrator                                                                   |
| planApproval stops (adr label, user-only Risks)                                                                          | top-level                      | surfaced in checkpoint; top-level enforces (§3)                                     |
| Worktree creation, chunk ledger, wave dispatch                                                                           | top-level                      | task-orchestrator                                                                   |
| Wave verify + commits (implementers never touch git)                                                                     | top-level                      | task-orchestrator                                                                   |
| STRUGGLING → consultant, browser-smoke sequencing                                                                        | top-level                      | task-orchestrator                                                                   |
| Review loop (≤3 cycles + confirmation pass), FIX-NOW/SYSTEMIC/demote-at-cap                                              | top-level                      | task-orchestrator                                                                   |
| Push branch, open PR, wait CI, classify per workflow.json                                                                | top-level                      | task-orchestrator                                                                   |
| `awaiting-review` label (human-class PRs)                                                                                | top-level                      | task-orchestrator applies label; top-level notifies owner                           |
| **Merge chain, conflict resolution, merge ritual**                                                                       | top-level                      | **top-level, exclusively**                                                          |
| Post-merge/feedback fix rounds (conflict fallout on the branch, owner-requested changes, failed post-merge verification) | top-level re-dispatches ad hoc | bounced to the still-warm task-orchestrator (§3 steps 5–6)                          |
| Retro observation capture for the ticket                                                                                 | top-level (second-hand)        | task-orchestrator's retro handover (first-hand); `/retro` synthesis stays top-level |
| Worktree fate (rebranch/reap/sweep), `/retro`, agent release                                                             | top-level                      | top-level                                                                           |

Exactly one git-writer per worktree at any moment, unchanged in spirit: implementers never touch
git; the task-orchestrator is the only committer in its worktree; the top-level never edits an
in-flight worktree (this generalizes the implementers-commit rule that already drifted once when
stated in two places — so it is stated once, in `task-orchestrator.md`, and referenced elsewhere).

## 3. Lifecycle scope and the checkpoint protocol (design questions 2, 5)

**The task-orchestrator runs planning itself.** Planning's mechanics — the budget-mode read, the
planner dispatch, the one validation round-trip, `gh issue comment`, the label — are precisely the
context-eating chores being delegated. What the top-level actually needs from planning is two
things: the footprint (for scheduling) and the gates (for approval). The checkpoint delivers both.

Protocol:

1. Top-level dispatches `task-orchestrator` (background) with: issue number, main-checkout path,
   worktree naming, and nothing else — the agent reads the skills and the issue itself.
2. The agent runs `plan-issue` steps 1–5 (pull main checkout, planner on the model `plan-issue` step 2 picks,
   validate, post plan, label `planned`), then **ends its run** with the `PLAN CHECKPOINT` report
   (§4.1). It never proceeds to execution in the same run, gated or not.
3. Top-level, on the checkpoint:
   - independently re-checks the gates — `gh issue view <n> --json labels` for `adr`, and reads the
     posted plan's Risks section for user-only questions. Defense in depth: the agent _declares_
     stops, the top-level _enforces_ them. A gated plan waits for the owner exactly as today.
   - checks the declared footprint against the in-flight footprint table (§5).
   - if clear: `SendMessage` to the same agent — `PROCEED — footprint accepted` — which continues
     it with its planning context intact. The agent then runs `execute` + `review-loop` through PR
     - CI + classification and ends with the final report (§4.2).
   - if held (overlap or gate): the agent simply stays parked. Its durable state (plan on the
     issue, `planned` label) means a hold costs nothing; a later `PROCEED` — or a fresh dispatch
     that resumes from the issue, if the agent has expired — picks up identically.
4. The agent runs `execute` + `review-loop` through PR + CI + classification and ends the round
   with the TASK REPORT (§4.2). **It is not done.** It stays parked and addressable — the report
   carries its handle — through everything between report and release.
5. **Bounce-back rounds** (each a `SendMessage` to the warm agent, each ending with a refreshed
   TASK REPORT):
   - _humanAlways feedback_: the owner requests changes on an `awaiting-review` PR → top-level
     relays the feedback verbatim; the agent addresses it in its worktree (review-loop's cycle cap
     still applies, per review-loop step 5), pushes, and re-reports. The top-level logs the
     feedback to `docs/review-feedback.md` as today — that log is merge-owner bookkeeping.
   - _merge fallout_: the merge chain surfaces a branch-side problem the top-level should not fix
     in the agent's worktree (anything beyond the sanctioned tech-debt union routine, which stays
     top-level) → bounce with the observed state.
   - _post-merge verification failure_: a deployed/merged behaviour fails a check → bounce; the
     agent knows exactly which chunk owned that surface.
   - _questions_: the top-level (or the owner, via the top-level) asks anything about the ticket;
     the agent answers from warm context. Questions never mutate the tree — but the Q&A pair is
     made durable: **the agent posts question and answer as one comment on its ticket's issue**
     (anchor issue for a batch) before replying (owner decision 2026-08-09: durable Q&A makes
     recovery easier when something goes wrong — the same durability property everything else in
     this design rides on). The agent posts, not the top-level: it already owns its issue's
     comments (ledger, revisions), so this stays one writer per surface, stated once in its
     agent file.
     Every bounced round starts with the agent's reconcile-disk-state step (§6) — its warm context
     may predate the top-level's merge-time actions, so context is treated as a hypothesis about
     disk, never as disk. Every round ends with the agent appending that round's retro-relevant
     observations to its durable RETRO NOTES comment (§4.3) — warmth is never the storage.
6. **Release** — a top-level decision, on this checklist and only then: PR merged; the ticket
   set's surviving issues closed (for a batch: every shipped member auto-closed, every dropped
   member back on the backlog with its status comment); any post-merge verification settled; no
   open bounce. The top-level sends `RELEASE — hand over
retro notes`; the agent replies with the RETRO HANDOVER report (§4.3) as its final act and is
   then removed from the in-flight table and never messaged again. The handover feeds the
   top-level's `/retro` for that PR — cadence unchanged, strictly per-PR (owner, 2026-08-09),
   kept cheap because the reconstruction arrives pre-banked in the durable RETRO NOTES comment,
   never because agents were kept alive as memory; `/retro` itself, and any
   friction-log/workflow-PR output, remain top-level — the agent proposes observations, the
   merge owner decides what they become.

Why a hard stop at the checkpoint rather than a fire-and-forget single run: the footprint must be
in the top-level's hands _before_ any file is written, or two issues touching
`apps/web/src/charts/*` discover their overlap as merge pain (the stated real constraint on
parallelism). And `planApproval` stops must not depend on the sub-agent's good behaviour — a
sub-agent cannot talk to the user, so "stop and surface to the user" is only implementable as
"end round, report, wait".

**Harness assumption A1**: `SendMessage` resumes a returned background agent by name/id with its
transcript intact (documented behaviour of the Agent tool). The kept-alive lifecycle is built on
A1 — "alive" _means_ "resumable, not discarded". **Degradation if A1 fails** (or an agent expires
mid-lifecycle, e.g. across an app restart): any round becomes a fresh `task-orchestrator` dispatch
prompted `RESUME issue #n` — everything it needs (plan, ledger, revision comments, PR) is already
on the issue, which is the same durability property that survives kills and compaction (§6). What
degrades is cost (context re-acquisition) and the retro handover's richness (reconstructed from
artifacts rather than remembered), never correctness.

## 4. Return contracts (design question 1)

The templates live in `.claude/agents/task-orchestrator.md` and nowhere else. Every sha, exit code, and file
list is **pasted command output, never a recollection** — the repo has been burned three separate
times by reading a pipe's exit instead of the command's (#166 verify, #224 update-branch and
merge); a hand-typed report field is the same defect wearing a new hat. Reports destined for
GitHub comments are entity-decoded first (agent outputs have arrived `&lt;`-escaped).

The `Agent:` line names the handle the top-level can `SendMessage` — that
line is how the top-level knows the agent is still addressable, and it is copied into the
in-flight table on receipt.

For a batch (§5a), `.claude/agents/task-orchestrator.md` rule 7 and each template's batch fields
own what changes.

### 4.1 PLAN CHECKPOINT (ends round 1)

The template is `.claude/agents/task-orchestrator.md` § PLAN CHECKPOINT template.

### 4.2 TASK REPORT (ends the execution round, and every bounce round thereafter)

The template is `.claude/agents/task-orchestrator.md` § TASK REPORT template.

This stays inside the repo-wide `STATUS: DONE|PARTIAL|BLOCKED|STRUGGLING` contract (CLAUDE.md);
merge-readiness rides the qualifier after the dash, the same way PARTIAL already carries detail.
`DONE` here means "this round's work is complete and the branch is in the reported state" — never
"I am finished with the ticket"; only RELEASE ends the ticket. The top-level treats any missing
field as PARTIAL — a template hole is a claim withheld, not a default-pass.

### 4.3 RETRO HANDOVER (final act, in reply to `RELEASE`)

The template is `.claude/agents/task-orchestrator.md` § RETRO HANDOVER template.

The handover's shape deliberately mirrors `/retro` step 1's reconstruction checklist and the
friction log's entry format, so the top-level's retro pass consumes it directly instead of
re-mining the issue. The agent _proposes_; `/retro` (top-level) decides what becomes a workflow
PR, a friction entry, or nothing — the retro skill's "don't force a lesson out of noise" bar is
the merge owner's call, not the witness's.

**The handover is durable by construction, not a context artifact** (owner decision 2026-08-09:
keeping retros cheap must never depend on keeping agents alive as memory). The agent maintains
one **RETRO NOTES comment** on its ticket's issue (anchor issue for a batch), created at the
checkpoint and _appended to at every round boundary_ — edited in place, like the ledger, never
duplicated. Incremental rather than posted-at-release, deliberately: a release-time-only post
survives only if the agent survives to release, which is exactly the dependency being forbidden;
an appended comment has already banked every earlier round when the agent dies mid-lifecycle,
and a `RESUME` replacement continues the same comment. On `RELEASE`, the agent finalizes that
comment into the full RETRO HANDOVER template.

**The comment is the single source of truth — exclusively** (owner, 2026-08-10). The RETRO
NOTES/HANDOVER issue comment is the sole authoritative record of a ticket's retro observations.
The agent's in-chat reply to `RELEASE` is a courtesy copy carrying the comment URL and is never
consumed as the record; `/retro` and `/triage` read only the durable comment; the TASK REPORT
references the comment (`.claude/agents/task-orchestrator.md` § TASK REPORT template's `Retro notes:` line) and never restates its content, so there is
no second place observations can accumulate. If reply and comment ever diverge, the comment
wins — and the divergence is itself a contract breach to flag in the retro.

**What the top-level does with it (its whole merge-decision procedure):**
`git rev-parse <branch>` against the reported HEAD (one command — catches a stale report against
disk truth); classification cross-check against the changed-file list (mechanical: extensions +
humanAlways globs); overlap check of changed files against every other in-flight report/footprint;
then the standard merge chain from `review-loop` step 5, serialized. No diff reading. The diff was
reviewed by the review loop; the human-gated cases go to the owner exactly as today.

## 5. Overlap scheduling (design question 5)

The top-level keeps an **in-flight table** in its session-state scratchpad file (per the existing
compaction-resilience practice) with one row per active issue: issue #, agent handle, phase
(planning / holding / executing / awaiting-human / ready / merged-unreleased), declared footprint,
branch. A row leaves the table only at RELEASE — a merged-but-unreleased agent is still live state.
Admission rule when a checkpoint arrives:

- Intersect the candidate footprint with every in-flight footprint. **Any shared file → hold.**
- Same-directory (package/app subtree) overlap without shared files → allowed but noted as a merge
  caution; the burn-backlog sketch's area-disjointness heuristic remains the tie-breaker when
  queue order is free.
- `docs/tech-debt.md` is excluded from the check: essentially every task appends to it, the
  conflict is expected, and the serialized merge chain (which owns the union+marker-sweep+prettier
  routine) is the mitigation — scheduling around it would serialize everything for nothing.
- **No fixed concurrency cap — maximize safe parallelism** (owner decision 2026-08-09,
  clarified 2026-08-10, superseding the burn-backlog sketch's 2–3): the plan's usage limits have
  never been the observed bottleneck, and the top-level compaction problem is what delegation
  itself fixes — so admission is never a pacing mechanism. **Isolation quality is the real
  gate**: cleanly disjoint footprints or trivially rebasable overlap → admit, and keep
  admitting; entangled surfaces → hold or batch. Context health is a **sanity backstop only** —
  the design keeps each delegated set down to reports and a table row, and the backstop exists
  to notice when that property has broken (runaway bounce chatter, bloated reports), which is a
  defect to fix in the contract, not a signal to throttle work. Never hold work back merely to
  conserve context. Conserve budget mode is the one hard cap: 1 concurrent ticket set.

Footprints drift — plans get revised mid-flight (execute step 4 already posts plan changes as
issue comments). Amendment: a plan-revision comment that adds files carries a leading
`Footprint change: +<files>` line. The top-level does not poll for these; it re-checks at the two
moments that matter — when admitting a _new_ issue (scan in-flight issues' latest revision
comments, one `gh issue view` each) and at merge time (the report's actual changed-file list is
ground truth). A footprint is a floor, not a census — the same lesson the reviewer's sweep rule
already encodes — which is why the final report has an explicit drift field.

## 5a. Batch admission mode (owner extension)

Small same-surface tickets — the just-filed design tweaks #323–#331 (padding/typography/label
changes, tooltip fixes, a search-bar width rule, all on the dashboard/header/chart surfaces) are
the type specimen — would serialize on file conflicts if run one-per-worktree, precisely because
their footprints overlap. Batch mode inverts the §5 rule for that case: overlap between _small_
tickets is the signal **to batch**, not to hold. One design, no menu:

**One batch = one ticket set = one agent, worktree, branch, and PR — merged UNSQUASHED under a
curated-history precondition** (owner decision 2026-08-10, resolving former open question 5).
Single-issue PRs keep the repo's uniform `--squash`; batch PRs merge with `gh pr merge --rebase`,
landing **exactly one commit per surviving member on main, each referencing its issue** — so
main's history still tells each ticket's story, and **the revert unit is the member commit**, not
the batch. The precondition is an invariant, not a merge-day cleanup: the agent maintains
one-commit-per-member **continuously** through the lifecycle — per-member commits as work lands,
folded with fixup/amend as fix cycles touch a member again — which is safe here precisely because
the agent is the worktree's only git-writer (the #19 amend hazard was a sibling committer; a
task-orchestrator has none), and any history rewrite touches only its own branch (force-push to
its own PR branch only, never once the merge chain has started).

**Admission (top-level composes the batch, at admission time).** Batchable: tickets that are each
small (debt-burn scale — a plan of 1–2 chunks each, no re-think), share a surface area (their
predicted footprints overlap or sit in the same package/app subtree), carry no `adr` label, are
expected to touch no humanAlways path, and have no dependency on anything outside the batch
(internal ordering among members is fine; a dependency knot reaching an unbatched ticket
disqualifies the member, not the batch). Disqualified: an infra change, anything whose
verification story is heavier than the change (a live-AWS check, a migration), and anything too
large or entangled for one honest commit — since each member lands as exactly one main commit
(below), a member that cannot be told as one commit does not belong in a batch. Bounds: 2–6
tickets and a predicted total of ≤8 chunks — past that, the batch is a medium issue wearing nine
hats, and the review diff outgrows what one loop reads well. The top-level dispatches one
task-orchestrator with the member list and a designated **anchor issue** (lowest-numbered);
everything §2–§4 says about "the issue" reads "the anchor issue" for batch-level state.

**Planning and checkpoint: one plan, one checkpoint, per-ticket gates.** One planner dispatch
produces one plan whose every chunk is tagged with its owning issue (`C1 (#323)`); the plan posts
to the anchor issue, and each member issue gets a one-line comment linking the anchor plan and
naming its own chunk IDs (plans are durable on issues — a member closed months later must still
find its plan). The PLAN CHECKPOINT is one report with a per-ticket table (§4). planApproval
binds **per ticket**: the agent checks each member's labels and each member's Risks entries
separately, and a member that trips a gate (`adr` label — which admission should have caught —
or an owner-only question) **drops out of the batch at the checkpoint** rather than blocking it:
its chunks are struck from the plan, the drop and reason are declared in the checkpoint report,
and the ticket returns to the backlog untouched. The top-level's independent gate re-check (§3
step 3) runs per member.

**Execution, curation, and the partial-batch rule.** Waves run as normal, but committing follows
the **one-commit-per-member rule** — exactly one, not "a deliberate few": a member whose change
genuinely has separable parts separable enough to deserve separate main commits is two tickets
wearing one number, and admission should have split it. The mechanism is continuous, not a
merge-day rewrite (interactive rebase is unavailable in this harness, and a big terminal rebase
at the end is where curation errors live): the member's first completed chunk creates its commit
(`#<m>: <summary>`); every later chunk, fix-round edit, or review-cycle touch-up for that member
lands by `git commit --fixup <member-sha>` followed by
`git -c sequence.editor=: rebase -i --autosquash main` (the no-op editor makes autosquash fully
non-interactive), or plain `--amend` when the member's commit is HEAD. At any settled point the
branch IS the curated history — "the only commits on the branch at merge time are the ones
isolated to each member" (the owner's condition) holds by construction, never by cleanup. One
review loop over the whole branch diff (one surface, one reviewer pass — a batching win); the
3-cycle cap — plus the scoped confirmation pass that closes it — applies to the batch,
which is one more reason for the ≤8-chunk bound.
**A member that cannot reach DONE ships nothing**: if by review time a member's chunks are not
all verified — or a member's fix would burn cycles the batch doesn't have — the member's commit
is simply **dropped from the branch history during curation** (non-interactive
`rebase --onto`/autosquash mechanics again; no revert commit, nothing of the member reaches
main), a status comment on that issue records what was attempted and why it dropped, its
`Closes` line is struck, and the batch ships without it. The dropped ticket goes back to the
backlog with its plan comment intact. No member ever ships half-done inside a batch.

**Merge mechanics (top-level).** Single-issue PRs keep `gh pr merge --squash`, unchanged — this
decision is batch-mode-only, and the two modes must not blur. Batch PRs merge
`gh pr merge --rebase`: member commits replay onto main individually, linear history, no merge
commit. Two consequences the merge owner carries: (1) the repo settings must allow rebase
merging alongside squash (a one-time check before the batch pilot — branch protection's
linear-history expectation is satisfied either way, since rebase-merge creates no merge commit);
(2) the merge chain's unconditional `gh pr update-branch` step does not apply to batches — it
creates a merge commit on the branch, which both breaks the one-commit-per-member invariant and
blocks a clean rebase-merge. For a batch that is BEHIND or conflicted, the top-level instead
bounces the agent: "curate onto latest main" — the agent rebases its branch onto fresh main
(resolving any `docs/tech-debt.md` conflict per the union rules, marker sweep included),
re-verifies, force-pushes its own branch, and re-reports; then the top-level waits for the new
head's checks and merges. Same settle-then-watch discipline, different first move.

**Ledger and close-out.** ONE batch ledger, on the anchor issue, chunk rows tagged by member
(`C1 (#323): dispatched/committed/verified`) — one ledger edited in place preserves the
no-duplicate-ledgers rule; member issues carry a link to it, never a copy. The PR body carries
one `Closes #n` line per surviving member, so exactly the shipped members auto-close on merge;
dropped members stay open with their status comment. The RETRO HANDOVER is one report for the
batch with a per-member plan-accuracy line (`.claude/agents/task-orchestrator.md` § RETRO HANDOVER template) — a batch is one lifecycle, so one handover.

**In-flight table: a batch is one row** — anchor + member list, footprint = the union. This
simplifies the table by construction: N mutually-conflicting tickets that would have been one
running row plus N−1 holds become a single row, and admission checks new candidates against one
union instead of N footprints. A candidate overlapping a running batch is held — or queued as a
follow-up batch on the same surface — exactly as §5 already decides.

## 6. Progress visibility, recovery, compaction (design question 6)

**Durable state is on the issue, as today**: the plan comment, the chunk ledger comment (updated
at every state change), plan-revision comments, the RETRO NOTES comment (appended at every round
boundary, §4.3), posted owner Q&A pairs, and the PR. The task-orchestrator's context is
treated as a cache over that state — this is already `execute`'s stance ("the ledger — not your
memory — is the record") and it inherits unchanged. This is also the compaction answer, and it
matters _more_ under the kept-alive lifecycle: a long-lived agent accumulates context across
checkpoint, waves, review cycles, and bounce rounds, so a mid-lifecycle compaction is a matter of
when, not if. Kept-alive is a convenience layer over durable state, never a replacement — a
task-orchestrator that compacts re-reads its own ledger at the next round's reconcile step,
exactly as a killed one would, and the round proceeds. Even the retro handover loses almost
nothing: every prior round's observations are already banked in the RETRO NOTES comment, so
compaction or death costs at most the current round's unbanked notes.

**Polling vs waiting**: the top-level waits for the completion notification (background dispatch
default; per the owner's standing preference). For liveness checks it polls `TaskOutput`
sparingly; for _truth_ it reads the issue ledger — never the agent's streamed chatter.

**Kill/hang recovery contract** (the 6-hour-hang lesson, written once into
`task-orchestrator.md` as its opening step so fresh dispatch and resume are the same code path):

> On dispatch, before doing anything else, reconcile disk state: does the worktree exist
> (`git worktree list`), what does `git log main..<branch>` show committed, what does `git status`
> show uncommitted, does the issue already carry a plan/ledger, does a PR exist? Adopt what is
> done: tick ledger boxes the commits prove, commit a clean uncommitted wave only after running
> its chunks' `Verify:` commands, and never re-dispatch a chunk whose files the tree already
> contains in completed form (the implementer's pre-existing-files BLOCKED guard is the backstop,
> not the plan). **Edit the existing ledger comment; never post a second ledger.**

The top-level's half: before re-dispatching a wedged task-orchestrator, `TaskStop` it, then
dispatch fresh with `RESUME issue #n` — the reconciliation step above does the rest.

## 7. Nesting mechanics and models (design question 3)

**Assumption A2 — nested spawning works**: an agent definition's tool grant can include `Agent`.
Evidence from the harness itself: the `Explore` agent's grant is "All tools _except Agent_, …",
which only makes sense if "All tools" (the grant `implementer` and `browser-smoke` already carry)
includes `Agent`. So `task-orchestrator.md` grants all tools including `Agent`, and it spawns the
sub-agents its rule 4 lists, on the models that rule names.

A subtlety worth stating: skills. The three lifecycle skills are plain markdown on disk; the
task-orchestrator is instructed to **Read and follow them verbatim** rather than invoke them via
the Skill tool, so nothing depends on whether sub-agents can trigger skills, and the contracts
stay stated exactly once in the skill files (§8).

**If A2 fails**, it fails fast and cheap: the pilot's very first nested dispatch (the planner)
errors before any file is written. **Do not adopt a degraded "flat task-orchestrator that
implements its own chunks"** — that collapses implementer and verifier into one context,
destroying the trust-but-verify separation `execute` step 4 is built on ("an agent's own report is
a claim, not evidence") and losing wave parallelism. The honest fallback is: keep today's flat
model, and keep the two pieces of this proposal that are independently valuable — the final-report
template as the top-level's own pre-merge checklist, and the in-flight footprint table. Only §4's
templates and §5 rest on nothing but current practice; §2, §3, §6 assume A1-or-durable-resume;
§7's nested dispatch rests on A2.

## 8. Merge ownership (design question 4)

The top-level session exclusively owns everything from "decide to merge" onward, because the two
things merging requires are exactly the two things only it has: **serialization** (the
`docs/tech-debt.md` union conflict lands on essentially every stacked PR, and the
update-branch → marker-sweep → settle → watch → merge chain in `review-loop` step 5 must run one
PR at a time) and **cross-task knowledge** (whether merging #a now forces a painful rebase on
in-flight #b is only visible from the in-flight table).

**Push and PR-open belong to the task-orchestrator.** Justification: pushing a feature branch
touches no shared state — not main, not another worktree — so it needs no serialization; and the
report's CI field is only fillable if CI has run, which requires the push. Withholding push would
force the top-level to push, wait, and watch CI itself — re-absorbing the exact latency this
design exists to shed — for zero safety gain.

The task-orchestrator's explicit must-NOT list (stated once, in its agent file):

- never merge, close, or `gh pr update-branch` any PR (update-branch is the first move of the
  merge chain — run early it races other merges and burns a CI round on a base about to move);
- never resolve a conflict against `main` or rebase onto `main` on its own initiative — a rebase
  decision is merge-queue sequencing, i.e. the top-level's; the one sanctioned case is an explicit
  "curate onto latest main" bounce from the merge owner during a batch merge (§5a), which is the
  top-level exercising that ownership through the agent's hands;
- never write to the main checkout or any worktree other than its own (`plan-issue`'s
  `git -C <main> pull` is the sanctioned read-side exception; on an `index.lock` collision with a
  concurrent sibling, wait and retry once);
- never remove worktrees or run the sweeper; never run `/retro` (post-merge, top-level's);
- never message the user — everything user-facing rides the checkpoint/final reports.

`/retro` stays top-level and unchanged: it runs post-merge, and its subject now includes the new
layer itself (did the report suffice? did the checkpoint hold the right things?), which is exactly
the feedback channel the rollout (§10) reads.

## 9. In-repo changes (design question 7)

Contracts stated once: the lifecycle mechanics stay in the three skill files; the delegation
boundary and report templates live only in `task-orchestrator.md`; the top-level's half lives
only in `run-issue`.

### 9.1 New: `.claude/agents/task-orchestrator.md`

Adopted as `.claude/agents/task-orchestrator.md`, the operative text; the draft as reviewed is §9.1
of `git show 4faeba7:docs/design/task-orchestrator.md`.

### 9.2 New: `.claude/skills/run-issue/SKILL.md`

Adopted as `.claude/skills/run-issue/SKILL.md`, the operative text; the draft as reviewed is §9.2
of `git show 4faeba7:docs/design/task-orchestrator.md`.

### 9.3 Amendments

Each amendment landed in the file it amended, which owns its text: `.claude/skills/execute/SKILL.md`
step 4, `.claude/skills/review-loop/SKILL.md` step 5, `.claude/skills/retro/SKILL.md` step 1,
`CLAUDE.md` § Workflow's Orchestration bullet, and `.claude/workflow.json` → `orchestration`. The
drafts as reviewed are §9.3 of `git show 4faeba7:docs/design/task-orchestrator.md`.

Deliberately **not** changed: `plan-issue`, `implementer.md`, `planner.md`, `reviewer.md`,
`consultant.md`, `browser-smoke.md` — every existing dispatch contract works unmodified one level
down, which is the point of running the skills verbatim. `burn-backlog` stays a stub; this layer
is its missing prerequisite (its sketch's "one issue = one worktree = one full run" unit becomes a
real dispatchable thing), and its activation checklist should be revised to build on `/run-issue`
— as its own issue, not in this diff.

## 10. Failure modes introduced by the new layer (design question 8)

| Failure mode                                                                                                                                                                          | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Double-orchestration drift** — top-level "helpfully" commits/fixes in a task's worktree, or both layers think they own a step                                                       | Ownership map stated once (§2, encoded in the two new files); hard rule: top-level never writes to an in-flight worktree; task-orchestrator's must-NOT list covers the other direction. The implementers-commit drift happened because a contract lived in two places — here each boundary is written in exactly one file.                                                                                                                                                               |
| **Stale report vs disk truth** — branch moved after the report, or a field was recollected rather than pasted                                                                         | Report fields are pasted captures (agent rule 6); top-level's one-command `git rev-parse` check on every report; mismatch is a hard stop → reconcile from ledger.                                                                                                                                                                                                                                                                                                                        |
| **Task-orchestrator compaction mid-lifecycle** — likelier now that the agent lives through checkpoint, waves, review cycles, and bounce rounds                                        | Ledger-on-issue is the record (inherited from execute); reconcile-first at every round makes post-compaction behaviour identical to post-kill behaviour; the incremental RETRO NOTES comment caps the retro loss at the current round's unbanked notes. Per-issue scope still keeps its context far smaller than today's everything-at-once top-level.                                                                                                                                   |
| **Duplicate ledger comments** after resume/re-dispatch                                                                                                                                | Explicit rule: find and EDIT the existing ledger; never post a second. Reconcile-first makes the existing ledger the first thing it reads.                                                                                                                                                                                                                                                                                                                                               |
| **Checkpoint bypass** (agent proceeds to execution unprompted)                                                                                                                        | Structural: run 1 ends at the checkpoint; there is no path to execution without a PROCEED message only the top-level can send. Top-level re-checks gates independently, so even a misbehaving agent can't convert a declared stop into an approval.                                                                                                                                                                                                                                      |
| **Footprint drift breaks the schedule** — plan revision adds a file another in-flight task owns                                                                                       | `Footprint change:` lines on revision comments; final report's drift field; merge-time changed-file check is ground truth; serialized merges turn residual overlap into rebase cost, not corruption. Accepted residual: mid-flight drift between admissions can go unnoticed until merge — same exposure as today's eyeballing, now at least recorded.                                                                                                                                   |
| **Report-status inflation** — DONE with buried residue                                                                                                                                | Template forces FIX-NOW residue = NONE for DONE, demotions listed, missing field ⇒ PARTIAL. /retro audits report-vs-reality each pilot issue.                                                                                                                                                                                                                                                                                                                                            |
| **Entity-escaped relay into GitHub comments**                                                                                                                                         | Decode rule written once in the agent file (rule 6).                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Budget burn from parallel Fable dispatches** (each task can spawn planner+consultant on Fable)                                                                                      | Budget read happens per dispatch as today (CLAUDE.md rule, unchanged location); conserve mode hard-caps concurrency at 1 (run-issue step 1) — and the owner has confirmed usage limits have never been the observed bottleneck, so no fixed cap exists outside conserve.                                                                                                                                                                                                                 |
| **Wedged nested agent invisible to the top-level** (hang two levels down)                                                                                                             | The task-orchestrator owns its sub-agents' liveness (it is the one blocked); top-level's wedge detection is ledger movement + TaskStop + RESUME re-dispatch (run-issue step 7), and reconcile-first prevents the duplicate-work re-dispatch the 6h hang nearly caused.                                                                                                                                                                                                                   |
| **Concurrent `git -C <main> pull`** from two planning-phase agents                                                                                                                    | Read-only parked checkout; fast-forward pulls; retry-once on index.lock (agent file).                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Premature release** — agent released, then a question or post-merge failure surfaces                                                                                                | Release checklist (merged + closed + verification settled + no open bounce) makes this rare; when it happens anyway, durable state carries: fresh `RESUME issue #n` dispatch reads the ledger, PR, Q&A comments, and finalized RETRO NOTES. Degraded warmth, full correctness.                                                                                                                                                                                                           |
| **Zombie unreleased agents** — merged tickets whose agents are never released; the in-flight table silts up                                                                           | A row leaves the table only at RELEASE, and admission reads _unreleased_ rows for its isolation check — so a forgotten release shows up as phantom footprint conflicts rather than leaking silently. Release is bundled into the existing post-merge routine (worktree fate + /retro), which already runs per merge.                                                                                                                                                                     |
| **Warm context diverges from disk across rounds** — the merge owner acted on the branch (union resolution, update-branch) after the agent's last look                                 | Reconcile-disk-state opens EVERY round, bounce rounds included; context is a hypothesis about disk, never disk (agent rule 1).                                                                                                                                                                                                                                                                                                                                                           |
| **Handover becomes noise** — a witness that must produce observations invents them, polluting the friction log                                                                        | The handover _proposes_; `/retro` (top-level) keeps the "don't force a lesson out of noise" bar and decides what lands. Template fields all accept "none"; the pilot's fidelity criterion audits handover-vs-artifact accuracy.                                                                                                                                                                                                                                                          |
| **Two long-lived orchestrators + the top-level all commenting on one issue** after a bounce touches shared concerns                                                                   | Bounces are per-ticket by construction (the agent may only write its own issue/PR/worktree); cross-ticket concerns route through the top-level, which owns everything shared.                                                                                                                                                                                                                                                                                                            |
| **One sick batch member poisons the batch** — its fix rounds burn the shared 3-cycle cap and the confirmation pass that closes it, or its half-done state entangles siblings' diffs   | The drop rule: a member not fully verified by review time is dropped from history in curation and ships nothing; one-commit-per-member makes the drop a clean commit removal. Admission bounds (≤6 members, ≤8 chunks, debt-burn scale each) keep any one member's blast radius small.                                                                                                                                                                                                   |
| **A batch member ships that should not have** — reviewer approved the aggregate diff without judging each ticket's acceptance                                                         | The ledger is per-chunk and chunks are per-member: DONE requires every surviving member's chunks individually verified against their own acceptance criteria, and the report's per-ticket block forces the claim per member — an aggregate "looks fine" cannot fill it.                                                                                                                                                                                                                  |
| **Wrong revert granularity post-merge** — one batched change needs backing out alone                                                                                                  | Dissolved by the unsquashed design (owner decision 2026-08-10): each member lands as its own main commit, so the revert unit IS the member — revert one commit, siblings untouched. The residual case is a bad change _inside_ one member commit, which is exactly the single-issue revert story, no worse.                                                                                                                                                                              |
| **Uncurated history reaches merge time** — WIP/fix-round commits on the branch, or a rewrite error loses a sibling's hunks ("60 random tweak commits" is the owner's named nightmare) | Curation is continuous by contract (fixup+autosquash as edits land), so a dirty branch is a contract breach, not a merge-day surprise; the merge owner's mechanical check (report's commit list vs `git log main..<branch>` vs surviving members) is a hard gate alongside CI — either failing blocks the merge and bounces the agent. A rewrite error is caught the same way `execute` catches everything: the post-curation `pnpm verify` + the reviewer reads the post-curation diff. |
| **Force-push races the merge chain** — agent curates while the top-level is mid-merge                                                                                                 | Explicit ordering rule, stated once each side: the agent never force-pushes after the merge chain has started; the top-level's batch chain starts with the mechanical history check against a named head sha, and a sha that moves mid-chain aborts the chain (same stop-and-reconcile as any report/disk mismatch).                                                                                                                                                                     |
| **Dropped member silently lost** — struck from the batch but never returned to the backlog                                                                                            | The drop protocol posts a status comment on the member issue and the checkpoint/TASK REPORT declare drops; the release checklist verifies dropped members are commented before RELEASE, and an open issue with a `planned` label and no activity is what /triage sweeps already surface.                                                                                                                                                                                                 |

## 11. Rollout (design question 9)

Mirrors the graduated merge-policy pattern: pilot → evidence → owner-decided flip, with the
tightening path named up front.

**Pilot**: `orchestration.mode: "delegated-pilot"`, two runs in sequence.

_Run 1 — single issue_: one medium source-code issue — 3–6 chunks, at least two waves, at least
one browser-surface chunk, expected AUTO classification — run via `/run-issue` while the
top-level session does other work (ideally one flat issue in parallel, as the comparison arm).
Not a debt-burn triviality (wouldn't exercise the checkpoint) and not an ADR issue (don't pilot
the new layer on a humanAlways path).

_Run 2 — one batch_: the owner has effectively pre-nominated the candidate — a subset of the
design-tweak issues #323–#331 (≤6 members within the §5a bounds; same dashboard/header/chart
surfaces, each 1–2 chunks, none plausibly needing its own revert). Run it only after run 1
passes: batch mode layers on the single-issue mechanics, so piloting both at once would leave a
failure unattributable. One prerequisite before dispatch: confirm the repo's merge settings
allow rebase merging alongside squash (§5a merge mechanics). Batch-specific criteria on top of
the list below: wall-clock vs the serialized alternative (N single-issue runs that would have
held on each other's footprints); per-ticket report accuracy (each member's DONE claim
spot-checked against its own acceptance criteria); the curated-history invariant holding at
merge time (report commit list == `git log main..<branch>` == surviving members, with main
receiving exactly those commits via `--rebase`); and, if any member drops, whether the drop was
clean (commit absent from history, status comment posted, backlog return visible) — a drop is a
_successful_ exercise of the mechanism, not a pilot failure.

**Comparison criteria vs the flat model** (recorded in the pilot issue's closing comment):

1. _Top-level context_: compactions during the issue's lifetime and share of top-level messages
   spent on it (target: dispatch + checkpoint + merge ≈ 3–5 touches, vs dozens today). This is
   criterion #1 by owner confirmation (2026-08-09): the top-level context window, not usage
   limits, is the scarce resource the whole design exists to protect.
2. _Wall-clock_: issue-open → merged, vs a comparable recent flat issue.
3. _Defect escape_: revert PRs, post-merge findings, review-feedback entries naming something the
   loop missed (target: zero, same bar as `merge.note`).
4. _Report fidelity_: count of report-field-vs-disk mismatches and of merge-owner questions the
   report failed to answer (target: zero — the report's whole job).
5. _Bounce-round value_: deliberately exercise at least one bounce (a question is enough; owner
   feedback or a post-merge check is better) and record whether the warm resume actually saved
   re-acquisition vs what a fresh dispatch would have read.
6. _Handover fidelity_: does the RETRO HANDOVER match what the artifacts show (spot-check its
   cycle counts and re-plan claims against the issue), and did `/retro` use it rather than
   re-mining? An invented or padded observation is a pilot failure of the same rank as a report
   mismatch.
7. _Recovery, if exercised_: a kill/RESUME that adopts rather than duplicates work.

**Graduation**: 3 consecutive delegated ticket sets (a batch counts as one set; at least one of
the three a batch) with zero report mismatches and zero defect escapes → propose
`mode: "delegated"` as its own retro PR; workflow.json is humanAlways, so the
owner decides — same route as the 2026-08-01 review-gate graduation, which graduated on exactly
this shape of evidence (ten consecutive clean PRs).

**Rollback**: any merge made on a report later shown wrong → revert PR + a review-feedback entry
naming what the _report_ (not the review loop) failed to carry, `mode` back to `flat`, and the
report template amended before the next pilot. A failed A2 (no nested spawning) rolls back at
zero cost before any file is written (§7). A failed A1 (agents not resumable after returning)
does not kill the design but demotes kept-alive to durable-resume everywhere: every round is a
fresh `RESUME` dispatch continuing the same issue-comment state (ledger, RETRO NOTES) — if that
happens, re-weigh whether the pilot's bounce-round and handover criteria still show a win over
flat.

## 12. Resolved questions — record of decisions

No questions remain open; the design is final pending the owner's review of this document via
the retro-PR route. The five questions this section once held were answered by the owner and
are inlined as normative text where they apply:

1. **Concurrency cap** (2026-08-09, clarified 2026-08-10): none outside conserve mode —
   maximize safe parallelism; isolation quality is the real gate, context health only a sanity
   backstop, never a pacing mechanism (delegation itself is the fix for context pressure);
   conserve caps at 1. → §1, §5, `.claude/skills/run-issue/SKILL.md` § Batch lane step 1.
2. **HUMAN-class notification** (2026-08-09): no at-label-time issue @-mention; the top-level's
   relay after verified readiness is the only ping. → `.claude/skills/run-issue/SKILL.md` § Batch lane step 4.
3. **Retro cadence** (2026-08-09, clarified 2026-08-10): unchanged, per-PR — kept cheap by the
   incremental durable RETRO NOTES comment, never by agent longevity; that comment is the
   single, exclusive source of truth for a ticket's retro observations (chat replies are
   courtesy copies; /retro and /triage read only the comment; on divergence the comment wins).
   → §3 steps 5–6, §4.3.
4. **Owner Q&A durability** (2026-08-09): Q&A pairs are posted to the ticket's issue, by the
   agent. → §3 step 5, `.claude/agents/task-orchestrator.md`.
5. **Batch merge/revert unit** (2026-08-10): batch PRs merge unsquashed (`--rebase`) under the
   curated-history precondition — exactly one commit per surviving member, maintained
   continuously via fixup/autosquash, verified mechanically by the merge owner from the TASK
   REPORT's branch commit list; dropped members vanish via curation; the revert unit is the
   member commit; single-issue PRs stay `--squash`. → §5a (curation + merge mechanics),
   `.claude/agents/task-orchestrator.md` § TASK REPORT template and rule 7, `.claude/skills/run-issue/SKILL.md` § Batch lane step 4, §10.
