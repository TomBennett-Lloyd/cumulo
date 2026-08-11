# Friction log

Weak signals from `/retro` that don't yet have a clear improvement action — recorded so patterns become visible across tasks ("we churn on X in half of tasks") instead of being forced into premature lessons. `/triage` mines this for repeats (≥3 similar entries, or affecting ≥50% of recent tasks) and converts patterns into workflow issues, deleting captured entries. Singletons stay until they repeat or go stale.

Entry format:

```
## YYYY-MM-DD — PR #n
- Phase: planning | implementation | review | process
- Observed: one concrete observation, no proposed fix required
```

---

## 2026-07-31 — PR #71

- Phase: implementation
- Observed: `python -m venv` writes a `.gitignore` inside the venv so git ignores it, but Prettier's `format:check` does not honour nested `.gitignore` files — a worktree that `git status` calls clean still produced transient format reds until the venv path was excluded.

## 2026-08-01 — PR #14

- Phase: implementation
- Observed: `pnpm add` inserts its `allowBuilds` placeholder into `pnpm-workspace.yaml` alphabetically, which can slide the new entry between an existing entry and the justification comment above it — silently re-parenting that comment onto a package it does not describe. The supply-chain gate then fails on a line nobody edited. The gate behaved correctly; the surprise is pnpm's insertion point. Practice until this bites again: after any `pnpm add`, re-read the whole comment↔entry pairing, not just the line that appeared.

## 2026-08-01 — PR #122

