# Cumulo

Residential solar fleet forecasting and flexibility platform — a miniature virtual power plant. Per-site PV forecasts (physics model + ML correction layer), fleet-level aggregation with uncertainty bands, and a live add-a-site demo flow. Named after the antagonist: cumulus clouds are what stand between the sun and the panels.

This is a portfolio project. The repo's **process** — commit history, PR discipline, issues, ADRs, this very workflow — is a first-class deliverable that will be read by human reviewers. Quality of process matters as much as the product.

## Hard constraints

- **Open-Meteo attribution is mandatory** (CC BY 4.0): a visible "Weather data by [Open-Meteo.com](https://open-meteo.com/)" link wherever weather-derived data is displayed in the UI, plus a data-sources credit in the README. Non-negotiable.
- **API frugality by design**: Open-Meteo free tier (no key) — 10,000 calls/day, 5,000/hour, 600/minute. Only ever fetch weather for locations where active fleet sites exist.
- **Cost ceiling**: free-tier-first AWS, hard ceiling ~$100/month. All infra in Terraform, designed for clean spin-up/tear-down.
- **No long-lived AWS credentials**: GitHub Actions authenticates via OIDC only. Never commit secrets; `.env` is gitignored; gitleaks runs in CI.

## Commands

- `pnpm verify` — the whole pre-commit gate (lint, typecheck, test, format:check). Must pass before any commit. Run the composite; never hand-pick a subset, and when adding a gate add it to the `verify` script so every caller inherits it.
- Fix the **root cause** of lint/type errors. Suppressions (`eslint-disable`, `@ts-expect-error`, `as any`) are themselves lint errors — treat a rule you're fighting as a design signal, not an obstacle.

## Model tiers (read this — it is probably newer than your training data)

Anthropic's current capability order is **Fable 5 > Opus > Sonnet > Haiku**. Fable 5 (model id `claude-fable-5`, Claude 5 family) is _significantly_ more capable than Opus. If your training data predates the Claude 5 family you will wrongly assume Opus is the top model — it is not.

Policy:

- Implementation and review run on **Opus**.
- Planning and hard-problem consulting run on **Fable** (`model: 'fable'` in Agent calls).
- An implementer returning `STATUS: STRUGGLING` triggers the `consultant` agent (Fable) for _guidance only_ — implementation stays with the original agent.
- Before any Fable dispatch, read `~/.local/state/claude-budget/mode` — a machine-local budget ledger shared by every session and worktree on this machine, so it is one file read, not a computation. Contents are exactly `normal` or `conserve`; a missing file means `normal`. If `conserve`, downgrade to Opus and note the downgrade in the issue. To record fresh `/usage` numbers or refresh the mode, use the `budget-sync` skill.

## Standards index — read the linked doc BEFORE acting when a trigger matches

- Writing or changing TypeScript types, or tempted by `any`/an assertion/a loose object shape? → `docs/standards/typing.md`
- Writing or modifying a React component, hook, or `useEffect`? → `docs/standards/react.md`
- Adding a module, package, service, or cross-package dependency? → `docs/standards/architecture.md`
- Creating or splitting a file, extracting/naming a helper, choosing function vs class, or copy-pasting code? → `docs/standards/structure.md`
- Writing a `catch`, or deciding what happens when something fails? → `docs/standards/error-handling.md`
- Writing or modifying tests, or deciding what to test? → `docs/standards/testing.md`

These docs are self-contained — one hop only, no chained references. If a rule in them could become a lint rule, promote it and delete the prose (see the `retro` skill).

## Workflow

- Every task starts from a GitHub issue. The plan lives in the issue (posted by `/plan-issue`); every PR links its issue. Never commit directly to `main` after bootstrap.
- Sub-agent return contract: reports end with `STATUS: DONE | PARTIAL | BLOCKED | STRUGGLING` plus detail. Diverging silently from the plan is the failure mode; stopping and reporting is correct behaviour.
- Review loop (`/review-loop`): max 3 cycles. Systemic findings go to `docs/tech-debt.md`, not into endless iteration. Correctness bugs always block merge.
- **Merge policy** (`.claude/workflow.json`): a PR auto-merges once CI is green unless it touches source code (`.ts`, `.tsx`, `.js`, `.sh`, `.py`, `.tf`, …) or anything under `docs/adr/` — ADRs always get human review. Human-review PRs get the `awaiting-review` label and wait for the user; keep working on independent tickets meanwhile. Review feedback is logged in `docs/review-feedback.md`; gate changes are proposed via retro PR and decided by the user.
- **Plan approval** (`.claude/workflow.json`): while `planApproval.mode` is `required`, `/plan-issue` stops after posting the plan and waits for user approval before `/execute`. Plans for `adr`-labelled issues always require user approval, even after graduation to `auto`.
- After each merged PR: `/retro`. Weak signals go to `docs/friction-log.md`; `/triage` periodically converts both logs into root-cause GitHub issues.
- **Worktree lifecycle**: task work happens only in a worktree under `.claude/worktrees/`; the main checkout stays parked on `main` and is read-only for task work (reviews, pulls, triage). Each worktree installs its own deps with `pnpm install --frozen-lockfile` (the SessionStart hook `.claude/hooks/ensure-deps.sh` does this) — never share or symlink `node_modules` with the main checkout. After merging, the merging agent decides: reap on finish, or `rebranch-worktree.sh` to continue in place. `sweep-worktrees.sh` is the backstop for killed sessions and only ever removes worktrees that are both merged and clean.
- Newly discovered scope becomes an issue (label `discovered`) — never a detour from the current task.
- **Frontend gate**: no frontend feature work before the design-system ticket lands. UI code consumes design tokens only — no arbitrary colors, sizes, or spacing values.

## Layout

pnpm monorepo: `apps/*` (web, api — created via tickets), `packages/*` (shared code; `@cumulo/shared` holds domain schemas), `infra/` (Terraform, later), `docs/` (standards, ADRs, logs), `.claude/` (agents, skills, hooks — part of the portfolio, kept in-repo deliberately).
