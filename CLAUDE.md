# Cumulo

Residential solar fleet forecasting and flexibility platform — a miniature virtual power plant. Per-site PV forecasts (physics model + ML correction layer), fleet-level aggregation with uncertainty bands, and a live add-a-site demo flow. Named after the antagonist: cumulus clouds are what stand between the sun and the panels.

This is a portfolio project. The repo's **process** — commit history, PR discipline, issues, ADRs, this very workflow — is a first-class deliverable that will be read by human reviewers. Quality of process matters as much as the product.

## Hard constraints

- **Open-Meteo attribution is mandatory** (CC BY 4.0): a visible attribution link to [Open-Meteo.com](https://open-meteo.com/) wherever weather-derived data is displayed in the UI — the full "Weather data by Open-Meteo.com" phrase at standard widths; at widths where the row as composed cannot hold its credits' full forms, the bare linked name is the sanctioned compact form (CC BY 4.0 §3(a)(2) permits medium-appropriate attribution; owner-amended 2026-08-09, composed-row reading owner-confirmed 2026-08-11) — plus a data-sources credit in the README. The link itself is non-negotiable in every state.
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
- Adding a module, package, service, or cross-package dependency, or restating an owned value (infrastructure, schema ceiling, cost) in code or prose — **or changing one**, which means enumerating its carriers _and_ the figures derived from it before you edit? → `docs/standards/architecture.md`
- Changing behaviour that a comment beside it argues for or defends — which makes that comment part of the change surface? → `docs/standards/architecture.md`
- Writing or editing a code comment, docblock, or standing doc — including any figure in prose, any mention of other code, or a restated architectural argument? → `docs/standards/prose.md`
- Creating or splitting a file, extracting/naming a helper, choosing function vs class, or copy-pasting code? → `docs/standards/structure.md`
- Writing a `catch`, or deciding what happens when something fails? → `docs/standards/error-handling.md`
- Writing or changing a security policy whose directives have fallback semantics — a CSP, a CORS policy, any response header where an omitted directive inherits from another? → `docs/standards/security.md`
- Writing or modifying tests, or deciding what to test? → `docs/standards/testing.md`
- Adding, moving, or restyling anything a user sees — a component, layout, spacing, visible text or a label, a chart mark, a breakpoint or media query, focus or hover behaviour? → `docs/standards/design.md`

These docs are self-contained — one hop only, no chained references. If a rule in them could become a lint rule, promote it and delete the prose (see the `retro` skill).

## Workflow

- Every task starts from a GitHub issue. The plan lives in the issue (posted by `/plan-issue`); every PR links its issue. Never commit directly to `main` after bootstrap.
- Sub-agent return contract: reports end with `STATUS: DONE | PARTIAL | BLOCKED | STRUGGLING` plus detail. Diverging silently from the plan is the failure mode; stopping and reporting is correct behaviour.
- Review loop (`/review-loop`): max 3 cycles, plus a scoped confirmation pass on the final fix diff. Systemic findings go to `docs/tech-debt.md`, not into endless iteration. Correctness bugs always block merge.
- **Merge policy** (`.claude/workflow.json`): docs/config PRs auto-merge on green CI; source-code PRs auto-merge on green CI **plus a review-loop APPROVE** (graduated 2026-08-01). Human review is reserved for `humanAlways` paths — `docs/adr/**`, `.claude/workflow.json`, `CLAUDE.md` — which get the `awaiting-review` label and wait (chat approval also unblocks); keep working on independent tickets meanwhile. An `awaiting-review` PR carries its own `docs/review-feedback.md` line **in the diff** — even "approved, no changes" — and the merger only removes the label; a quiet category must be distinguishable from an unlogged one, and a line owed after the merge is a line no gate can block (PRs #345 and #348, 2026-08-10). Gate changes are proposed via retro PR and decided by the user.
- **Plan approval** (`.claude/workflow.json`): `planApproval.mode` is `auto` (graduated 2026-08-01) — `/plan-issue` posts the plan and execution proceeds, EXCEPT plans for `adr`-labelled issues, and plans whose Risks section holds a question only the user can answer: those stop and wait.
- **Orchestration**: `.claude/workflow.json` → `orchestration` owns the lane rule — which ticket sets the top-level session runs inline and which it delegates to a persistent `task-orchestrator` (`/run-issue`), the token evidence behind the split, and how it rolls back. Read it there before starting a set; this bullet deliberately restates none of it, which is what `docs/standards/architecture.md` rule 9 asks of every mention that is not the owner.
- After each merged PR: `/retro`. Weak signals go to `docs/friction-log.md`; `/triage` periodically converts both logs into root-cause GitHub issues.
- **Worktree lifecycle**: task work happens only in a worktree under `.claude/worktrees/`; the main checkout stays parked on `main` and is read-only for task work (reviews, pulls, triage). Each worktree installs its own deps with `pnpm install --frozen-lockfile` (the SessionStart hook `.claude/hooks/ensure-deps.sh` does this) — never share or symlink `node_modules` with the main checkout. After merging, the merging agent decides: reap on finish, or `rebranch-worktree.sh` to continue in place. `sweep-worktrees.sh` is the backstop for killed sessions and only ever removes worktrees that are both merged and clean.
- Newly discovered scope becomes an issue (label `discovered`) — never a detour from the current task.
- **Frontend gate**: UI code consumes design tokens only. `stylelint.config.mjs` and `eslint.config.mjs` enforce the colour half mechanically; lengths reaching the page through a property the allow-list omits are still on you (residual documented in the stylelint config).

## Layout

pnpm monorepo: `apps/*` (web, ingestion; api later — created via tickets), `packages/*` (shared code; `@cumulo/shared` holds domain schemas), `infra/` (Terraform, later), `docs/` (standards, ADRs, logs), `.claude/` (agents, skills, hooks — part of the portfolio, kept in-repo deliberately).