- Phase: process
- Observed: second real STRUGGLING→consultant dispatch (first: #115), and again the consultant beat both implementer options by reframing rather than choosing — here that the exact bound was never sound and that wall-clock and SDK time were being compared as if commensurable. Two for two on "the loop earns its cost when the implementer's options share a wrong premise". No change made; logging the running record so the loop's value stays measurable.
- Triage note (2026-08-03): kept — this is the running record itself, not a duplicate of one. Which copy of that record survives (this entry, or `planner.md`'s restatement of it) is the decision on [#238](https://github.com/TomBennett-Lloyd/cumulo/issues/238).

## 2026-08-02 — session-wide (PRs #169–#207)

- Phase: process
- Observed: twenty-two PRs merged across this unsupervised run (#169 through #207) under the gates graduated on 2026-08-01, every one of them auto-merged — no PR in the span carried the `awaiting-review` label — with zero revert PRs repo-wide, so the tightening condition recorded in `merge.note` has never fired. Banked as evidence for the user's future gate decisions; no change proposed, since what remains gated is the `humanAlways` paths and `adr` plan approval, which should stay in place while the user is away. The absence of new `docs/review-feedback.md` entries in the span is not part of this evidence — the last entry (ADR 0006) predates the run, and zero human-gated merges makes the category unexercised rather than quiet.

## 2026-08-10 — PR #302

- Phase: implementation
- Observed: `pnpm run build -- --flag` is a silent no-op. `deploy-pages.yml` needs `vite build --base=/cumulo/`, and routing the flag through the package script drops it: vite exits **0**, the build is "successful", and the bundle ships with root-absolute URLs that 404 under the Pages sub-path. Nothing red anywhere — the failure is only visible by reading the emitted asset URLs. The workflow uses `exec vite build --base=/cumulo/` instead, and the chunk verified both directions rather than only the working one. Worth remembering as a shape rather than a one-off: any gate or build whose _argument_ is the thing under test cannot be proven by a green exit code.

## 2026-08-10 — session-wide (PRs #301–#348, browser-pane measurement artifacts)

- Phase: review
- Observed: four distinct browser-pane measurement artifacts cost time across the design-pass verification rounds, none of them a defect in the app: readings taken while the pane did not have focus (`document.hasFocus()` false, so focus-dependent state reads wrong); paints deferred past the read, so a geometry poll returns the pre-layout box; the pane's screenshot zoom cropping the region that was actually asked for; and injected script contexts dying mid-sequence, which returns an error that reads like a page failure. Each was diagnosed and worked around in-session and none reached a PR, which is exactly why they are logged — the diagnosis was re-derived from scratch every time. Not written into `browser-smoke.md` yet: the four have workarounds that are each one line of harness knowledge, and turning four remembered incidents into a checklist risks encoding the symptom rather than the trigger. Action if a fifth lands, or if any of these four recurs after this date: write the taxonomy into `.claude/agents/browser-smoke.md` beside the screenshot-scaling rule that already lives there.
- Related: the browser content-tools outage the same session (~1.5h+ with no usable pane) is what produced the deferred-verification pattern now carried by [#342](https://github.com/TomBennett-Lloyd/cumulo/issues/342) — a browser criterion that cannot be measured becomes a filed, named, deferred verification rather than a claim.

## 2026-08-10 — session-wide (PRs #301–#348, dispatches built on a wrong read)

- Phase: process
- Observed: two dispatches this session were built on a read of the repo that was itself wrong, in the same shape both times — the orchestrator asserted a fact about the current state and sent an agent to change it. (a) A "raise X to N" instruction went out without first checking X's current value, which was already at or past N. (b) A line-oriented `grep` census under-counted a prose family because the phrase it searched for was **wrapped across two lines** in several carriers, so the sweep that looked exhaustive was short before the agent read it. Both are cheap to prevent and expensive to discover downstream: (a) wastes a full dispatch, (b) hands an implementer a floor disguised as a census — the failure `reviewer.md`'s own sweep paragraph already names for reviewers, arriving one level up at the dispatcher. Practice until it bites again: read the constant, and prefer a multiline-tolerant sweep (`rg -U`, or grep the distinctive half of the phrase) before quoting a count into a dispatch.

## 2026-08-10 — session-wide (PRs #345, #348)

- Phase: process
- Observed: the `task-orchestrator` agent type merged by PR #345 was **not dispatchable at the first attempt after its own merge** — the registry the session was dispatching against did not carry it yet. The delegated pilot on #331 therefore ran as a `general-purpose` agent handed the contract to read from disk (`.claude/agents/task-orchestrator.md`), which preserved fidelity — the contract is a file, and reading it is what the agent type would have done — but at the cost of the harness's own agent-type routing (model tier, tool restriction) being supplied by hand. It then became available **later in the same session**, after the definition file had reached the session's own worktree through a rebase, and dispatches from that point got the real type. What was observed is that sequence, not a mechanism: whether the worktree copy arriving is what registered the type, or the registry simply refreshed on its own, was never established, so there is no "one session behind" rule to lean on. No workflow change proposed: the constraint belongs to the harness, not the repo, and the read-from-disk workaround is exactly the design property #336 argued for. Logged so that the next agent-definition PR reads a missing type as this rather than debugging it — and knows to retry rather than assume the type is unavailable for the rest of the session.

## 2026-08-10 — session-wide (PR #348, and #296 PR A before it)

- Phase: implementation
- Observed: the harness's safety classifier refuses security-adjacent prose on sight, including prose that only _describes_ an attack in order to test a defence. It bites twice in this repo's shape of work. In #296 PR A the coverage claim about the per-IP limiter had to be established by an exhaustive read of the test file rather than by the demonstration that would have proved it, because the demonstration means writing an edit that removes a rate limit (recorded at the time in `docs/tech-debt.md`, and now carried by [#309](https://github.com/TomBennett-Lloyd/cumulo/issues/309), which this session's triage folded that entry into). The pattern that works is a safe rewording — state the property positively ("the limited set is exactly these routes") and prove it by construction, rather than by describing the bypass. Logged rather than turned into guidance: the reword is obvious once you have hit the refusal, and a rule that says "avoid tripping the classifier" would be a rule about a moving target.

## 2026-08-10 — session-wide (PRs #301–#348, sub-agent text posted verbatim)

- Phase: process
- Observed: text returned by a sub-agent arrives HTML-entity-escaped (`&amp;`, `&lt;`, `&gt;`, `&#39;`), and posting it verbatim to a GitHub issue or PR body publishes the escapes. It is invisible in the agent's own report and only visible after the comment lands, at which point fixing it means an edit whose diff is noise. Decode before posting anything that travelled through a task result. No fix proposed — it is one step in one place, and the place is the orchestrator's own posting path rather than a file anyone else reads.

## 2026-08-10 — session-wide (PRs #301–#348, a wedged agent and a full disk)

- Phase: process
- Observed: a sub-agent wedged with no output and no progress, and the cause was the **disk**, not the agent — the machine had filled, so every write the agent attempted failed silently from the orchestrator's side. Re-dispatching would have wedged the replacement identically. Cheap check, expensive omission: before re-dispatching any agent that produced nothing, check free space (and the worktree's own `pnpm install` state) rather than assuming a bad prompt or a stalled model. Sits beside the existing browser-agent rule in `browser-smoke.md`, which is about _stalls being visible_; this is about the stall's most boring cause being checked first.

## 2026-08-10 — session-wide (pattern to keep)

- Phase: process
- Observed: two things worked well enough this session to be worth recording as evidence rather than left as impressions. (a) **A design-feedback batch converted straight into a backlog**: the owner's 2026-08-10 review became 15 filed issues (#323–#331, #335 and neighbours) in one pass, and the de-duplication check against the existing backlog found it clean — no issue in the batch restated one already open, which is the outcome that makes batching worth doing rather than the one it is usually feared for. (b) **Orchestrator co-design reaching adoption in the same session**: #336 (task-orchestrator) and #337 (design principles) were both designed with the owner in session, approved on the issue, and landed as PRs #345 and #348 hours later — the approval record on the issue is what let each PR merge under the `humanAlways` gate without waiting. The cost side is on the record too: both PRs ran to the 3-cycle cap, and #345's merge dropped its required review-feedback line (see `docs/retro-proposals-2026-08-10.md` — deleted by the PR that applied its proposals; its full text is at commit `a32d103`, and the decisions it carried are recorded in `docs/review-feedback.md`'s `2026-08-10 — issue #368 — retro-proposals-2026-08-10-applied` entry). Logged as a win with its price attached, so a future retro comparing lanes has the whole number.

## 2026-08-10 — PRs #386, #389 (issues #334, #200)

- Phase: process
- Observed: parallel tickets are blind to each other's in-flight systemic findings, and the blindness is expensive precisely when they are working the same substrate. #334 and #200 ran concurrently over the same ADR family and independently logged near-duplicate `docs/tech-debt.md` entries about the same two gaps — the cross-ADR restatement convention, and the collision between the ADR amendment procedure and its own guardrail. Each ticket's handover names the other and explains that the pair was **preserved deliberately**, so that `/triage` can collapse them with both tickets' evidence in front of it rather than one ticket's. Two orchestrators reaching the same finding independently is corroboration and worth having; what is missing is any way for the second one to know the first exists before writing, so a human is the only thing that can tell corroboration from duplication. Logged, not fixed: the pairs stay as they are, and collapsing them is triage's job with both citations present.
- Triage note (2026-08-11): the pairs were collapsed on this pass, into [#401](https://github.com/TomBennett-Lloyd/cumulo/issues/401) (the rule-9 ADR exemption) and [#402](https://github.com/TomBennett-Lloyd/cumulo/issues/402) (the Amendments convention), each citing both tickets. The entry stays because the **blindness** is unfixed: two orchestrators still cannot see each other's in-flight systemic findings, and a human is still the only thing that can tell corroboration from duplication. Corroboration was worth having — the two pairs disagreed about scope in ways one ticket alone would not have surfaced — so the cost of the blindness this time was one triage pass, not one wrong issue.

## 2026-08-10 — session-wide (delegated runs on #334, #321, #200)

- Phase: process
- Observed: four harness properties that the delegated-orchestration design assumed away, recorded because each one turned into hand-work and none is visible until it bites. (a) **An agent cannot read its own handle**, so the `Agent:` line every report is contractually required to carry can only be filled in by the dispatcher, not by the agent it identifies. (b) **Implementers cannot resolve their dispatching orchestrator by name via SendMessage**, so a sub-agent's return can only travel as its final report — there is no side channel back up, and anything else has to be relayed by file. (c) **The machine-wide concurrent-subagent cap refuses dispatches rather than queueing them**: three of five parallel dispatches on #200 were refused outright, which is safe only because nothing had started, and the safety was established by checking `git status` rather than by anything the refusal itself said. (d) **The Playwright e2e lane binds port 4173**, so exactly one `web-e2e` run fits on this machine at a time regardless of how many worktrees are in flight. Together these are the shape of the constraint the workflow has to design around; (b) is the one that motivated the synchronous-dispatch rule in `.claude/agents/task-orchestrator.md`.

## 2026-08-11 — PR #398 (issue #295)

- Phase: process
- Observed: **every** sub-agent completion notification on this ticket mis-routed to the top-level session instead of resuming the orchestrator that spawned it — the planner, four implementers, browser-smoke and six reviewers, across the whole ticket. Only `run_in_background: false` reliably returned control. Zero work was lost, because reconcile-from-disk caught every orphaned round and two rounds were recovered from disk alone, but every round cost a relay. This is the fourth ticket to hit it and the first where it was total rather than intermittent, and it is the strongest single piece of evidence for the synchronous-dispatch rule already adopted in `.claude/agents/task-orchestrator.md` — recorded so the rule's cost/benefit stays measurable if the harness behaviour ever changes. Two harness facts already logged on 2026-08-10 are what make it unrecoverable rather than merely annoying: an agent cannot read its own handle, and a sub-agent cannot address its orchestrator by name, so there is no return address to supply even when everyone involved knows one is needed.

## 2026-08-11 — PRs #366, #394, #395, #398 (fix rounds that introduce defects)

- Phase: review
- Observed: a fix round planted a new defect in five separate places across four tickets. #366's cycle 2 fix created the contradiction cycle 3 found, and its `commentChar` repair created the artifact the confirmation pass found; #394's cycle 2 found a false claim inside cycle 1's own new tech-debt entry; #398's confirmation rounds 1–3 each falsified a figure written by the commit that fixed the previous round; #388 committed a wrong count _inside the PR that logged the wrong-count pattern_. Every one was cheap individually. The pattern argues that the 3-cycle cap should be read as **net** progress rather than as a raw count of rounds, and that the highest-risk text in any diff is the text written by the last fix — which is what `review-loop` step 1 already says about orchestrator-authored prose, arriving here one layer down. Not turned into a rule: the confirmation-cycle termination rule added on this pass (classify diminishing findings SYSTEMIC) is the current answer, and it should be given a few tickets before anything stronger is written. If a fix round plants a _correctness_ defect — none of the five was one — that is the signal to revisit.

## 2026-08-11 — PR #400 (issues #330, #343, #347), inline-batch counterfactual

- Phase: process
- Observed: the owner-directed measurement of an inline batch against the delegated-batch baseline came in at **$62.13 total ≈ $21/ticket** (shared machine ledger, 7-day spend delta from batch start to merge), ~3.5 h wall clock, 3 review cycles + confirmation APPROVE, 13 FIX-NOW resolved with zero behavioural findings after wave 1, 5 mutants killed, zero escalations. The delegated 6-ticket batch (#391) was measured in per-agent tokens (~220k/ticket) with no dollar snapshot, so the cells are **not unit-identical** — stated rather than smoothed. On a blended-rate conversion the two land in the same ballpark: batches are cheap in both modes, and the expensive shape remains single-ticket delegation (~2× inline). What actually differs is where the cost lands — inline consumes the top-level session's own context, with the compaction risk that carries on a long day, while delegation buys context isolation for a comparable price. Recorded rather than acted on: the routing in `.claude/workflow.json` (single issues inline, same-surface batches delegated) is unchanged by this, which the data neither justifies flipping nor justifies reverting, and the owner's "keep an eye on delegated batches" directive stands. The measurement comment on #390 is the full record.
