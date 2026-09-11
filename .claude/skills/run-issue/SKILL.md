---
name: run-issue
description: Run one GitHub issue via a ticket-agent, or a same-surface batch via a
  task-orchestrator, keeping the top-level session free for parallel issues and merge
  ownership.
---

You are the merge owner, and you own merging and merge-readiness in both lanes below.
`.claude/workflow.json` → `orchestration.routeRule` picks the lane by the ticket SET's
shape — read it there rather than assuming, since `modeHistory`'s superseded values still
resolve in older references. Two dispatch shapes come out of it: a **single issue** goes to
one `ticket-agent` (`.claude/agents/ticket-agent.md`), and a **multi-ticket same-surface
batch** goes to one `task-orchestrator`. Neither lane's procedure is the other's, so pick
the section before you dispatch.

## Ticket-agent lane

1. **Admission**: the same in-flight table as below (issue, agent handle, branch, and the
   footprint once the plan comment lands). Predict the footprint from the issue body and
   name any known in-flight overlap in the dispatch prompt, so the agent either plans around
   it or expects the rebase. A single lane never holds for another lane's plan — overlap is
   priced as rebase cost, and only entangled same-file SOURCE overlap is batched or
   sequenced, here, at dispatch. `conserve` budget mode: one lane.
2. **Dispatch** `ticket-agent` with the issue number, the main-checkout path, the budget
   mode and the overlap note — nothing else; it reads the issue and the files.
   **`run_in_background: true`**, which is the opposite of the rule in
   `.claude/agents/task-orchestrator.md` rule 4 and does not contradict it: that rule governs
   what an orchestrator spawns, and the reason it exists — a nested child's completion routing
   past its parent to you — cannot arise for your own direct child, whose completion IS the
   lane report arriving. Silence until that report is the healthy state; do not poll. If the
   notification is lost the report is still durable: `gh pr view <n> --json body`, or the
   issue's comments.
3. **Diff check** — your first touchpoint, and your only read of the code. `git rev-parse
<branch>` must equal the report's HEAD, or stop and reconcile before anything else. Check
   the changed files against the plan comment's files (drift named, or none); every `Verify`
   and `CI` field pasted rather than summarised; CI green on the reported head. Then read
   `gh pr diff <n>` for three things: scope (only this ticket's work), suppressions
   (`gh pr diff <n> | command grep -nE 'eslint-disable|@ts-expect-error|as any'`, with a
   positive control against a scratch line holding one), and classification against the
   extensions the diff actually carries. Findings go back as one `FIX — <finding>` message to
   the warm agent, which returns a refreshed report. **Two FIX bounces on one ticket is the
   cap**: past that, report to the owner instead of bouncing a third time. Then the merge
   chain of `.claude/skills/review-loop/SKILL.md` step 5, unchanged — including the
   `humanAlways` ritual, and the merge-time `Category`/`Verdict` fill, which reaches the agent
   as a bounce because only it writes to its worktree.
   **`bash .claude/scripts/merge-pr.sh <pr>` runs that chain's mechanical half for you** —
   `gh pr update-branch` with retries against the head-sha race, the pending-aware checks
   poll, a merge taken only from `CLEAN`, and then, only once the PR reports `MERGED`, the
   label removal, the `Closes`-issue check and the worktree reap. It is idempotent and
   re-runnable from any state, so the repair for a chain that dies mid-poll is to run it
   again; a failure names the step the next run resumes from. It never fills a **Verdict** —
   a `humanAlways` PR whose entry still carries the `pending — filled at merge` placeholder
   is refused outright — so the fill above stays a bounce to the agent, and every judgement
   this prose owns stays yours.
4. **Rebase hand-off** — your second touchpoint, and only when `main` moved. After every
   merge, `gh pr view --json mergeStateStatus` on each open lane PR. `BEHIND` → run
   `gh pr update-branch` yourself; it is mechanical. `DIRTY` → `REBASE — <what merged since
this branch was cut, which files, what the union rule expects>` to the warm agent, which
   rebases per its rule 8 and re-reports. The second merger rebases, always; merges serialise.
5. **Release**: PR merged, issue closed, no bounce open → the `## Lane report` in the PR body
   is the retro's first-hand input; run `/retro`; remove the row. A wedged agent (no report,
   no branch movement) gets the worktree and the issue inspected FIRST, then `TaskStop`, then
   a fresh `RESUME issue #n` dispatch — the new agent reconciles from `git log main..<branch>`, A dead lane is recognised, not diagnosed: the task shows no progress or an `ENOTFOUND` / stall-watchdog failure, its output file is a few hundred bytes, and `ps` shows no process under the worktree — a 0-byte background task entry alongside it is a ghost of a command whose owner died, safe to stop. Then `RESUME`: the new agent audits uncommitted work against the plan comment's ticks before adding to it, and never re-does a step whose files exist.
   `git status`, the plan comment and any PR, and adopts what is already done.

## Batch lane

1. **Admission**: maintain the in-flight table in your session-state scratchpad file
   (issue, agent handle, phase, footprint, branch). A row leaves the table only at
   RELEASE. No fixed concurrency cap — **maximize safe parallelism** (owner, 2026-08-09,
   clarified 2026-08-10): isolation quality is the gate — admit every candidate whose
   footprint is cleanly isolated from (or trivially rebasable against) everything in
   flight; entangled candidates hold, or batch. Never hold work back merely to conserve
   your own context: each set costs you only reports and a table row by design, and
   delegation is itself the fix for context pressure. Context health is a sanity backstop
   only — if in-flight sets are somehow costing more than that (bounce chatter, bloated
   reports), fix the contract breach; don't slow admission. Conserve budget mode is the
   one hard cap: 1 concurrent set.
