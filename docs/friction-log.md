# Friction log

Weak signals from `/retro` that don't yet have a clear improvement action — recorded so patterns become visible across tasks ("we churn on X in half of tasks") instead of being forced into premature lessons. `/triage` mines this for repeats (≥3 similar entries, or affecting ≥50% of recent tasks) and converts patterns into workflow issues, deleting captured entries. Singletons stay until they repeat or go stale.

Entry format:

```
## YYYY-MM-DD — PR #n
- Phase: planning | implementation | review | process
- Observed: one concrete observation, no proposed fix required
```

---

## 2026-07-31 — overnight batch (fresh worktrees, #63–#72)

- Phase: process
- Observed: pnpm 11 auto-writes `minimumReleaseAgeExclude` and `allowBuilds` entries into `pnpm-workspace.yaml` during ordinary installs — supply-chain opt-outs appearing as unexplained working-tree diffs that each agent must independently notice, interpret, and decide whether to commit.

## 2026-07-31 — PR #71

- Phase: implementation
- Observed: `python -m venv` writes a `.gitignore` inside the venv so git ignores it, but Prettier's `format:check` does not honour nested `.gitignore` files — a worktree that `git status` calls clean still produced transient format reds until the venv path was excluded.

## 2026-07-31 — overnight batch (gate porosity)

- Phase: review
- Observed: lint-gate configs were found porous by ad-hoc probing three separate times in one batch; each time the durable fix was a committed fixture test proving the gate actually fires. The fixture-test-per-gate pattern and the shellcheck/vitest version-pinning policy are already tracked in `docs/tech-debt.md` — this entry records the recurrence count, not a new action.
