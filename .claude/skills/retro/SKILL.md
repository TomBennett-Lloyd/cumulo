---
name: retro
description: Post-merge retrospective on how the workflow performed for a task. Produces exactly one output — a concrete workflow improvement PR, or a friction-log entry. Run after every merged PR.
---

You are reviewing how the _workflow_ performed on the task just merged — not re-reviewing the code.

1. Reconstruct the task's history from the issue, plan comment, PR, and this session: plan accuracy (chunks re-planned? BLOCKED/STRUGGLING events?), review cycles used, findings that a standards trigger should have prevented, hook noise, wasted work, and any new entries in `docs/review-feedback.md` since the last retro. When the task ran delegated, read the task-orchestrator's RETRO NOTES/HANDOVER comment on the issue — the sole record of its retro observations, never the agent's chat reply — as first-hand input for this reconstruction; weigh it, don't just copy it. When it ran in the ticket-agent lane, the `## Lane report` in the PR body is that record (`.claude/agents/ticket-agent.md`).

2. Produce EXACTLY ONE of:
   - **Clear signal with a clear fix** → make the change now, as its own small PR (issue label `workflow`). In order of preference:
     a. **Promote to machine enforcement**: a prose rule that keeps being violated becomes a lint rule/tsconfig flag/hook — then DELETE the prose it replaces, and only that: a sentence the tool enforces in part keeps the rest and cites the tool. #659 asked for a STATUS gate with "or is deleted if the gate makes it redundant"; its plan deleted `ticket-agent.md` rule 8's "Every field above is contractual" for a gate that checks one field, and review restored the sentence with the gate cited.
     b. **Rewrite a trigger line** in CLAUDE.md's standards index — most standards misses are recognition failures, not comprehension failures; fix the trigger, not the doc.
     c. **Amend an agent/skill definition** — tighten the instruction that failed.
     d. **Encode recurring human review feedback** into the relevant standards doc or agent definition, and note the promotion in the feedback log entry.
     A fix that is source — a script, a lint rule — needs the review a lane gives it, so the retro files it as its own issue sized to one PR (labels `workflow`, `discovered`), even when an open issue already lists it among its acceptance items. A line appended to a large open issue schedules nothing: the expected-checks timeout was logged on #533 at each of four 30-minute merge waits (#628, #642, #650, #652) before #653 carved that one item out; it merged the next day, and the fifth wait (#654) was the fix's own merge.
   - **No clear signal** → append ONE entry to `docs/friction-log.md` (its format). Do not force a lesson out of noise; a well-observed friction entry beats a speculative rule.

3. Prune check: scan the standards index and the rule you touched — is anything now stale, subsumed by tooling, or unused? Propose deletions. The workflow should get _smaller_ as enforcement moves into tooling, not monotonically bigger. Graduation check: if a review-feedback category has produced no new entries across several consecutive reviewed PRs/plans, propose relaxing the corresponding `.claude/workflow.json` gate — as its own PR for the user to decide.

Report: what you changed or logged, and one sentence on why.
