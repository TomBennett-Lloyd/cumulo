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

## 2026-08-10 — PR #348

- Phase: process
- Observed: the `web-e2e` composition flake filed as [#303](https://github.com/TomBennett-Lloyd/cumulo/issues/303) fired again — run 31350090185, signature "map canvas had a layout box and then lost it", on a **docs-only diff** that cannot have caused it. The response was the same one used every previous time: re-run once for that specific signature, and treat a second failure with the same signature as real. That practice has now been applied enough times to be the de facto rule and it is written down nowhere; what makes this instance the sharpest is the docs-only diff, which is as close to a control as the lane will ever offer. The flake itself is owned by #303 and this is not a second copy of it — what is unowned is the _response_: no skill or agent file says a lane failure may be re-run at all, so the practice is held by whoever remembers it. Kept below the filing threshold deliberately, because the honest fix is #303 landing rather than a re-run rule that outlives it; if #303 is still open at the next triage, file the re-run rule separately.
