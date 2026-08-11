# Review-feedback log

Every substantive piece of human review feedback — on plans or PRs — gets an entry here. On a `humanAlways` PR the entry does not wait for the owner to speak: it **begins on the branch before review**, stating what the PR asks the owner to decide, and **completes at merge**, when whoever merges fills in both the category and the verdict (see `## Entry format`). Feedback that arrives outside a PR is still logged as it is addressed. `/retro` mines this log to update standards and agent guidance, and the graduation rule below reads its categories, so the vocabulary has to mean something: it is declared here, closed, and trued up to what the entries actually say.

## Entry format

```
## YYYY-MM-DD — [PR/issue #n — ]<short-slug>

- **Category**: one category from the vocabulary below
- **Feedback**: what the user asked for, verbatim where short
- **Why**: why the feedback is right — the reasoning or evidence behind it, not a restatement of it
- **How applied**: what changed in response (code fix, standards edit, agent-guidance edit, config flip, or none + why)
- **Verdict**: filled at merge by whoever merges — what the owner decided, verbatim where short, and the outcome
```

One entry per distinct feedback item; the slug names that item's subject and disambiguates multiple items arising from the same review. The `PR/issue #n` segment is present when the feedback attaches to one PR or issue, and omitted when it arrived in chat outside any single one — name the PRs in the body instead.

**The pre-label state.** An entry written on a `humanAlways` branch before review — the state `merge.mergeRitual` in `.claude/workflow.json` requires, since the entry has to be part of the diff the owner approves — fills **Feedback** with _what the PR asks the owner to decide: the ask, never a prediction of the answer_, and writes both **Category** and **Verdict** as the literal placeholder `pending — filled at merge`. Whoever merges fills both **on the branch, before the label comes off**, in the commit that responds to the approval; a clean approval gets a one-line verdict commit and nothing more. A merged entry still reading `pending` is a verdict nobody filled, and it reads as exactly that — which is why the placeholder is literal and identical everywhere, and why an entry that guessed the category and the verdict instead would be indistinguishable from a record of what was actually decided. That distinguishability is the whole point of the form.

The first eleven entries use an earlier unbolded `Category / Feedback / Action` triplet, where `Action` covers what `Why` and `How applied` now separate. They stand exactly as written: the entries are the record, so the declaration is trued up to them and never the other way round. For the same reason, every entry from the twelfth up to and including `2026-08-11 — issue #390 — workflow amendment: batch-delegated routing` uses the four-field form with no **Verdict** and stands as written — the boundary is that entry, not a date, since #390 and the first five-field entry share one. The fifth field is owed only by entries begun after it, the first being the `issue #409 — provisional-verdict-form` entry that declares the form and is written in it.

## Category vocabulary

Closed list — every entry's category is one of these:

- **plan** — the shape of a plan before it is executed: scope, chunking, sequencing, acceptance criteria, what a ticket defers.
- **code-style** — how code is written within an already-agreed structure: naming, function and module shape, hooks and scripts, formatting gates.
- **architecture** — decisions that ossify: interfaces, data models, infrastructure topology, ADR content.
- **testing** — what is tested, how, and what counts as evidence. No entries yet; kept declared so test feedback has a home, and see the graduation rule for why an empty category is not a quiet one.
- **convention** — a documentation or process convention the repo follows, distinct from the code it describes (e.g. how ADRs are amended).
- **gate-calibration** — where an approval gate sits: which changes need the human, which run autonomously, recorded when the gate itself moves.
- **approved-no-changes** — the owner approved a human-gated change with no revisions requested. Logged because a quiet category has to be distinguishable from an unlogged one. It is assigned at verdict time by whoever merges, never predicted before the label comes off: a pre-label entry writes `pending — filled at merge` and waits for the approval it would otherwise be guessing at.
- **other** — feedback that genuinely fits none of the above. Reach for it last: the three entries using it are merge-policy, worktree-lifecycle and verification-rigour items that predate `gate-calibration` and `convention`.

A parenthesised qualifier after the category — `other (verification rigour)`, `issue #2 (plan review)` — is a permitted annotation, not a category. Only the bare word before the parenthesis counts as the category. A feedback item that needs a category not listed here adds one to this list in the same PR as the entry — that is what keeps the list both closed and honest. `pending — filled at merge` is a declared placeholder and not a category: it is valid only on an unmerged branch, where it says the owner has not decided yet and so no category can honestly be chosen. It is deliberately absent from the list above, because a category on that list is selectable and this one must never be.

## Graduation rule

A category going quiet across consecutive reviews is the evidence for graduating that gate toward autonomy (a flag flip in `.claude/workflow.json`, proposed as its own PR, decided by the user). In terms of the vocabulary above:

- Quiet means no change-requesting entry in that category. **approved-no-changes** entries are positive evidence of quiet, not entries against the subject category.
- **gate-calibration** entries record a gate that has already moved. They are the rule's output, not its input, and never count as evidence for the next move.
- A category with no entries at all has never been exercised. That is absence of evidence, not evidence of quiet, and cannot on its own graduate a gate.

---

## 2026-07-30 — PR #52 — worktree-lifecycle-approved-clean

- Category: code-style
- Feedback: "nice yeah 52 looks good merge away" — approved with no change requests. Also closed out the stale sibling branch question: "i think those flags have already been tidied up as part of a different chat so don't worry about those".
- Action: merged (rebased through an append-vs-append conflict in `docs/tech-debt.md` where other tickets had added entries; both sides kept). No guidance change from the user's feedback itself. Logged as graduation evidence for the code-review gate — second consecutive code PR approved clean after #39. Note the counterweight before anyone graduates on this: #52 reached "clean" only after two internal review cycles that found an inert feature and a destructive `--dry-run`, so the human gate saw a PR the loop had already repaired.

## 2026-07-30 — PR #36 — oidc-sub-tighten-now

