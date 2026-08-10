# Retro proposals — 2026-08-10 batch

Output of the batch `/retro` over the twelve merged-and-unretroed PRs #301, #302, #304, #310, #314, #318, #319, #320, #332, #341, #345, #348.

Everything in this file is a **proposal, not an applied change**, because every item lands on a `merge.humanAlways` path (`CLAUDE.md`, `.claude/workflow.json`, `docs/adr/**`) — the gates never pass through the gates they define, and the owner decides. The retro's other outputs were applied directly: two agent-definition amendments (`.claude/agents/reviewer.md`, `.claude/agents/browser-smoke.md`), nine `docs/friction-log.md` entries, and PR #348's owed `docs/review-feedback.md` line.

Each proposal states the evidence first and the diff second. Delete this file once the proposals are decided — it is a hand-off, not a record; the record is the friction log and the feedback log.

---

## P1 — merge-time bookkeeping has no mechanical gate, and it has now failed twice running

### Evidence

`merge.mergeRitual` requires two things of whoever merges a PR that carried `awaiting-review`: take the label off, and write one line to `docs/review-feedback.md`. The second half is what makes a quiet feedback category distinguishable from an unlogged one, which is the input the graduation rule reads — so a missed line is not bookkeeping pedantry, it is the evidence base for every future gate move silently losing a row.

Both human-gated merges in this batch missed it, in opposite directions:

- **PR #345** (#336, task-orchestrator adoption) merged on 2026-08-10 under a recorded owner pre-approval. Its PR body states "merged under that approval **with the review-feedback line logged**". The line was not logged. It was noticed by PR #348's implementer some hours later — reading the file for an unrelated reason — and written retroactively as part of #348's diff. Nothing between the merge and that accident would have caught it: CI does not read the feedback log, and no reviewer sees a PR after it merges.
- **PR #348** (#337, design principles) merged the same night, also under a recorded owner waiver, and its PR body says outright that "the merger's review-feedback line for this PR rides the next docs PR". That line is in this retro's diff — written a day later by a different agent, from the artifacts rather than from the merge. Honest, and still a deferral of a step the policy words as simultaneous with the merge.

So the ritual failed once by omission and once by acknowledged deferral, on consecutive PRs, both times with the merge already irreversible. The common cause is structural rather than careless: the ritual asks for a **commit after the merge**, at the exact moment the branch is gone, the worktree is reapable, and the session's attention has moved to the next ticket. Every other gate in this repo is enforced before the merge, where a gate can still block.

### Proposed change — move the ritual into the PR, where CI can see it

`awaiting-review` is applied when CI goes green and the PR is handed to the owner; the approval that the entry records therefore exists _before_ the merge, not after it. The entry can be written on the branch, and then it is a diff a gate can check.

`.claude/workflow.json` — replace `merge.mergeRitual`:

```diff
-    "mergeRitual": "Whoever merges a PR that carried 'awaiting-review': (1) the label comes off at merge, and (2) one line goes to docs/review-feedback.md — even when the verdict is just 'approved, no changes' (category: approved-no-changes). A quiet feedback category must be distinguishable from an unlogged one, or nothing can ever graduate; this ritual is what made reviewedSourceRule graduatable.",
+    "mergeRitual": "A PR that carries 'awaiting-review' logs its own review-feedback line ON THE BRANCH, before it merges: the docs/review-feedback.md entry (category from the closed vocabulary, even when the verdict is just 'approved, no changes') is part of the diff the owner approves, added in the commit that responds to the approval. At merge the only remaining step is taking the label off. Moved from after-merge to on-branch 2026-08-10 after PR #345 omitted the line while its body claimed it, and PR #348 deferred its own line to a later PR — a step owed after the merge is a step no gate can block. A quiet feedback category must be distinguishable from an unlogged one, or nothing can ever graduate; this ritual is what made reviewedSourceRule graduatable.",
+    "mergeRitualGate": "Mechanical half: a CI check fails any PR labelled 'awaiting-review' whose diff does not touch docs/review-feedback.md. Wire it into .github/workflows/ci.yml as its own job (not into `pnpm verify`, which knows nothing about labels). The check is a floor, not a proof — it cannot tell a good entry from a placeholder — which is why the prose half above still owns what the entry must say.",
```

