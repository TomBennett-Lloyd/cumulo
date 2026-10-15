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
- Triage note (2026-10-05): considered and left on its own stated terms — no fifth shape has landed and none of the four has recurred since, so the trigger is unfired. Not folded into [#543](https://github.com/TomBennett-Lloyd/cumulo/issues/543) (the lane-environment pattern this pass filed): these are measurement artifacts inside a working pane, where #543 is about a lane's substrate failing silently.
- Related: the browser content-tools outage the same session (~1.5h+ with no usable pane) is what produced the deferred-verification pattern now carried by [#342](https://github.com/TomBennett-Lloyd/cumulo/issues/342) — a browser criterion that cannot be measured becomes a filed, named, deferred verification rather than a claim.

## 2026-08-10 — session-wide (PRs #345, #348)

- Phase: process
- Observed: the `task-orchestrator` agent type merged by PR #345 was **not dispatchable at the first attempt after its own merge** — the registry the session was dispatching against did not carry it yet. The delegated pilot on #331 therefore ran as a `general-purpose` agent handed the contract to read from disk (`.claude/agents/task-orchestrator.md`), which preserved fidelity — the contract is a file, and reading it is what the agent type would have done — but at the cost of the harness's own agent-type routing (model tier, tool restriction) being supplied by hand. It then became available **later in the same session**, after the definition file had reached the session's own worktree through a rebase, and dispatches from that point got the real type. What was observed is that sequence, not a mechanism: whether the worktree copy arriving is what registered the type, or the registry simply refreshed on its own, was never established, so there is no "one session behind" rule to lean on. No workflow change proposed: the constraint belongs to the harness, not the repo, and the read-from-disk workaround is exactly the design property #336 argued for. Logged so that the next agent-definition PR reads a missing type as this rather than debugging it — and knows to retry rather than assume the type is unavailable for the rest of the session.

## 2026-08-10 — session-wide (PR #348, and #296 PR A before it)

- Phase: implementation
- Observed: the harness's safety classifier refuses security-adjacent prose on sight, including prose that only _describes_ an attack in order to test a defence. It bites twice in this repo's shape of work. In #296 PR A the coverage claim about the per-IP limiter had to be established by an exhaustive read of the test file rather than by the demonstration that would have proved it, because the demonstration means writing an edit that removes a rate limit (recorded at the time in `docs/tech-debt.md`, and now carried by [#309](https://github.com/TomBennett-Lloyd/cumulo/issues/309), which this session's triage folded that entry into). The pattern that works is a safe rewording — state the property positively ("the limited set is exactly these routes") and prove it by construction, rather than by describing the bypass. Logged rather than turned into guidance: the reword is obvious once you have hit the refusal, and a rule that says "avoid tripping the classifier" would be a rule about a moving target.

## 2026-08-10 — session-wide (PRs #301–#348, sub-agent text posted verbatim)

- Phase: process
- Observed: text returned by a sub-agent arrives HTML-entity-escaped (`&amp;`, `&lt;`, `&gt;`, `&#39;`), and posting it verbatim to a GitHub issue or PR body publishes the escapes. It is invisible in the agent's own report and only visible after the comment lands, at which point fixing it means an edit whose diff is noise. Decode before posting anything that travelled through a task result. No fix proposed — it is one step in one place, and the place is the orchestrator's own posting path rather than a file anyone else reads.

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
- Triage note (2026-10-05): this entry is the anchor of a four-entry pattern — the sub-agent **return path** (no readable own handle, no address for the orchestrator, mis-routed completions, the concurrency cap refusing rather than queueing, HTML-entity-escaped returns). It crosses the skill's ≥3 threshold and was still **not** filed, deliberately: every member records the constraint as the harness's rather than the repo's, and the repo's own answer (synchronous dispatch in `.claude/agents/task-orchestrator.md`) is already adopted. Kept as the running record the next harness change should be measured against. The _environment_ pattern it sits beside was filed, as [#543](https://github.com/TomBennett-Lloyd/cumulo/issues/543).

## 2026-08-11 — PRs #366, #394, #395, #398 (fix rounds that introduce defects)

- Phase: review
- Observed: a fix round planted a new defect in five separate places across four tickets. #366's cycle 2 fix created the contradiction cycle 3 found, and its `commentChar` repair created the artifact the confirmation pass found; #394's cycle 2 found a false claim inside cycle 1's own new tech-debt entry; #398's confirmation rounds 1–3 each falsified a figure written by the commit that fixed the previous round; #388 committed a wrong count _inside the PR that logged the wrong-count pattern_. Every one was cheap individually. The pattern argues that the 3-cycle cap should be read as **net** progress rather than as a raw count of rounds, and that the highest-risk text in any diff is the text written by the last fix — which is what `review-loop` step 1 already says about orchestrator-authored prose, arriving here one layer down. Not turned into a rule: the confirmation-cycle termination rule added on this pass (classify diminishing findings SYSTEMIC) is the current answer, and it should be given a few tickets before anything stronger is written. If a fix round plants a _correctness_ defect — none of the five was one — that is the signal to revisit.
- Triage note (2026-10-05): left on its own stated terms. No fix round has planted a correctness defect since, so the revisit trigger is unfired and the confirmation-cycle termination rule remains the answer.

## 2026-10-13 — PR #620 (issue #606)

- Phase: implementation
- Observed: a network stall left 31 files uncommitted in #606's lane. They were recovered intact. `ticket-agent.md` rule 4's "commit every verified step" could not have shrunk that window. Retiring `FleetSite.active` dropped a field from `fleetSiteSchema` and deleted `activeFleetSites`, so typecheck stays red until callers in six workspaces move (the PR's 45 files), and `pnpm verify` gates every commit. The rule assumes a ticket decomposes into green steps, and a schema contraction does not. Not turned into a rule: a size-triggered WIP commit would break verify-before-commit, which `CLAUDE.md` owns, and pushing a WIP ref outside the branch is untried here. The signal is a second contraction-shaped lane that loses work at a stall.
- Triage note (2026-10-15): [#670](https://github.com/TomBennett-Lloyd/cumulo/issues/670), filed from the #606 review's tech-debt entry, proposes the expand/contract rule that would let a contraction land in green steps. The entry stays as the signal it names: a second contraction-shaped lane losing work, or #670 landing, settles it.

## 2026-10-13 — PR #624 (issue #506)

- Phase: process
- Observed: two concurrent lanes shared one figure. #613's ADR 0010 argues its cost bound from a ≈ 270-unit roll-up actuals read, and #624 owned that read. The merge owner's coordination note was "whichever merges second trues the other's figure". #624 merged second, trued ≈ 270 to ≈ 320, and found the bound no longer held: ≈ $95 on the roll-up read, and ≈ $114 on the fallback double read, past the ~$100 ceiling. It returned BLOCKED with the arithmetic and filed #630, which is `ticket-agent.md` rule 5(b) working as written; the planning-gate BLOCKED earlier on the same ticket (owner decisions Q1, Q2) also worked. The note treated a true-up as clerical. For a figure an ADR argues from, a true-up can falsify the decision, and ADR 0010's supersede-never-edit revisit triggers make that the owner's call. Not turned into a rule: one occurrence, the existing trigger caught it, and the gap was in an ad hoc message rather than a contract. Candidate if it recurs: `run-issue` step 1's overlap note names any figure an in-flight ADR argues from that another lane changes, and asks for the recomputed conclusion rather than the trued figure.

## 2026-10-14 — PR #640 (issue #635)

- Phase: process
- Observed: the lane posted "Step 1 committed… Next: reviewer pass, PR" as a fresh issue comment, where `ticket-agent.md` rule 4 says a step is ticked in the plan comment and rule 8 says nothing reaches the top-level before the report. One instance; noted so a repeat is recognised as one.
- Triage note (2026-10-15): this entry's first observation (the review's real catch came from live CloudWatch, not the repo) is captured by [#682](https://github.com/TomBennett-Lloyd/cumulo/issues/682) with #625's and #649's. The slip above stays as a singleton; #654's plan-after-code entry is the nearest neighbour, both being a lane's form diverging from `ticket-agent.md` while its substance held.

## 2026-10-14 — PR #645 (issue #614)

- Phase: process
- Observed: the lane found the issue's decision (b) wrong about `datedByData` (an empty group is skipped, so an unstamped location cannot pull the body to the short cache on its own), declared the divergence in its plan comment and PR body, tested the reachable case instead, and left the owner a non-blocking question — "the owner can say if an unstamped group should force the short cache" — in both places. That is the lane working as `ticket-agent.md` rule 2 intends for a divergence, and the question has no reader: the issue is closed, the PR is merged, and rule 6's own words are that nothing reads a PR body after the merge. A blocking owner question has a path (`STATUS: BLOCKED — owner decision`); a non-blocking one has a report field for the divergence and none for the question. One instance, and the answer may well be "nothing": if a second lane leaves an owner question in a merged body, the candidate is one line in rule 2 sending such a question to a `discovered` issue or the open issue that owns the behaviour.

## 2026-10-15 — PR #654 (issue #653)

- Phase: process
- Observed: the lane's plan comment says of itself "posted after the implementation was already written and the harness green (plan-before-code order not kept this time)". The dispatch carried an explicit plan and the issue body carried the fix, so the lane went to code; the comment it then wrote is a good one, three judgement calls stated, but a plan written after the code can only describe the code, so rule 2's divergence declaration was post hoc and the one-honest-PR test was never a stop. The same lane then stalled on the harness's 600 s network watchdog with two commits pushed; the RESUME lane adopted both from `git log`, ran the confirmation pass and opened the PR, redoing nothing, at ≈ 71k tokens for the resume: `ticket-agent.md` rule 5(f) and `run-issue` step 5 working as written, and evidence for #543. Not turned into a rule: the inversion is one self-declared instance on a lane whose plan was in its dispatch. The candidate if it repeats is the form #639's lane used, a one-line "executing the plan above" comment posted before the first edit, which costs nothing and keeps the order.

## 2026-10-15 — PR #669 (issue #545, batch "ingestion+forecast 2")

- Phase: process
- Observed: the lane's `Merge cautions:` line said its baseline ratchet lowered `apps/forecast/src/consume-message.ts`'s density row from 4876 to 4335 bp, "which tightens the budget #615's plan states as 5074". The caution was right, and nobody passed it on. #615 is open, and its plan still reads "density row 5074 bp — the ratio may not rise", with an acceptance of "not above 5074 bp". The figure has gone stale twice since that plan was posted: #661's whole-baseline `--ratchet`, a storage batch that never touched the file, took the row to 4876, and #669 took it to 4335. #615 has no comment since the owner's decisions. A lane executing that plan will check its acceptance against a figure `main` no longer holds; `pnpm verify` catches the gap, but only after the lane has written to the wrong budget. Neither `ticket-agent.md` rule 8 nor `run-issue` step 3 says who acts on a caution that names another open issue, though the template's own example is "overlaps #m on <file>". This is the third instance of the shape #683 left brewing below threshold: a figure or question in a merged body that nobody reads (#645's owner question, #624's figure true-up). The candidate fix is one line in `run-issue` step 5: a `Merge cautions:` item naming another open issue becomes a comment on that issue at merge.

## 2026-10-15 — PR #683 (triage 2026-10-15)

- Phase: process
- Observed: `/triage`'s description says to run it "every ~5 merged PRs, or when either log grows past a screenful". This pass ran 49 merged PRs after the last one (#546, 2026-10-05) and found 42 tech-debt entries. One entry shows what the gap cost. "2026-10-06 — pre-check (a) greps the trimmed subject's identifier only, so a citation naming a trimmed docblock by file path ... is invisible to it", logged by #572, stayed in the log through seven more #545 trim batches (#575, #631, #644, #661, #666, #667, #669). #669 then deleted a sole carrier cited by file path (`publisher/sqs.ts`'s delay-curve reason, restored at review) and logged the gap again as an update bullet. A triage scheduling note is what turns an entry into "do before the next batch", and #671 now says exactly that; a log entry carries no such ordering. Nothing in the merge chain counts merged PRs since the last triage or reads the logs' size, so the cadence is whatever the merge owner remembers. The tidy ran first, as the skill says, and changed nothing, which "commit what it changed" allows. The candidate fix if this recurs is source, so it would be its own issue: `merge-pr.sh` prints both logs' entry counts, and the merged-PR count since the last `triage` commit, after each merge.

## 2026-10-15 — PR #684 (issue #679)

- Phase: process
- Observed: the lane report in #684's body stops after `Lane model:`. It has no `Sub-dispatches:`, `Discovered:`, `Retro:`, `Merge cautions:` or `STATUS:` line, and its `CI:` reads `pending`. `ticket-agent.md` rule 8 calls every field contractual and has the top-level treat a missing one as PARTIAL, yet the PR merged. This is the third merge of a report with no `STATUS:` (#649, #652, #684), all three from Sonnet lanes, and the first since #659 filed the `merge-pr.sh` refusal for exactly this; #659 is still open. The substance held: the plan held, review was APPROVE with zero FIX-NOW, and both mutants were pasted. What was lost is the lane's own `Retro:` line, which `retro` step 1 names as first-hand input, so this retro's #684 section rests on the plan comment and #607 alone. No new rule: #659 is the fix, and this entry is its third instance and an argument for scheduling it before the next lane merge.