- Category: architecture
- Feedback: "can we not tighten the sub claim now" — declining to defer the trust-policy narrowing to the later permissions-granting ticket.
- Action: wildcard replaced with a two-value `StringEquals` allowlist before merge. This directly caused the next finding: the tightened policy failed the smoke test, exposing that GitHub now issues ID-embedded immutable subject claims (`repo:OWNER@<ownerId>/REPO@<repoId>:<claim>`) and that our name-based form could never match. A lazier policy would have hidden it. Final policy pins the immutable prefix, with a Terraform `validation` block that rejects a name-only prefix outright.

## 2026-07-30 — PR #37 — pv-runtime-approved-clean

- Category: architecture
- Feedback: "the PV runtime ADR looks good i'll approve that" — TypeScript port plus pvlib-generated golden fixtures accepted as written.
- Action: merged unchanged. No guidance change; logged as graduation evidence for the ADR gate.

## 2026-07-30 — PR #40 — capacity-mode-challenged

- Category: architecture
- Feedback: "the on demand vs provisioned capacity question seems questionable ... at what point would normal use end up being throttled? since this will have very low traffic, we could presumably scale in the fleet size to stay within the free capacity?"
- Action: challenge upheld. The ADR's rejection of provisioned capacity rested on a sustained-rate figure (~1 dashboard load/sec) where a burst-inclusive one belonged; the hourly write cycle turns out to use ~7% of the free allowance with zero GSI amplification. ADR amended before merge to a hybrid — provisioned on the batch-shaped tables, on-demand on the request-shaped ones — for $0 standing cost. Fleet size did not need reducing. **Pattern worth watching: two of three ADR reviews have turned on a quantitative claim that was arithmetically right but answered the wrong question — worth a planner/implementer instruction if it recurs.**

## 2026-07-30 — PR #39 — precommit-approved-clean

- Category: code-style
- Feedback: "the precommit hooks look good i think we can ship that" — approved with no change requests, the first code PR through the human gate.
- Action: merged (rebased onto `main` to resolve a `package.json` scripts conflict with `pnpm verify`). No guidance change needed; logged as graduation evidence for the code-review gate.

## 2026-07-30 — PR #26 — merge-gate-calibration

- Category: other (merge-policy calibration)
- Feedback: Config-only PRs should auto-merge — "the json file in there didn't matter, i'm more on about actual code … how you're structuring functions and modules and components."
- Action: merge rule refined from "every changed file is .md" to "no source-code files"; encoded in `.claude/workflow.json` (this PR).

## 2026-07-30 — issue #2 (plan review) — adrs-human-always

- Category: plan
- Feedback: "ADRs should always require a human review" — major decisions, the right altitude for human guidance without going deep into code.
- Action: `docs/adr/**` added to `merge.humanAlways`; `adr` added to `planApproval.alwaysRequiredFor`; skills updated (this PR).

## 2026-07-30 — issue #2 (plan review) — demo-abuse-and-auth

- Category: plan
- Feedback: Anonymous site creation is an abuse/cost surface — wants a site cap with oldest-eviction, cheap IP rate limiting with auto-block, and friction against programmatic API use; auth is future expansion whose placement must be considered, not foreclosed.
- Action: #29 (demo abuse & cost protection; now blocks #21) and #30 (auth placement design) created; ADR 0001 amended to acknowledge both as deferred forces (this PR).

## 2026-07-30 — PR #35 — worktree-exclusivity-and-reaping

- Category: other (process / worktree lifecycle)
- Feedback: Questioned whether worktree use is exclusive — "we should never be actively using the main checkout surely? … surely that's the root cause of this issue?" Then, on lifecycle: "some kinda prune on merge workflow would be good to keep worktrees from spiralling … unless the worktree was going to be re-used to persist local artefacts for a follow up PR (e.g. change the branch for the worktree)."
- Action: #42 created for the lifecycle decision (prune-on-merge vs rebranch-and-reuse, plus parking the main checkout on `main`). Not decided unilaterally: the reuse case the user raised is load-bearing, since a reused worktree keeps `node_modules` and therefore cannot reproduce #34's unresolvable-import failure at all.

## 2026-07-30 — PR #35 — audit-beyond-the-reported-symptom

- Category: other (verification rigour)
- Feedback: "are there any other places that need to ignore the worktree?"
- Action: The audit this prompted found `format:check` was vulnerable too and that `.claude/worktrees/` had never actually been gitignored (only `.git/info/exclude`, which is machine-local) — both fixed in #35, correcting a false claim the first commit had already encoded as a code comment. Promoted into the workflow via #41: `implementer.md` now requires a negative control for any change whose purpose is to alter whether a check fires, and forbids asserting a check was unaffected without testing it.

## 2026-07-30 — issue #38 — teardown-rehearsal-non-destructive

- Category: plan
- Feedback: "for 38, C5, i think we should go for the non destructive route (and generally going forwards this should be the case, the planned destroy should be sufficient)"
- Action: #38's C5 amended on the issue: acceptance evidence is `terraform plan -destroy` enumerating the resource (`Plan: 0 to add, 0 to change, 8 to destroy.`), not an executed teardown/re-spin-up cycle. **Standing policy for future plans**: the full destructive teardown rehearsal was run once for #7 to prove the runbook; subsequent infra tickets verify teardown participation via planned destroy only. Planner guidance: when writing infra acceptance criteria, "verified removed by teardown" means the resource appears in a destroy plan, not that teardown was executed.

## 2026-07-30 — debt-burn-lane

- **Category**: gate-calibration
- **Feedback**: Small, proven, well-scoped tech-debt tickets ("already well scoped/proven") may auto-plan (issue body as plan) and auto-merge on green CI + clean review loop, even for source code. Bigger themes needing re-structure/re-think stay human-gated — but a pending user decision must never block the debt-burn lane ("if i'm not at my laptop... i don't want that to stop progress").
- **Why**: The review gate exists to check style/architecture direction on novel structures. Debt tickets re-apply already-reviewed patterns to known files; the marginal review value is near zero and the waiting cost is real.
- **How applied**: `debt-burn` label + `planApproval.debtBurn` + `merge.debtBurnRule` in `.claude/workflow.json`; triage applies the label.