`CLAUDE.md` — the Workflow section's merge-policy bullet currently includes the sentence below (it is not the bullet's last sentence: "Gate changes are proposed via retro PR and decided by the user." follows it and stays):

```diff
-Whoever merges an `awaiting-review` PR removes the label and logs one `docs/review-feedback.md` line, even "approved, no changes" — a quiet category must be distinguishable from an unlogged one.
+An `awaiting-review` PR carries its own `docs/review-feedback.md` line **in the diff** — even "approved, no changes" — and the merger only removes the label; a quiet category must be distinguishable from an unlogged one, and a line owed after the merge is a line no gate can block (PRs #345 and #348, 2026-08-10).
```

### If the owner prefers to keep it at merge time

The alternative that needs no CI job: the `/review-loop` skill's human-review path gains the entry as an explicit numbered step alongside label-removal, so a verbatim reader meets both in one place. That is weaker — it is the same prose obligation one file further along — and it inherits the finding already logged against that step's structure: "review-loop's classification step fuses three owners into one paragraph, so a boundary marker can only be planted mid-step", raised 2026-08-10 and now owned by [#359](https://github.com/TomBennett-Lloyd/cumulo/issues/359). Recorded so the choice is made against an alternative rather than by default.

### Note for whoever applies this

`CLAUDE.md` and `.claude/workflow.json` state the ritual twice, in their own words, with nothing binding them — `architecture.md` rule 9's exact shape, in the two files that define the gates. Whichever wording is chosen has to land in both in the same PR. Worth considering, separately, whether `CLAUDE.md`'s bullet should point at `workflow.json` as the owner and carry no restatement at all.

---

## P2 — prune check and graduation candidates

Per the retro skill's step 3. Nothing here is applied.

### (a) Delete `merge.refactorRule` — it asks to be deleted

`.claude/workflow.json`'s `refactorRule` reads, in full, "SUBSUMED by reviewedSourceRule 2026-08-01 … Kept for the historical calibration record (PR #80 vs #77 C3) **until the next gate revision deletes it**." If P1 lands, that is the next gate revision. The calibration record it preserves is not lost by deleting it: `docs/review-feedback.md`'s `2026-07-31 — refactor-lane` entry carries the same precedent, with the same two PR numbers, in the log that exists to hold it.

```diff
-    "refactorRule": "SUBSUMED by reviewedSourceRule 2026-08-01 — a behaviour-preserving refactor is a source PR and merges on CI green + review-loop APPROVE like any other. Kept for the historical calibration record (PR #80 vs #77 C3) until the next gate revision deletes it.",
```

`debtBurnRule` sits beside it in the same subsumed-but-kept state and is **not** proposed for deletion: it is still load-bearing on the other side, as the anchor for `planApproval.debtBurn`. Its own note says so.

### (b) `orchestration.mode` — hold at `delegated-pilot`, do not graduate yet

No delegated run has completed yet. Every merged PR in this batch — including #348, which landed the same night the mode did — ran under the top-level session's inline orchestration; the first delegated run (pilot Run 1, on #331) is still in flight as this retro writes, so there is zero completed-run evidence either way. (#348 accordingly has no RETRO NOTES comment on #337, and none was owed: that contract binds delegated runs only. This retro's reconstruction of #348 from the PR body, issue and review-cycle comments is simply what retros of inline-orchestrated PRs have always done.)

One harness observation from the in-flight pilot is worth banking now: **the agent type was not dispatchable at the first attempt after its own merge.** `task-orchestrator` — merged by PR #345 that same session — did not exist as a dispatch target when the pilot launched, so the pilot ran as a `general-purpose` agent reading the contract from `.claude/agents/task-orchestrator.md`. Contract fidelity was preserved (the contract is a file), but the pilot run is therefore evidence about the _contract_ more than the harness's own routing. The type did become available later in that same session, once its definition file had reached the session's own worktree through a rebase, and dispatches after that point got the real type. That is the sequence as observed and not a mechanism — whether the worktree copy arriving is what registered it, or the registry refreshed independently, was not established — so the graduation evidence below asks for runs on the real type rather than assuming when one can be had.

Proposed: keep `delegated-pilot`; no skill edit is proposed. The `/run-issue` contract already makes the RETRO NOTES comment a release precondition (step 6: "confirm the comment exists and matches the reply" before removing the row) — whether that step is honoured in practice is exactly what the pilot runs will show. Graduation evidence to collect: three completed delegated runs, at least two with the real agent type, each releasing through a RETRO NOTES comment that a subsequent retro found sufficient as its first-hand input.

### (c) Review-feedback graduation rule — no move available, and the reason is worth recording

Applying the rule's own terms to `docs/review-feedback.md` as it stands after this batch. The file holds 25 entries; ten of them follow the `2026-08-01 — review-gate-graduation` entry that last moved the gate, and the census below is a fresh count off the file rather than a carry-forward:

- **Eight of the ten are approved-no-changes**: `architecture-trigger-row` and `adr-0006-abuse-protection` (2026-08-01), `adr-0002-amendment-capacity` and `architecture-trigger-owned-values` (2026-08-04), PR #287 and PR #294 (2026-08-09), PR #345 and PR #348 (2026-08-10). By the rule those are positive evidence of quiet, not entries against a subject category.
- **The other two are not clean approvals**, and both sit on the owner-gated ADR/convention surface. `2026-08-01 — adr-amendment-convention` (category **convention**) is change-requesting: the owner asked for ADR immutability to give way to a dated amendment convention, and `docs/adr/README.md` changed in response. `2026-08-03 — adr-0007-ttl-only-deletion` records a design question answered before approval — the owner probed TTL-to-now, the analysis held, and PR #211 merged as-is; its category `design-question-then-approval` is the one the closed vocabulary does not declare, which is the finding now owned by [#359](https://github.com/TomBennett-Lloyd/cumulo/issues/359). So the span is not uniformly quiet, and the honest statement is one change-requesting entry in ten, dated the same day as the graduation itself.
- **plan**, **code-style** and **architecture** have no entry of any kind in the span — their last change-requesting entries are `plan-file-references` (2026-07-31) and, for architecture, `#36` and `#40` (2026-07-30; the two code-style entries of that date are clean approvals recorded before **approved-no-changes** existed to name them). **convention** has been quiet across the eight entries since its one firing. **testing** has never been exercised at all, anywhere in the file, which the rule explicitly says is absence of evidence rather than evidence of quiet.
- **gate-calibration** last fired on 2026-08-01 and is the rule's output, never its input.

So the evidence for further relaxation is about as strong as it is ever going to get — and there is nothing left to relax except the `humanAlways` paths themselves (`docs/adr/**`, `.claude/workflow.json`, `CLAUDE.md`) and `adr` plan approval, which are the decisions the owner has said twice they want to keep. **No change proposed.** Recorded so the next retro does not re-derive the same dead end: the graduation rule has run out of subjects, and the honest next question is not "what else graduates" but "does the quiet evidence still get collected at all" — which is P1.

### (d) Standards index — nothing stale found

Every trigger row in `CLAUDE.md`'s standards index fired at least once across the twelve PRs, including the `docs/standards/design.md` row that PR #348 added (it is what routed `browser-smoke.md`'s two new checklist lines). No row is subsumed by tooling, and no row went unused. No deletions proposed.

One candidate that is **not** proposed and is recorded so it is not re-discovered: `.claude/skills/retro/SKILL.md` describes a per-PR retro and has no batch mode, while this run retroed twelve PRs at once and had to invent the dedupe rule ("a signal shared by several PRs gets one disposition citing them all"). That is one instance. A skill amendment on one instance is the speculative kind this workflow is supposed to avoid; if a second batch retro runs, write the dedupe rule into step 2.
