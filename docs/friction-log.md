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

## 2026-08-02 — session-wide (PRs #168–#184)

- Phase: process
- Observed: a system-reminder claiming the GitHub API rate limit (5,000/hr) was exceeded appended itself to tool results at least three times across two sessions — orchestrator once, sub-agents twice — while `gh api rate_limit` reported ~4,999 remaining on every occasion. The reminder is spurious, and an agent that takes it at face value stalls against a ceiling it is nowhere near. Practice until this earns a rule: run `gh api rate_limit` and believe the number, not the reminder.

## 2026-08-02 — session-wide (PRs #169–#207)

- Phase: process
- Observed: twenty-two PRs merged across this unsupervised run (#169 through #207) under the gates graduated on 2026-08-01, every one of them auto-merged — no PR in the span carried the `awaiting-review` label — with zero revert PRs repo-wide, so the tightening condition recorded in `merge.note` has never fired. Banked as evidence for the user's future gate decisions; no change proposed, since what remains gated is the `humanAlways` paths and `adr` plan approval, which should stay in place while the user is away. The absence of new `docs/review-feedback.md` entries in the span is not part of this evidence — the last entry (ADR 0006) predates the run, and zero human-gated merges makes the category unexercised rather than quiet.

## 2026-08-02 — retro batch 3 (prune finding, report-only)

- Phase: process
- Observed: running tallies embedded in prose drift from what they count. `implementer.md`'s absolute-paths rule says "Four incidents so far" and then names two; `planner.md`'s consultant-dispatch tally (#115, #122) duplicates this log's "Two for two" record and will desync the moment a third dispatch lands. Two candidate fixes with no obvious winner — drop the embedded counters and keep only the named incidents, or name one owner per tally — so no change made this batch.

## 2026-08-02 — PRs #167, #161 (pattern to keep)

- Phase: review
- Observed: reviewers dispatched with "verify rather than re-derive — re-run what you doubt" independently re-ran the mutants and rebuilt the censuses from code instead of trusting the implementer reports, and each caught real drift: the seven-sink log census on #167, the `closeDraft` guard on #161. Logged as a win rather than a problem — positive verification costs reviewer tokens and has no failure to point at when someone later trims the dispatch wording for economy, so the two catches are recorded here as the evidence that it pays for itself.
