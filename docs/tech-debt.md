# Tech-debt log

A **buffer, not an archive**. `/review-loop` appends SYSTEMIC findings here instead of iterating on them; `/triage` periodically clusters entries, files root-cause GitHub issues, and **deletes** what it captured. A long-lived entry here means triage is overdue.

Entry format:

```
## YYYY-MM-DD — short title
- Where: file/module references
- What: the pattern or problem (symptom AND suspected root cause if known)
- Source: PR/issue #
```

Pointers must survive unrelated edits: cite **files and symbol or section names** (function names, headings, config keys, script names) — never bare line numbers, and never a copied code literal unless the literal itself is the finding. An entry that pins its claim to `file.sh`:42 sends its reader to whatever happens to sit at line 42 months later. Applies to entries dated 2026-07-31 onward; the back catalogue is retrofitted opportunistically, whenever an entry is edited for any other reason.

---

## 2026-07-30 — `aws_budgets_budget.cost_types` left at AWS defaults

- Where: `infra/bootstrap/budget.tf` (`aws_budgets_budget.monthly_cost_ceiling`)
- What: no `cost_types` block, so the budget uses the AWS defaults, which subtract credits and refunds. On an account carrying promotional credits the meter can therefore run well past $100/month of gross usage while net cost stays under threshold and nothing alerts — the alarm reports what will be billed, not what is being consumed. That is a defensible reading of "cost ceiling" for a project whose ceiling is about the bank balance, and it is the current deliberate choice; it stops being defensible the moment credits land on the account, because the whole point of the ceiling is to catch runaway usage _before_ it is expensive. Revisit if credits appear (or before any AWS-credits programme is used for this project): either add `cost_types { include_credit = true, include_refund = false }`, or add a second usage-oriented budget beside the billed-cost one. Not a fix for this diff — it is a policy decision about what the number means, and it wants the account's credit state as an input.
- Source: #38 review cycle 1
- Triage note (2026-07-31): deliberately left in the buffer rather than filed. It is a parked decision with an external trigger (credits appearing on the account), not debt to clear — an open issue would be picked up by backlog burning and correctly do nothing. Convert it the moment the trigger fires.

## 2026-07-31 — A hook that cannot read its own events disables edit-time lint silently

- Where: `.claude/hooks/hook-context.sh` (`hook_event_field`), and both callers — `.claude/hooks/post-edit-check.sh`, `.claude/hooks/ensure-deps.sh`
- What: `hook_event_field` returns empty for three enumerated reasons (absent field, non-string value, unparseable JSON), all of which honestly mean "this event does not name anything to act on". There is a fourth it does not enumerate and cannot distinguish: `python3` missing, or crashing, or shadowed on PATH. That one does not mean "nothing to act on", it means **no event can be read at all** — so `post-edit-check` silently stops linting every edit for the rest of the session and `ensure-deps` silently stops preparing every worktree. Extends #102's tool-assumptions primitive, which stops at `.claude/scripts` (its acceptance criterion greps only that directory) and describes a failure that is "safe (exit 2 everywhere) but total". The hook layer is the worse shape: it does not refuse, it **degrades into a legitimate-looking no-verdict**, which is the "gate that stops firing produces no output" class of #101. Wants two decisions taken together, because either alone is half a fix: a `command -v python3` preflight that fails loudly instead of returning empty, and a position on whether a no-verdict outcome should be visible at all — post-edit-check's silence is deliberate (a scratchpad edit outside the repo must not chatter on every keystroke), so "log every no-verdict" is not obviously right, and the answer probably has to distinguish "nothing to judge" from "cannot judge". Same question applies to `git` and `pnpm`, which the hooks also assume.
- Source: #74 review cycle 1

## 2026-07-31 — Shell harness plumbing is copied byte-for-byte into every harness

- Where: `.claude/scripts/hook-tree-resolution.test.sh`, `check-adr-index.test.sh`, `check-module-names.test.sh`, `lint-shell.test.sh`, `run-script-tests.test.sh`, `worktree-lifecycle.test.sh` — the `must` / `begin` / `end` / `bad` / `expect_rc` / `expect_out` / `expect_not_out` block near the top of each
- What: six identical copies of the same test vocabulary, and the count only goes up — every new gate brings a new harness. `structure.md` rule 7's question answers yes: if one copy changed, the others would be wrong until they changed the same way. This is #102's root cause ("a library file but not a library") in the harness layer rather than the script layer, and #102's fix direction does not reach it — its three primitives are repo identity, discovery status and tool assumptions, none of which is the assertion vocabulary. The cost is already concrete: the pass/fail counters and `printf` formats have to agree across all six for `run-script-tests.sh`'s summary to read consistently, and nothing enforces that they do. Fix is a sourced `.claude/scripts/harness-lib.sh` — the pattern `worktree-lib.sh` already establishes, including its sourced-not-executed guard — carrying its own harness cases, because a test library whose `expect_out` silently stopped asserting would turn every suite green, which is the worst version of this failure and squarely #101's class. Migration is mechanical but touches all six files, so it is its own change, not a rider on a hook fix.
- Source: #74 review cycle 1

## 2026-07-31 — Harnesses capture `2>&1`, so they cannot tell a success report from a failure report

- Where: `.claude/scripts/hook-tree-resolution.test.sh` (`run_post_edit`, `run_ensure_deps`, and the inline working-directory-fallback case); the same `2>&1` idiom in the other five harnesses
- What: merging the streams was convenient — one variable to assert on — but it discards a distinction the scripts under test deliberately encode. `ensure-deps.sh` writes "ran pnpm install, deps are ready" to **stdout** and "install failed" to **stderr**; a harness capturing `2>&1` and asserting the root path appears cannot tell which of the two it got. The consequence is concrete in the #74 diff: the ensure-deps cases provoke the _failure_ branch (deliberately, to stay offline and fast), and the success branch — the one that runs in every fresh worktree — has no case at all, with nothing in the harness able to notice the gap. Same blind spot in `post-edit-check`, where exit 2 plus stderr is the contract that makes Claude Code surface the message to the agent; a change routing the report to stdout would keep every case green and silently end the feedback loop the hook exists for. That silent-green shape puts it in #101's family, and the fix belongs with the harness library above rather than as a local patch: `expect_stdout` / `expect_stderr` capturing the two streams separately, then a success-branch case for `ensure-deps` built on a fixture whose install genuinely succeeds (an empty workspace with a matching lockfile, still offline).
- Source: #74 review cycle 1
