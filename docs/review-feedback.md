# Review-feedback log

Every substantive piece of human review feedback — on plans or PRs — gets an entry here as it is addressed. `/retro` mines this log to update standards and agent guidance; a category going quiet across consecutive reviews is the evidence for graduating that gate toward autonomy (a flag flip in `.claude/workflow.json`, proposed as its own PR, decided by the user).

Entry format:

```
## YYYY-MM-DD — PR/issue #n — <short-slug>
- Category: plan | code-style | architecture | testing | other
- Feedback: what the user asked for, verbatim where short
- Action: what changed in response (code fix, standards edit, agent-guidance edit, or none + why)
```

One entry per distinct feedback item; the slug names that item's subject and disambiguates multiple items arising from the same review.

---

## 2026-07-30 — PR #39 — precommit-approved-clean

- Category: code-style
- Feedback: "the precommit hooks look good i think we can ship that" — approved with no change requests, the first code PR through the human gate.
- Action: merged (rebased onto `main` to resolve a `package.json` scripts conflict with `pnpm verify`). No guidance change needed; logged as graduation evidence for the code-review gate.

## 2026-07-30 — PR #26 — merge-gate-calibration

- Category: other (merge-policy calibration)
- Feedback: Config-only PRs should auto-merge — "the json file in there didn't matter, i'm more on about actual code … how you're structuring functions and modules and components."
- Action: merge rule refined from "every changed file is .md" to "no source-code files"; encoded in `.claude/workflow.json` (this PR).

## 2026-07-30 — issue #2 (plan review) — adrs-human-always

- Category: plan
- Feedback: "ADRs should always require a human review" — major decisions, the right altitude for human guidance without going deep into code.
- Action: `docs/adr/**` added to `merge.humanAlways`; `adr` added to `planApproval.alwaysRequiredFor`; skills updated (this PR).

## 2026-07-30 — issue #2 (plan review) — demo-abuse-and-auth

- Category: plan
- Feedback: Anonymous site creation is an abuse/cost surface — wants a site cap with oldest-eviction, cheap IP rate limiting with auto-block, and friction against programmatic API use; auth is future expansion whose placement must be considered, not foreclosed.
- Action: #29 (demo abuse & cost protection; now blocks #21) and #30 (auth placement design) created; ADR 0001 amended to acknowledge both as deferred forces (this PR).

## 2026-07-30 — PR #35 — worktree-exclusivity-and-reaping

- Category: other (process / worktree lifecycle)
- Feedback: Questioned whether worktree use is exclusive — "we should never be actively using the main checkout surely? … surely that's the root cause of this issue?" Then, on lifecycle: "some kinda prune on merge workflow would be good to keep worktrees from spiralling … unless the worktree was going to be re-used to persist local artefacts for a follow up PR (e.g. change the branch for the worktree)."
- Action: #42 created for the lifecycle decision (prune-on-merge vs rebranch-and-reuse, plus parking the main checkout on `main`). Not decided unilaterally: the reuse case the user raised is load-bearing, since a reused worktree keeps `node_modules` and therefore cannot reproduce #34's unresolvable-import failure at all.

## 2026-07-30 — PR #35 — audit-beyond-the-reported-symptom

- Category: other (verification rigour)
- Feedback: "are there any other places that need to ignore the worktree?"
- Action: The audit this prompted found `format:check` was vulnerable too and that `.claude/worktrees/` had never actually been gitignored (only `.git/info/exclude`, which is machine-local) — both fixed in #35, correcting a false claim the first commit had already encoded as a code comment. Promoted into the workflow via #41: `implementer.md` now requires a negative control for any change whose purpose is to alter whether a check fires, and forbids asserting a check was unaffected without testing it.
