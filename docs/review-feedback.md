# Review-feedback log

Every substantive piece of human review feedback — on plans or PRs — gets an entry here as it is addressed. `/retro` mines this log to update standards and agent guidance; a category going quiet across consecutive reviews is the evidence for graduating that gate toward autonomy (a flag flip in `.claude/workflow.json`, proposed as its own PR, decided by the user).

Entry format:

```
## YYYY-MM-DD — PR/issue #n — <short-slug>
- Category: plan | code-style | architecture | testing | other
- Feedback: what the user asked for, verbatim where short
- Action: what changed in response (code fix, standards edit, agent-guidance edit, or none + why)
```

One entry per distinct feedback item; the slug names that item's subject and disambiguates multiple items arising from the same review.

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