## 2026-07-31 — refactor-lane

- **Category**: gate-calibration
- **Feedback**: "PR 80 looks good to go, things like that can probably auto merge, changes that will bake in the shape of functions etc i do want to review though."
- **Why**: A behaviour-preserving refactor (mechanical moves, style conversion, file splits) whose PR proves no API-shape or semantic change carries near-zero review value for the user; the review that matters is on decisions that ossify — new abstractions, signatures, public surfaces.
- **How applied**: `merge.refactorRule` in `.claude/workflow.json`: auto-merge on green CI + review-loop APPROVE iff no exported-API shape change, no semantic change (assertions unmodified, goldens byte-identical), and the PR body proves both. PR #80 is the precedent for the lane; #77 C3 (adapters → classes) is the precedent for what stays human-gated.

## 2026-07-31 — plan-file-references

- **Category**: plan
- **Feedback**: "you're referencing files within a worktree, this is fragile as worktrees could end up being reaped. we should only reference files on main or files on another branch if not on main"
- **Why**: Plans are durable (they live on issues); worktrees are not (reaped on merge or by sweep). The #19 plan's references into the `15-design-system` worktree were already dead when the user read it.
- **How applied**: `planner.md` rule: repo-relative paths on `main`, or `<branch>:<path>` for unmerged files, never worktree paths; translate before posting. The #19 plan comment was edited to main-relative paths; #16/#17 audited clean.

## 2026-08-01 — review-gate-graduation

