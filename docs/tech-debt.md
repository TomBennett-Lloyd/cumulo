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

## 2026-07-31 — `invalid-response` now means two different failures

- Where: `apps/web/src/data/fleet-data-source.ts` (`FleetDataError`), `apps/web/src/data/demo-fleet-data-source.ts` (`createSite`'s validation branch)
- What: the arm was defined as "the payload the server sent could not be reconciled with the domain schemas", and C2 additionally used it for "the server refused the payload we sent" — the demo source returns it when `createSiteInputSchema` rejects a draft. The two share an arm because neither is worth retrying identically, which is a defensible reading, but they are opposite directions of the wire and a caller may well want to say different things about them ("the fleet sent us something we cannot read" vs "the fleet would not accept this site"). Nothing forces the question today because the demo source is the only implementation. C8 is where it bites: the HTTP source maps #14's real error model onto this union, and #14's 4xx-for-bad-input is exactly the case that has to land somewhere. Decide with #14's error shape in hand, and alongside #105 (which surface `apps/web` keeps) rather than separately — either split the arm or write down why one arm is right.
- Source: #17 review cycle 1

## 2026-07-31 — No error boundary above the dashboard's async work

- Where: `apps/web/src/App.tsx`, `apps/web/src/main.tsx`, `apps/web/src/dashboard/Dashboard.tsx` (`createSite`, the listing effect)
- What: `FleetDataSource` states its expected failures as values, so the dashboard handles them as values and deliberately does not `catch` — correct per `error-handling.md` rule 1, and it makes a rejected promise a bug in the source rather than a mode callers handle. But there is nowhere for that bug to land: no React error boundary and no `unhandledrejection` handler, so a source that rejects instead of resolving leaves the form stuck on "Adding site…" with the visitor given nothing, and the listing effect leaves the column on "Loading the fleet…" forever. Unreachable today (the demo source cannot reject) and reachable the moment an HTTP source exists, where a `fetch` that throws is ordinary. Wants one app-level boundary that renders a labelled failure, decided once for `apps/web` rather than per-component `catch`es that would violate the rule this design follows.
- Source: #17 review cycle 1