2. **Dispatch** `task-orchestrator` (background) with: the issue number (or, for a batch,
   the member list + anchor issue) and the main-checkout path. Nothing else — it reads the
   skills and the issue(s). **Batch composition is yours, at admission**: overlapping
   footprints among SMALL tickets (debt-burn scale, 1–2 chunks each) on one surface are the
   signal to batch, not hold — 2–6 members, ≤8 predicted chunks total, no `adr` label, no
   expected humanAlways paths, no dependency outside the batch, and nothing too large or
   entangled to be told as one honest commit (each member lands on main as exactly one
   commit and is its own revert unit). One batch = one agent = one in-flight row
   (footprint union). **The agent goes quiet after the dispatch and stays quiet until its
   next contract report** (`task-orchestrator.md` rule 6 bans interim narration), and its own
   sub-agent dispatches are synchronous, so no sub-agent completion notification for that set
   should reach you at all — one that does is a contract breach worth naming in the retro,
   not a message to relay. Silence between reports is the healthy state; do not poll it.
3. **On PLAN CHECKPOINT**: independently re-check the gates (`gh issue view <n> --json
labels` for planApproval.alwaysRequiredFor; read the plan's Risks for user-only
   questions) — the agent declares stops, you enforce them, and a gated plan waits for the
   owner exactly as before. Then intersect the footprint with every in-flight footprint
   (docs/tech-debt.md excluded — its conflict is expected and handled at merge). Clear →
   SendMessage `PROCEED — footprint accepted`. Held → record the hold and its reason;
   re-check when the blocker merges.
4. **On TASK REPORT**: verify disk truth in one command (`git rev-parse <branch>` vs the
   reported HEAD — mismatch: stop, reconcile from the issue ledger before anything else);
   cross-check the classification against the changed-file list; check the changed files
   against other in-flight tasks. Then the merge chain of review-loop step 5 (which owns
   update-branch, the tech-debt union routine, the settle-then-watch, and all of the
   ritual still owed at merge time — filling that PR's review-feedback entry
   **Category and Verdict**, both placeholders and never just one, on
   the branch, in the shape `docs/review-feedback.md`'s `## Entry format` declares, which
   being a branch commit necessarily precedes the merge; then the merge; then taking the
   label off, last of the three, the entry itself having landed on the branch before the
   label ever went on), one PR
   at a time — merges are serialized, always. Single-issue PRs merge `--squash` as today;
   batch PRs merge `--rebase` AFTER the mechanical curated-history check passes — the
   report's branch commit list must show commit count == surviving-member count, each
   commit referencing its member issue, and `git log --oneline main..<branch>` must match
   it (CI green AND curated history are both required; either failing blocks the merge).
   A batch that is BEHIND or conflicted gets a "curate onto latest main" bounce instead of
   `gh pr update-branch` (a merge commit would break the invariant and block rebase-merge);
   after the force-push, wait for the new head's checks as usual. HUMAN-class: notify the
   owner with the
   report's review guide — and only via this relay, after you have verified readiness
   (CI green on the reported head) yourself; the label is already on, and there is
   deliberately NO issue @-mention at label time (owner, 2026-08-09: a ping must mean
   "ready for review now", and only the relay carries that guarantee). That readiness
   check is satisfiable rather than circular: the review-feedback entry lands on the
   branch before the label goes on, so green-with-label is the normal state. A red
   `merge-ritual-gate` on a labelled PR is therefore never a PR still waiting for
   something — but read the job's error message before acting on it, because that is
   what separates the two reds: a missing-entry error says the sequence was violated,
   which is a bounce (step 5), while a "could not read the PR" error means the gate
   reached no verdict at all and calls for a re-run of the job, not a bounce at a branch
   with nothing to fix. Neither is a thing to wait out. The agent stays parked either
   way.
5. **Bounce, don't do**: anything ticket-shaped that surfaces before release — owner
   feedback on an awaiting-review PR (relay verbatim; the warm agent folds it into the
   branch's docs/review-feedback.md entry in the commit that responds — an on-branch
   edit, so it is never yours to make; an approval with no changes relays the same way,
   as the Category and Verdict to fill), branch-side merge fallout beyond the sanctioned
   tech-debt union routine, a post-merge verification failure, or a question from you or the owner —
   goes to the warm agent by SendMessage. You never edit an in-flight worktree. Each
   mutating bounce ends in a refreshed TASK REPORT; re-verify it as in step 4.
6. **Release**: when the PR is merged, the surviving ticket(s) are closed (a batch's
   dropped members are back on the backlog with status comments — verify, don't assume),
   post-merge verification (if any) has settled, and no bounce is open — SendMessage
   `RELEASE — hand over retro notes`. The handover arrives twice by construction — as the
   agent's reply (a courtesy copy, never consumed as the record) and as the finalized
   RETRO NOTES comment on the issue, the sole authoritative record; confirm the comment
   exists and matches the reply — on divergence the comment wins and the divergence is
   itself flagged in the retro as a contract breach — then decide worktree fate
   and run /retro (review-loop step 6 unchanged) with the handover as first-hand input —
   the retro also asks whether the checkpoint, reports, and handover told you what you
   needed. Only then remove the row. Never release with an unmerged PR unless the ticket
   is being abandoned (then say so in the release message; the handover records the
   abandonment).
7. **Wedged or expired agent** (no notification, no ledger movement — or SendMessage
   fails): inspect the issue ledger and the worktree BEFORE anything else; TaskStop the
   agent if wedged; re-dispatch fresh with `RESUME issue #n` — its reconcile-first step
   adopts completed work instead of duplicating it. The fresh agent inherits the ticket
   INCLUDING the handover duty, continuing the existing RETRO NOTES comment (every prior
   round is already banked there); update the table's handle.