- **Category**: gate-calibration
- **Feedback**: "ah yeah can we sort the human review gate issue, i'm hoping you can run a bit more autonomously" — following the 2026-07-31 retro's finding that human gates left no artefact (merged source PRs kept `awaiting-review`, no feedback-log entries), so no category could ever go quiet enough to graduate. During the same stretch the user approved every source PR without changes ("merge away on those PRs i've not reviewed them").
- **Why**: Ten consecutive source PRs (#95, #97, #114, #116, #119, #121, #124, #130, #131, #132) merged on exactly CI-green + review-loop APPROVE, several with 2–3 review cycles catching real correctness bugs before merge. The internal review loop is doing the load-bearing review; the human gate on ordinary source PRs had become a latency cost with no recorded findings.
- **How applied**: `merge.reviewedSourceRule` (source PRs auto-merge on CI green + review-loop APPROVE), `merge.humanAlways` extended to `.claude/workflow.json` and `CLAUDE.md` (the gates never pass through themselves), `merge.mergeRitual` (label off + one feedback line on every human-gated merge, even "approved, no changes"), and `planApproval.mode` → `auto` (ADR plans and user-only questions still stop). Tightening path stated in `merge.note`: a bad merge reverts by PR and logs what the review loop missed.

## 2026-08-01 — architecture-trigger-row

- **Category**: approved-no-changes
- **Feedback**: "where do i approve 134 … i did give the go ahead for that" — owner approval for the #134 decision: broaden CLAUDE.md's architecture-index trigger row with "restating an infrastructure value in code".
- **Why**: `docs/standards/architecture.md` rule 8 (declare tf↔code mirrors in the mirror gate) gained its doc-level trigger in #132, but the CLAUDE.md index row still listed only the original three triggers — a reader who never opens the doc misses rule 8's case. The #132 implementer correctly refused to edit CLAUDE.md on agent authority and parked the one-line diff for the owner.
- **How applied**: The one-line diff from PR #132's review comment applied verbatim; closes #134.

## 2026-08-01 — adr-amendment-convention

- **Category**: convention
- **Feedback**: "my concern is that the numbers being wrong in that document could create an impression that could cause confusion even if the file isn't explicitly read and interpreted wrong … i wonder whether there are certain cases where updating an ADR (with a note as to what was updated and why at the bottom) might be better than keeping them as immutable?" — confirmed: "the change to the adr convention sounds good".
- **Why**: Planners are instructed to read ADRs before code, so stale authoritative numbers propagate into plans silently (observed risk: #136's planner derived arithmetic from ADR 0004; #122's plan cited ADR 0002's consequences). Classic ADR immutability protects against retconning decisions, but its archival half is redundant with git history; what it costs is single-source-of-truth for current state — the property agents need most.
- **How applied**: `docs/adr/README.md` gains the Amendments convention (decisions/rationale/status immutable, supersession for changed decisions; stated values the code legitimately moved are trued up inline + dated `## Amendments` footer entry naming old → new, driver, and the owning code location; guardrail — an amendment never touches reasoning). First worked example: ADR 0002's retry figures (4 → 2 attempts, #122). Closes #138.

## 2026-08-01 — adr-0006-abuse-protection

- **Category**: approved-no-changes
- **Feedback**: "approve" — owner ratified ADR 0006's four decisions as presented: MAX_USER_SITES = 40, the 30/60 s → 1 h block threshold, no WAF (HTTP-API unattachable; CloudFront-in-front recorded as the upgrade path with the limiter-identity prerequisite), and the free-10 alarm allocation with the 11th at $0.10/month.
- **Why**: `docs/adr/**` is a humanAlways path; the ADR is where the decisions that ossify live, and the four numbers above are the ones a future reader will hold the owner to.
- **How applied**: PR #147 merged on the approval; C8's live evidence run (E1–E7) closes #29 against the deployed behaviour.

## 2026-08-03 — adr-0007-ttl-only-deletion

- **Category**: design-question-then-approval
- **Feedback**: "could we update the TTL to expire asap for that series instead of doing a batch delete? … what if there are custom sites that have been around for a while, that have a large series?" — then, on the analysis: "the ttl one seems like a good decision, i approve".
- **Why**: The owner probed whether TTL-to-now beats TTL-only for orphaned series. Analysis showed TTL-to-now costs the same writes as the batch delete it replaces and re-grants the IAM series-write the PR removes; the rolling 90-day `expiresAt` cap means no site ever holds more than the retention window, so the "large old series" case cannot arise; orphan storage is ~$0.0003–0.0006/site/month inside the free 25 GB. A privacy-shaped requirement (not in scope) would change the answer to an offline sweeper behind its own issue — noted on ADR 0007's revisit triggers.
- **How applied**: PR #211 merged as-is on the approval (TTL-only deletion, ADR 0007; closes #167).

## 2026-08-04 — adr-0002-amendment-capacity

- **Category**: approved-no-changes
- **Feedback**: "227 and 245 look good" — owner approval for ADR 0002's dated Amendments entry recording the weather table's move to PAY_PER_REQUEST (#156) and the capacity figures the change retired.
- **Why**: `docs/adr/**` is a humanAlways path; the amendment trues the ADR's stated values without touching its reasoning, per the convention decided 2026-08-01, and the PR body flagged the three historical mentions left as legitimately past-tense.
- **How applied**: PR #227 merged on the approval.

## 2026-08-04 — architecture-trigger-owned-values

- **Category**: approved-no-changes
- **Feedback**: "227 and 245 look good" — owner approval for widening the architecture trigger pair (CLAUDE.md standards index row + `docs/standards/architecture.md`'s own Trigger line) to fire on restating an owned value in code **or prose**, keeping the two phrasings in step.
- **Why**: CLAUDE.md is a humanAlways path; the trigger is what routes agents to rule 9, and #231's review showed the narrow phrasing under-firing on prose restatements.
- **How applied**: PR #245 merged on the approval.

## 2026-08-09 — PR #287 (#258 cumulo-series on-demand flip)

- **Category**: approved-no-changes
- **Feedback**: "287 looks good to me happy to proceed there" — owner approval in chat for the billing-mode flip and its ADR 0002 Amendments entry.
- **Why**: `docs/adr/**` is a humanAlways path; the amendment records that no table draws on the free 25/25 pool any more, a fact the ADR's own body predates.
- **How applied**: merged on the approval; `terraform apply` on infra/storage follows immediately to stop the live twice-hourly throttle alarms.

## 2026-08-09 — PR #294 (attribution constraint amendment)

- **Category**: approved-no-changes
- **Feedback**: "294 looks good you can merge when ready" — owner approval in chat for the CLAUDE.md hard-constraint amendment (compact Open-Meteo attribution form at narrow widths).
- **Why**: CLAUDE.md is a humanAlways path; the amendment relaxes mandated wording while keeping the visible link non-negotiable, and the owner had pre-approved the concept in the #284 D18 discussion.
- **How applied**: merged on the approval; #284 D18 builds on it.

## 2026-08-10 — PR #345 (#336 task-orchestrator adoption)

- **Category**: approved-no-changes (workflow adoption)
- **Feedback**: no revisions requested — the owner pre-approved the task-orchestrator adoption in session across 2026-08-09/10, recorded on [#336](https://github.com/TomBennett-Lloyd/cumulo/issues/336#issuecomment-5234760505) before the PR opened, and the PR merged under that pre-approval.
- **Why**: PR #345 touches `CLAUDE.md` and `.claude/workflow.json`, both `humanAlways` paths, so the merge needed the owner rather than a green CI plus review-loop APPROVE; the recorded pre-approval is that owner decision, given on the design record the PR extracts (`docs/design/task-orchestrator.md`) rather than on the diff. The quality evidence sat beside it, not in place of it: the review loop ran to its 3-cycle cap and returned APPROVE with zero FIX-NOW.
- **How applied**: merged under the pre-approval; `awaiting-review` applied and removed at merge per the policy's bookkeeping, and this entry is the log line the policy requires. Two systemic findings went to `docs/tech-debt.md`, and the 2026-08-10 triage folded both into [#359](https://github.com/TomBennett-Lloyd/cumulo/issues/359) — that issue, not the log, is where they live now; discovered scope became #338.
- **Bookkeeping note (added 2026-08-10, batch retro)**: this entry was written by PR #348's implementer, not by #345's merger — the merge owed it and did not log it, while #345's PR body stated that it had. It is retroactive rather than merge-time, which is the gap P1 of `docs/retro-proposals-2026-08-10.md` closed — that file was deleted by the PR that applied its proposals; its full text is at commit `a32d103`, and the decisions it carried are recorded in this log's `2026-08-10 — issue #368 — retro-proposals-2026-08-10-applied` entry.

## 2026-08-10 — PR #348 (#337 design principles adopted)

- **Category**: approved-no-changes (design adoption)
- **Feedback**: no revisions requested — the owner approved the distilled design principles and their landing route in session on 2026-08-10, recorded on [#337](https://github.com/TomBennett-Lloyd/cumulo/issues/337#issuecomment-5235126347) ("approval to build it and also merge when it's done") before the PR opened, and the PR merged under that recorded waiver.
- **Why**: PR #348 touches `CLAUDE.md` — a `humanAlways` path — because the design principles bind through a standards-index trigger row, so the merge needed the owner rather than green CI plus a review-loop APPROVE. The approval was given on the proposal the PR preserves verbatim (`docs/design/design-principles.md`) rather than on the diff, and it explicitly covered the merge as well as the build, which is what makes it a waiver rather than a build authorisation. The quality evidence sat beside it and not in place of it: the review loop ran its full 3 cycles, cycle 1 REVISE (4 FIX-NOW), cycle 2 REVISE (1 FIX-NOW — a literal the cycle-1 fix round itself re-introduced, caught by a family sweep), cycle 3 APPROVE with 0 findings at the cap.
- **How applied**: merged under the recorded waiver; `awaiting-review` applied and removed at merge per the policy's bookkeeping. One SYSTEMIC finding (an undeclared category in this very file) went to `docs/tech-debt.md`, where the 2026-08-10 triage folded it into [#359](https://github.com/TomBennett-Lloyd/cumulo/issues/359) — that issue, not the log, is where it lives now; deferred scope became #346 and #347. This entry itself rode the next docs PR rather than the merge, as PR #348's body said it would — the same lag P1 of `docs/retro-proposals-2026-08-10.md` addressed. That file was deleted by the PR that applied its proposals; its full text is at commit `a32d103`, and the decisions it carried are recorded in this log's `2026-08-10 — issue #368 — retro-proposals-2026-08-10-applied` entry. Category form note: `approved-no-changes (design adoption)` is the sanctioned parenthesised qualifier on a declared stem, deliberately, given the open question about this file's one undeclared category.

## 2026-08-10 — issue #368 — retro-proposals-2026-08-10-applied

- **Category**: gate-calibration
- **Feedback**: "the retro proposals all look good to me we should do them too" — the owner's chat decision of 2026-08-10, deciding in one go all four proposals of that day's batch retro (P1, P2(a), P2(b), P2(c)); recorded on [#368](https://github.com/TomBennett-Lloyd/cumulo/issues/368). The proposals lived in `docs/retro-proposals-2026-08-10.md`, which this same PR deletes on that file's own instruction to delete it once decided — it was a hand-off, not a record. Its full text is at commit `a32d103`; this entry is the record.
- **Why**:
  - **P1** (move the merge ritual's feedback line onto the branch, plus a CI gate) — both human-gated merges in the batch missed the after-merge line, in opposite directions: PR #345 omitted it while its own body claimed it had logged it, and PR #348 deferred its line to a later PR. One omission and one acknowledged deferral on consecutive PRs is a structural failure, not a careless one: a step owed _after_ the merge is a step no gate can block, and it falls due at the exact moment the branch is gone and the session's attention has moved to the next ticket. Every other gate in this repo runs before the merge, where a gate can still refuse.
  - **P2(a)** (delete `merge.refactorRule`) — the rule's own text asked to be deleted by "the next gate revision", and P1 is that revision. The calibration record it was kept for (PR #80 vs #77 C3) is not lost with it: this file's own `2026-07-31 — refactor-lane` entry carries the same precedent and the same two PR numbers, in the log that exists to hold it.
  - **P2(b)** (hold `orchestration.mode` at `delegated-pilot`) — no delegated run had completed when the retro was written, so there was no evidence either way: absence of evidence, not evidence of absence, which cannot graduate a gate. One harness observation from the in-flight pilot is banked here because it shapes the evidence bar below: the `task-orchestrator` agent type was not dispatchable at the first attempt after its own merge, so the pilot ran as a `general-purpose` agent reading the contract from `.claude/agents/task-orchestrator.md`. Contract fidelity held (the contract is a file), which makes that run evidence about the _contract_ rather than about the harness's own routing — hence the bar asking for runs on the real type.
  - **P2(c)** (review-feedback graduation rule — no move available) — a fresh census of the ten entries following the 2026-08-01 `review-gate-graduation` entry gives eight **approved-no-changes**, one change-requesting **convention** entry, and one design-question-then-approval. That is about as strong as the quiet evidence will ever get, and it still leaves nothing to relax: the only gates left are the `humanAlways` paths (`docs/adr/**`, `.claude/workflow.json`, `CLAUDE.md`) and `adr` plan approval, which the owner has twice said they want to keep.
- **How applied**:
  - **P1** — `merge.mergeRitual` rewritten so the entry is written **on the branch**, in the commit that responds to the approval, leaving only label-removal at merge; `merge.mergeRitualGate` added to state the mechanical half and its limits; the `merge-ritual-gate` job added to `.github/workflows/ci.yml` (its own job, not `pnpm verify`, which knows nothing about labels); and `CLAUDE.md`'s merge-policy sentence swapped to match, since both files state the ritual in their own words and neither binds the other. P1 turned out to require one more thing than the proposal wrote down: the whole hand-off sequence had to be restated, because landing the gate in only the two files the issue named would deadlock the next `humanAlways` PR — `humanAlwaysRule` put the label before the entry, so the label would go on, the gate would redden CI on the missing entry, and `/run-issue`'s owner relay, which fires only on green, would never reach the owner whose approval is what produces the entry. So `.claude/workflow.json`'s `humanAlwaysRule`, the `review-loop` and `run-issue` skills, `.claude/agents/task-orchestrator.md` and the CI job's own comment now all state one order: the review loop classifies HUMAN, the entry is written on the branch and pushed, CI goes green with the gate satisfied, `awaiting-review` goes on and only then does the owner relay fire, feedback arriving with the approval updates the entry in the commit that responds, and at merge nothing is left but taking the label off — no post-merge commit is ever owed. The rewritten `mergeRitual` forces that order on its own: an entry that **is part of the diff the owner approves** has to exist before the PR is handed to the owner. That string also carries the clause "added in the commit that responds to the approval", which read on its own would put the entry after the approval and therefore after the label — the deadlock above, reconstructable by anyone who opens `mergeRitual` standalone. The half that governs is the first: the entry exists **before** the PR is handed to the owner, and "added in the commit that responds to the approval" governs the _update_ when the approval carries feedback, not the entry's creation. The string is left exactly as the owner approved it, character for character, and this entry is the correction of record. This also supersedes `docs/design/task-orchestrator.md`, which says in several places that the merge ritual is the top-level session's exclusively; those rows are a dated record of what was adopted on 2026-08-09 and are deliberately left as written, since amending a record is a different move from correcting a live contract, and that file's duplication of the agent definition is already tracked on [#359](https://github.com/TomBennett-Lloyd/cumulo/issues/359).
  - **P2(a)** — `merge.refactorRule` deleted from `.claude/workflow.json`. `debtBurnRule` sits beside it in the same subsumed-but-kept state and stays: it is still the anchor for `planApproval.debtBurn`.
  - **P2(b)** — **no diff**. `orchestration.mode` holds at `delegated-pilot`, and the graduation evidence bar is recorded here verbatim so it survives the proposals file's deletion: _three completed delegated runs, at least two with the real agent type, each releasing through a RETRO NOTES comment that a subsequent retro found sufficient as its first-hand input._
  - **P2(c)** — **no diff**. Recorded so the next retro does not re-derive the same dead end: the graduation rule has run out of subjects, and the honest next question is not "what else graduates" but whether the quiet evidence still gets collected at all — which is P1.
  - **P2(d)** — **no diff**, and two things recorded so the proposals file's deletion does not destroy them. The standards-index half found nothing stale: every trigger row in `CLAUDE.md`'s index fired at least once across the twelve PRs — including the `docs/standards/design.md` row PR #348 had just added — none was subsumed by tooling, so no row was deleted. The other half banked a candidate that is deliberately **not** proposed: `.claude/skills/retro/SKILL.md` describes a per-PR retro and has no batch mode, while that run retroed twelve PRs at once and had to invent its own dedupe rule — "a signal shared by several PRs gets one disposition citing them all". That is one instance, and a skill amendment on one instance is the speculative kind of change this workflow exists to avoid, so no amendment is proposed. The trigger is the point of banking it: if a second batch retro runs, the dedupe rule goes into that skill's step 2.
  - This entry is itself this PR's own on-branch ritual line: P1 dog-fooded on the PR that lands it.

## 2026-08-11 — issue #390 — workflow amendment: batch-delegated routing

- **Category**: gate-calibration
- **Feedback**: Approved in chat (2026-08-11): PR #392 merges as written. The approval came with a directive attached — **the next same-surface batch (tooltip batch 2: #330, #343, #347) runs INLINE** as the counterfactual measurement, same batch shape with the top-level session orchestrating directly, with per-ticket token accounting recorded against the delegated batch baseline (~220k/ticket, PR #391). The routing "stays provisional until both cells of that comparison exist"; keep an eye on delegated batches generally rather than treating the routing as settled.
- **Why**: The amendment routes on a comparison with one cell measured. Single-issue tickets have both cells — ~700–900k delegated against ~400k inline — which is what justifies sending them inline. Batches have only the delegated cell (~220k/ticket); the inline-batch number is inferred from the single-issue ratio, not observed. Inferring it is exactly the move this repo's gate discipline refuses elsewhere: `gate-calibration` entries "record a gate that has already moved… never count as evidence for the next move", and a routing rule resting on an unmeasured cell would be evidence of the kind it forbids. Running batch 2 inline costs one batch and closes the gap with a measurement instead of an inference — and it is falsifiable in the direction that matters, since if inline batches also come in near 220k/ticket then delegation buys nothing anywhere and the amendment is half wrong.
- **How applied**: PR #392 merged as approved, unmodified — `.claude/workflow.json` `orchestration.mode` → `batch-delegated` with `routeRule`, `costEvidence`, `delegatedContract`, `modeHistory` and `rollback`; the `CLAUDE.md` Orchestration bullet reduced to a pointer at that key; synchronous sub-agent dispatch, a narration ban and ticket-scoped scratch names in `.claude/agents/task-orchestrator.md`; shape-routing and a no-poll note in `/run-issue`; orchestrator-authored prose named as a cycle-1 review target in `/review-loop`; `docs/standards/architecture.md` rule 10 and its `CLAUDE.md` trigger row for _changing_ an owned value; `commit.cleanup=whitespace` in `package.json`'s `prepare`; four `docs/friction-log.md` entries. The counterfactual directive is **not** in that diff and is deliberately not written into `orchestration` as a pending condition — `rollback` already names what would move the rule, and a half-measured comparison does not belong in a key that reads as settled. It lives here, where the next retro looks: batch 2 (#330, #343, #347) runs inline, its per-ticket accounting goes to the retro that closes it, and `orchestration.costEvidence` gains the inline-batch cell — or the routing changes — at that point. Under the P2(b) bar recorded in the entry above, this PR is the "subsequent retro" and the three runs (#334, #321, #200) are its subjects: the contract half of the bar is met, the agent-type half is unrecorded in the handovers and is stated as unrecorded in `delegatedContract` rather than assumed.

## 2026-08-11 — issue #415 — retro-P1-security-standards-trigger

- **Category**: convention
- **Feedback**: owner approved P1 in chat (2026-08-11) — create `docs/standards/security.md` and add the proposed standards-index row to `CLAUDE.md` after the `error-handling.md` row. The proposal lived in `docs/retro-proposals-2026-08-11.md`, which this PR deletes on that file's own convention; its full text is at commit `8abea51`, and this entry is the record.
- **Why**: #176/PR #393's implementation opened a same-origin framing hole, caught by review cycle 1 before merge — `child-src 'self'` was added _defensively_, and CSP3 gives `child-src` two dependants, `worker-src` **and** `frame-src`, so the one directive added for safety is what opened the gap. It never reached `main`: `frame-src 'none'` and the `child-src` grant entered together in that PR's single merge commit (`075f06c`), which is also the commit that created `infra/web/content-security-policy.tftpl`. The index was not silent: the `architecture.md` module row fired on the new files and typed code was written under the typing row. Every row that answered answered about something else, and no row anywhere covers a directive whose absence inherits from another directive. What caught it was reading the CSP3 fallback table — nothing routed anyone there, and #176's handover calls it the clearest under-firing in the ticket. The surface is small (one response-headers policy, one CSP template, one CORS answer) and it is also the surface where a mistake is least visible from the outside, which is the argument for a doc rather than against one.
- **How applied**: `docs/standards/security.md` created — the CSP fallback chains as a table, the deny-by-default posture (a directive is added only when its absence is shown to break something), and the rule that adding a directive requires naming every directive that inherits from it — self-contained and one hop, per the index's own contract. The proposed row added to `CLAUDE.md`'s standards index immediately after the `error-handling.md` row.

## 2026-08-11 — issue #415 — retro-P2-argued-comment-trigger

- **Category**: convention
- **Feedback**: owner approved P2 in chat (2026-08-11) without picking between its two forms. **Form B — its own index row** rather than an extension of the `structure.md` row — is the orchestrator's call, recorded on [#415](https://github.com/TomBennett-Lloyd/cumulo/issues/415) so the owner's one-read decides it from one place instead of reconstructing it from the diff. The rationale recorded there: a trigger works by matching the act being performed, and "changing behaviour a comment argues for" is not recognisably "creating or splitting a file", so grafting it onto the `structure.md` row would hide the trigger at exactly the moment it should fire. Proposal text at commit `8abea51`.
- **Why**: #367/PR #394 — `layoutBoxOf`'s docblock explicitly defended the racing two-read shape the ticket existed to remove, and nothing in the index fires on "you are changing code whose comment justifies the behaviour you are removing". The plan caught it only because the orchestrator dispatched it as an explicit instruction, and the defect then recurred twice inside the same ticket: cycle 1 found three inaccuracies in the replacement prose, cycle 2 found that cycle 1's own new tech-debt entry asserted something false about Playwright's `toBeVisible`. Review did catch it, three times over — so the honest framing is that the trigger buys the finding earlier, not that it buys the finding at all. Form B is also the form the owner's P3 answer argues for: rules read close to the point of use leave less room for the obligation to go missing.
- **How applied**: its own row in `CLAUDE.md`'s standards index, beside the `architecture.md` row; `docs/standards/architecture.md` gains rule 11 — a comment that argues for a behaviour is a carrier of that behaviour, so an argument's carriers carry the same obligation rule 9 gives a claim's — plus the matching extension to that doc's own Trigger line, keeping the two phrasings in step.

## 2026-08-11 — issue #415 — retro-P3-humanAlways-reinterpretation-declined

- **Category**: gate-calibration (declined — gate holds)
- **Feedback**: P3 asked whether a branch that restates or re-scopes a `humanAlways` file's rule in prose should be gated the same way as one that edits the file. **Declined** (chat, 2026-08-11). The owner's reason, near-verbatim: "the rule should be sufficiently clear that expansion or summary is safe in the right context; and most of the time rules should be read close to the point of use, so there's less room for Chinese whispers." Proposal text at commit `8abea51`.
- **Why**: this entry records where the gate sits — reinterpreting a `humanAlways` file's wording in prose does not trip the gate. The evidence behind the question was #356/PR #395, where `CLAUDE.md`'s attribution constraint was read as "the row as composed", a broader condition than its text, and that reading was stated as governing at seven sites; editing the file trips the gate, silently reinterpreting it in prose tripped nothing, and review cycle 2 rather than planning caught it. The owner's answer puts the remedy on the rules rather than on the gate: the fix for a divergence like P5's is clearer owned rules and point-of-use reading, not a broader label. That also avoids what the two "yes" answers cost — the procedural form fires on ordinary design-doc work often enough to erode the label, and the narrow form cannot be mechanised, since nothing distinguishes a paraphrase from a re-scoping without reading both.
- **How applied**: no `.claude/workflow.json` change; this entry is the record. A declination is a decision, not a backlog item — the question is closed rather than deferred, and the proposals file is deleted just the same. One note for the graduation rule: this entry records a gate that _held_ rather than one that moved, and like every `gate-calibration` entry it is the rule's output, never evidence for the next move.

## 2026-08-11 — issue #415 — retro-P4-attribution-compact-form-reading

- **Category**: convention
- **Feedback**: owner approved **reading 2** (chat, 2026-08-11) — the compact form is sanctioned at widths where the row _as composed_ cannot hold both credits' full forms, which is the reading #356 shipped. The breakpoint does not move. Proposal text at commit `8abea51`.
- **Why**: the row is what the user sees, and a row that overflows is not attribution either. Reading the condition against the composed row is what puts the map band's shipped behaviour inside the sanction across the stretch of widths where the weather phrase alone would still fit but the pair does not. Both readings honour the hard constraint's non-negotiable link in every state, so the licence obligation was at risk under neither — the question was which sentence the code answers to, not whether CC BY 4.0 was satisfied.
- **How applied**: `CLAUDE.md`'s attribution sentence trued up to say so, now reading "at widths where the row as composed cannot hold its credits' full forms, the bare linked name is the sanctioned compact form (CC BY 4.0 §3(a)(2) permits medium-appropriate attribution; owner-amended 2026-08-09, composed-row reading owner-confirmed 2026-08-11)". The breakpoint is unmoved — it already implemented this reading — and its own docblock in `apps/web/src/map/map.css` still owns the derived value. `docs/design/map-treatment.md`'s Attribution section drops its pending-owner-answer hedge for the confirmation record. The code-comment carriers that still frame the composed row as _this repo's reading_ rather than as the sentence's own object are outside this PR's scope and are spun out to [#416](https://github.com/TomBennett-Lloyd/cumulo/issues/416), which owns the full list — with line ranges, plus the audit-as-likely-fine pointers — so no enumeration of them is restated here. That list is itself a **floor, not a census**: it is what `command grep -rlE "compact form|owner-amended 2026-08-09|row (as composed|cannot hold)" apps packages docs CLAUDE.md` returned, classified, and paraphrasing carriers that wrap the phrase across lines are exactly what such a sweep under-returns — so re-run it on #416 rather than trusting the enumeration there.

## 2026-08-11 — issue #415 — retro-P5-review-loop-cap-sentence

- **Category**: convention
- **Feedback**: owner approved P5 in chat (2026-08-11) — replace `CLAUDE.md`'s review-loop Workflow bullet with the proposed text verbatim. Proposal text at commit `8abea51`.
- **Why**: that bullet was the last gated carrier of the pre-amendment bound. The 2026-08-11 retro pass added a scoped confirmation pass on the final fix diff, because a capped loop had no way to earn the APPROVE `reviewedSourceRule` demands — four PRs (#391, #395, #398, #400) had already invented that route independently — and it trued every non-gated carrier it found: `review-loop`'s frontmatter and opening bound, `.claude/agents/task-orchestrator.md`'s stop-list and both report templates, and `docs/design/task-orchestrator.md`'s ownership-split role table, one-loop-per-batch paragraph, bounce-round item, risk-table row and mirrored templates. `CLAUDE.md` could not move with them, so until this PR it disagreed with `review-loop` and both `task-orchestrator` documents about where the loop ends. The divergence was one-directional and therefore safe — an agent following the gated sentence stops early and hands the PR to the confirmation pass late, rather than merging something unreviewed — but it was a live contradiction, which the ledger named as known rather than leaving it to be rediscovered.
- **How applied**: the bullet replaced verbatim with "- Review loop (`/review-loop`): max 3 cycles, plus a scoped confirmation pass on the final fix diff. Systemic findings go to `docs/tech-debt.md`, not into endless iteration. Correctness bugs always block merge." The restatement ledger in `.claude/skills/review-loop/SKILL.md` moves with it: its `CLAUDE.md` carrier clause goes from naming the divergence as known-and-live to recording it as resolved by owner decision, so the ledger no longer advertises a contradiction that no longer exists.

## 2026-08-11 — issue #415 — retro-proposals-2026-08-11-applied

- **Category**: approved-no-changes (provisional until the owner's one-read — see Feedback)
- **Feedback**: this PR's own on-branch merge-ritual line, written **before** the owner's one-read as `merge.mergeRitual` requires (entry before label, always) and updated in the commit that responds if the one-read carries feedback. What the owner has approved so far is the _decisions_ (chat, 2026-08-11: P1, P2, P4 and P5 approved, P3 declined), recorded on [#415](https://github.com/TomBennett-Lloyd/cumulo/issues/415); the diff is what the one-read is for, so the category above is provisional and moves if revisions come back.
- **Why**: `CLAUDE.md` is a `humanAlways` path and this PR edits it in four places, so the merge needs the owner rather than green CI plus a review-loop APPROVE. Two judgement calls are what the one-read is really being asked to check, and both are flagged on the issue rather than left to be inferred: **P2's form** — Form B, its own index row, chosen by the orchestrator because the owner approved the trigger without picking a form — and **P4's reading** — reading 2 endorsed and `CLAUDE.md` trued up to it, rather than reading 1 held and the breakpoint moved. The new `docs/standards/security.md` prose is the third thing worth the read: it is a new owned doc rather than an amendment to one.
- **How applied**: `docs/retro-proposals-2026-08-11.md` is deleted by this PR, on that file's own convention that the applying PR deletes it once its proposals are decided — it was a hand-off, not a record. Its full text is at commit `8abea51`, and the decisions it carried live in the five entries above, which are the record. `awaiting-review` goes on only after CI is green with this entry already part of the diff, leaving nothing at merge but taking the label off.

## 2026-08-11 — issue #409 — provisional-verdict-form

- **Category**: approved-no-changes
- **Feedback**: The owner is asked to decide three things, and this entry states the ask only — it predicts no part of the answer. (a) The provisional entry form declared in `## Entry format` above: an entry on a `humanAlways` branch is written before the owner speaks, states the ask, and leaves **Category** and **Verdict** as `pending — filled at merge` for whoever merges to fill on the branch before the label comes off. (b) The rewrite of `merge.mergeRitual` in `.claude/workflow.json`, which now points at that declaration instead of restating what the entry must contain. (c) This batch's `.claude/workflow.json` diff as a whole, that file being a `humanAlways` path. What the owner decides goes in **Verdict** below, at merge.
- **Why**: `.claude/workflow.json` is a `humanAlways` path, so this batch cannot merge on green CI plus a review-loop APPROVE — the owner is the gate. The ask has to be put provisionally because `merge.humanAlwaysRule` orders the entry ahead of the label: the entry exists before the owner has seen the PR, and at that moment the file can honestly hold the question but not the answer. The previous four-field form left the writer no way to say so, so a pre-label entry had to write a category and a verdict for a decision that had not happened — a prediction in the shape of a record, and unfalsifiable afterwards because a filled field looks the same either way. Splitting the entry into an ask written before and a verdict filled at merge makes the unfilled state visible instead. The pointer half is the same discipline applied to the declaration itself: `docs/standards/architecture.md` rule 9 gives a stated value one owner, and what a review-feedback entry must say is owned by this file's `## Entry format` section, not by a JSON string that had drifted into restating it.
- **How applied**: Batch #412 (members #412, #409, #408 — docs and config only, no source code). In this file: the opening paragraph now says entries on `humanAlways` PRs begin on the branch and complete at merge; `## Entry format` gains the **Verdict** field and the pre-label declaration; `## Category vocabulary` gains two riders — the placeholder is not a category, and **approved-no-changes** is assigned at verdict time rather than predicted. In `.claude/workflow.json`: `merge.mergeRitual` now points at `## Entry format` for the entry's content, keeps the distinguishability sentence and its dated history, and sheds both the restated "category from the closed vocabulary" clause and the ambiguous "added in the commit that responds to the approval" clause — the clause whose standalone reading the `2026-08-10 — issue #368 — retro-proposals-2026-08-10-applied` entry above had to correct in prose. That entry stands exactly as written, per this file's convention that entries are the record; this entry is where the clause's removal is recorded. `merge.humanAlwaysRule` needed no edit for the entry's fields, which it never restated. `merge.mergeRitualGate` is the other case: its closing clause — "the prose half above still owns what the entry must say" — is stale the moment `mergeRitual` disclaims that ownership, and it is logged to `docs/tech-debt.md` rather than fixed here, because its twin sits in a fenced `.github/workflows/ci.yml` comment and the statements have to move together (`humanAlwaysRule`'s own "mergeRitual owns what it must say" parenthetical is in that same logged set). Sibling chunks in the same batch add a sanctioned-evidence-idioms page under `docs/standards/` (#412) and reconcile `infra/README.md` with the merge policy (#408). This entry is the first written in the form it asks the owner to approve.
- **Verdict**: Approved without changes — owner, in chat, 2026-08-11 ("PR 418 and 420 looks good"), covering all three parts of the ask. Filled on the branch by the merge owner before the label came off, which is the form's own first exercise: the ask above was written when the answer did not exist, and this line is the answer, so a reader can tell a checked approval from an unchecked prediction without reading git history. The category was assigned here, at verdict time, rather than predicted pre-label.
