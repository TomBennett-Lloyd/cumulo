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
