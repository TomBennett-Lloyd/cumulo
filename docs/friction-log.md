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

## 2026-07-31 — PRs #95, #97 (and issues #17, #19)

- Phase: process
- Observed: the human gates leave no durable artefact, so their own graduation evidence cannot be assembled. #95 and #97 were merged by the user with zero GitHub reviews recorded, both kept the `awaiting-review` label after merge (as did #79, #80, #82, #87, #89), and neither produced a `docs/review-feedback.md` entry. On the plan side, #11's plan drew an explicit approval comment that changed the design (the user chose SQS as transport), while the #17 and #19 plans were executed with no approval comment on the issue at all. `review-feedback.md` states that "a category going quiet across consecutive reviews is the evidence for graduating that gate", but silence in the log currently cannot be told apart from nothing having been logged — so this batch supports neither graduating the code-review gate nor keeping it.

## 2026-08-01 — PR #14

- Phase: implementation
- Observed: `pnpm add` inserts its `allowBuilds` placeholder into `pnpm-workspace.yaml` alphabetically, which can slide the new entry between an existing entry and the justification comment above it — silently re-parenting that comment onto a package it does not describe. The supply-chain gate then fails on a line nobody edited. The gate behaved correctly; the surprise is pnpm's insertion point. Practice until this bites again: after any `pnpm add`, re-read the whole comment↔entry pairing, not just the line that appeared.

## 2026-08-01 — PR #91

- Phase: implementation
- Observed: `preview_start` resolves `.claude/launch.json` from the MAIN checkout only, never from the worktree the branch lives in — so browser verification of a worktree branch needs either the config present in the main checkout or a temporary copy the agent then removes. The #118 browser-smoke convention (synchronous, Sonnet, agent owns the server lifecycle and cleans up its temp launch.json) worked first time and absorbed the workaround, so no rule is forced yet; recorded in case the copy-and-delete dance recurs.

## 2026-08-01 — PR #122

- Phase: process
- Observed: second real STRUGGLING→consultant dispatch (first: #115), and again the consultant beat both implementer options by reframing rather than choosing — here that the exact bound was never sound and that wall-clock and SDK time were being compared as if commensurable. Two for two on "the loop earns its cost when the implementer's options share a wrong premise". No change made; logging the running record so the loop's value stays measurable.
