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

## Captured-entry redirects

Source comments across the repo cite entries by title ("recorded in `docs/tech-debt.md` (…)"). Triage deletes the entry but cannot edit those comments without turning a docs-only PR into a source-code one, so this table is where a dangling pointer lands. It is a **redirect, not an archive** — the content lives on the issue.

Maintenance: a row dies with its issue. Each capturing issue's implementation edits the very files whose comments cite it, so the citation and the row go together; whoever closes the issue deletes the row.

| Captured entry                                                                                                                                                                                                                                           | Now owned by                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Shell harness plumbing is copied byte-for-byte into every harness · Harnesses capture `2>&1`, so they cannot tell a success report from a failure report · `check-infra-mirrors.test.sh` edits fixtures with `perl`                                      | [#157](https://github.com/TomBennett-Lloyd/cumulo/issues/157)           |
| `check-supply-chain-policy.sh` reads YAML by line shape · Supply-chain gate asserts the manifest, but pnpm resolves policy from four places · `check-infra-mirrors.sh` reads Terraform by line shape                                                     | [#158](https://github.com/TomBennett-Lloyd/cumulo/issues/158)           |
| Only `@cumulo/shared` can express a type-level test                                                                                                                                                                                                      | [#159](https://github.com/TomBennett-Lloyd/cumulo/issues/159)           |
| Skill score compares two RMSEs computed over different sample sets · A metrics row cannot say which hours of its own period are missing                                                                                                                  | [#160](https://github.com/TomBennett-Lloyd/cumulo/issues/160)           |
| No error boundary above the dashboard's async work · The map's placeholder shells restate `MapView`'s structure · Loading announcements are per-component conventions                                                                                    | [#161](https://github.com/TomBennett-Lloyd/cumulo/issues/161)           |
| `invalid-response` now means two different failures · The shared data hook is still named after the surface that was deleted                                                                                                                             | [#162](https://github.com/TomBennett-Lloyd/cumulo/issues/162)           |
| Cycle rotation advances one location per hour, not one window                                                                                                                                                                                            | [#163](https://github.com/TomBennett-Lloyd/cumulo/issues/163)           |
| One ingestion alarm now stands for two unrelated operator questions · A forecast consumer pointed at the wrong environment is indistinguishable from an idle fleet · A user-site counter stuck above the real population                                 | [#164](https://github.com/TomBennett-Lloyd/cumulo/issues/164)           |
| The ingestion time budget prices `Retry-After` at zero on both AWS paths · The API's 15 s timeout and the storage client's retry budget are two unreconciled numbers · `backoffCeilingMs` lives in the consumer while the curve it sums lives in storage | [#165](https://github.com/TomBennett-Lloyd/cumulo/issues/165)           |
| One client-wide attempt budget now serves two failure regimes · Two packages' docstrings describe the wholly-declined batch write oppositely                                                                                                             | [#166](https://github.com/TomBennett-Lloyd/cumulo/issues/166)           |
| Series cleanup runs on the request path                                                                                                                                                                                                                  | [#167](https://github.com/TomBennett-Lloyd/cumulo/issues/167)           |
| A hook that cannot read its own events disables edit-time lint silently                                                                                                                                                                                  | [#102](https://github.com/TomBennett-Lloyd/cumulo/issues/102) (comment) |
| The port-inversion invariant in `@cumulo/hindcast` is convention, not a gate                                                                                                                                                                             | [#112](https://github.com/TomBennett-Lloyd/cumulo/issues/112) (comment) |
| The mirror gate's record shape hard-codes the extraction modes and the equality relation                                                                                                                                                                 | [#133](https://github.com/TomBennett-Lloyd/cumulo/issues/133) (comment) |
| CI never builds `apps/web`                                                                                                                                                                                                                               | [#142](https://github.com/TomBennett-Lloyd/cumulo/issues/142) (comment) |
| `Retry-After` is unreadable cross-origin, so the client contract's backoff can never fire                                                                                                                                                                | [#21](https://github.com/TomBennett-Lloyd/cumulo/issues/21) (comment)   |

---

## 2026-07-30 — `aws_budgets_budget.cost_types` left at AWS defaults

- Where: `infra/bootstrap/budget.tf` (`aws_budgets_budget.monthly_cost_ceiling`)
- What: no `cost_types` block, so the budget uses the AWS defaults, which subtract credits and refunds. On an account carrying promotional credits the meter can therefore run well past $100/month of gross usage while net cost stays under threshold and nothing alerts — the alarm reports what will be billed, not what is being consumed. That is a defensible reading of "cost ceiling" for a project whose ceiling is about the bank balance, and it is the current deliberate choice; it stops being defensible the moment credits land on the account, because the whole point of the ceiling is to catch runaway usage _before_ it is expensive. Revisit if credits appear (or before any AWS-credits programme is used for this project): either add `cost_types { include_credit = true, include_refund = false }`, or add a second usage-oriented budget beside the billed-cost one. Not a fix for this diff — it is a policy decision about what the number means, and it wants the account's credit state as an input.
- Source: #38 review cycle 1
- Triage note (2026-07-31): deliberately left in the buffer rather than filed. It is a parked decision with an external trigger (credits appearing on the account), not debt to clear — an open issue would be picked up by backlog burning and correctly do nothing. Convert it the moment the trigger fires.
- Triage note (2026-08-01): re-confirmed on the pass that emptied the other 29 entries. The trigger has not fired; this is the log's only survivor **by decision**, so its age is not evidence that triage is overdue.

## 2026-08-01 — The mirror gate cannot read a Terraform value nested in a sub-block, so a real mirror stays a comment

- Where: `.claude/scripts/check-infra-mirrors.sh`, `tf_attribute_value` (its two-space `attr_re`); the pair it refuses is `throttling_rate_limit` inside `default_route_settings` on `aws_apigatewayv2_stage.default` (`infra/api/gateway.tf`) against `FLEET_FANOUT_LAUNCHES_PER_SECOND` in `apps/web/src/data/http-fleet-data-source.ts`
- What: the gate reads only attributes indented directly inside a `resource` block, so the API stage's throttle — a number the web fan-out genuinely sizes itself against — cannot be declared as a mirror at all (verified: the gate exits 2 with "declares no top-level attribute" when the pair is added), which leaves `architecture.md` rule 8 unsatisfiable for it and the citation comment as the only enforcement; the fix is sub-block addressing in the record (`resource.name.sub_block.attribute`), and it wants deciding alongside the record-shape limitation already captured by [#133](https://github.com/TomBennett-Lloyd/cumulo/issues/133) rather than twice.
- Source: #150
