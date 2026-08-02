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
