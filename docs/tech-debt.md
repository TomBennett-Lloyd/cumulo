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

| Captured entry                                                                                                                                                                                                           | Now owned by                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `check-supply-chain-policy.sh` reads YAML by line shape · Supply-chain gate asserts the manifest, but pnpm resolves policy from four places · `check-infra-mirrors.sh` reads Terraform by line shape                     | [#158](https://github.com/TomBennett-Lloyd/cumulo/issues/158)           |
| Only `@cumulo/shared` can express a type-level test                                                                                                                                                                      | [#159](https://github.com/TomBennett-Lloyd/cumulo/issues/159)           |
| Skill score compares two RMSEs computed over different sample sets · A metrics row cannot say which hours of its own period are missing                                                                                  | [#160](https://github.com/TomBennett-Lloyd/cumulo/issues/160)           |
| No error boundary above the dashboard's async work · The map's placeholder shells restate `MapView`'s structure · Loading announcements are per-component conventions                                                    | [#161](https://github.com/TomBennett-Lloyd/cumulo/issues/161)           |
| `invalid-response` now means two different failures · The shared data hook is still named after the surface that was deleted                                                                                             | [#162](https://github.com/TomBennett-Lloyd/cumulo/issues/162)           |
| Cycle rotation advances one location per hour, not one window                                                                                                                                                            | [#163](https://github.com/TomBennett-Lloyd/cumulo/issues/163)           |
| One ingestion alarm now stands for two unrelated operator questions · A forecast consumer pointed at the wrong environment is indistinguishable from an idle fleet · A user-site counter stuck above the real population | [#164](https://github.com/TomBennett-Lloyd/cumulo/issues/164)           |
| Series cleanup runs on the request path                                                                                                                                                                                  | [#167](https://github.com/TomBennett-Lloyd/cumulo/issues/167)           |
| A hook that cannot read its own events disables edit-time lint silently                                                                                                                                                  | [#102](https://github.com/TomBennett-Lloyd/cumulo/issues/102) (comment) |
| The port-inversion invariant in `@cumulo/hindcast` is convention, not a gate                                                                                                                                             | [#112](https://github.com/TomBennett-Lloyd/cumulo/issues/112) (comment) |
| The mirror gate's record shape hard-codes the extraction modes and the equality relation                                                                                                                                 | [#133](https://github.com/TomBennett-Lloyd/cumulo/issues/133) (comment) |
| CI never builds `apps/web`                                                                                                                                                                                               | [#142](https://github.com/TomBennett-Lloyd/cumulo/issues/142) (comment) |
| `Retry-After` is unreadable cross-origin, so the client contract's backoff can never fire                                                                                                                                | [#21](https://github.com/TomBennett-Lloyd/cumulo/issues/21) (comment)   |

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

## 2026-08-01 — Browser-side fetches have no timeout policy, and the de-dup map inherits the hang

- Where: `requestJson` in `apps/web/src/data/http-fleet-data-source.ts`; the `network` cause list on `FleetDataError` in `apps/web/src/data/fleet-data-source.ts`
- What: no `AbortSignal` exists anywhere in `apps/web`, so a stalled fetch never settles — and the `seriesInFlight` entry it owns is only removed on settlement, so that `(site, range)` stays wedged on a promise that never resolves while the view spins with no failure to report. `error-handling.md` rule 3 wants timeout/backoff/final-failure visible at the call site, and `FleetDataError`'s own doc already advertises "timeout" as a network cause that nothing currently produces. The fix is a policy decision for every browser-side external call (which deadline, whether an abort maps to `network` or a distinct arm, how the retry advice reads), not a per-call patch.
- Source: #150 review cycle 2

## 2026-08-02 — The bundle gate's "stale build" verdict only detects multi-entry staleness

- Where: `check-web-bundle.sh` (`.claude/scripts/`), the exit-2 "stale artefacts" branch and the `Exit:` contract line
- What: the gate advertises exit 2 for a "missing or stale build", but the only staleness it detects is two-plus `index-*.js` files; a single leftover entry from an earlier build passes and returns a verdict about code nobody has. Harmless in CI (fresh dist every run) but the normal developer state once #111 wires the gate into `verify`. Related diagnosis-honesty nit: the multi-entry message prescribes `rm -rf apps/web/dist`, which in CI would actually indicate a chunk-name collision, not staleness. Wants a freshness signal (e.g. compare dist mtime against the newest source mtime, or a build-stamp file) decided together with #111's verify wiring.
- Source: #142 review cycle 1

## 2026-08-02 — The conflict-retry budget is derived from a closed cohort, so exhausting it is read as a fault it need not be

- Where: `apps/api/src/sites/conflict-retry.ts` (the derivation comment on `MAX_CONFLICT_RETRIES`, and `CONCURRENT_COUNTER_WRITERS` above it); the two exhaustion events that inherit the reading — `createSiteStoreExhaustedEvent` in `apps/api/src/sites/create-site.ts` and `deleteSiteConflictExhaustedEvent` in `apps/api/src/sites/delete-site.ts`, with the comment beside each `errorResponse('internal', …)`
- What: the derivation counts 10 concurrent counter writers and reasons that every round of contention has a winner, so one request can lose at most 9 rounds before its turn — which holds only for a **closed** cohort of 10 that drains. Under sustained arrival the cohort refills: a loser sleeps its backoff and comes back to a counter now contended by requests that arrived while it slept, so no round guarantees its turn and losing all 9 stays reachable under pure contention. The bound is not the problem — bounded retry on an unauthenticated write path is the point — the _inference_ is: both exhaustion sites tell an operator that contention no longer explains the failure ("more races than the number of things that can be racing explains"), which under a sustained burst may explain it exactly, and so points the reader at a counter/index divergence that is not there. Wanted: either wording that admits the open-arrival case, or a signal that actually separates the two (the last loss kind is already logged on the create path and is a start). Settling it needs a measurement, and that measurement is #155's C4 live burst against the deployed API — credential-gated, not run.
- Source: #155 review cycle 1

## 2026-08-02 — actionlint's action-input check is dead over most of this repo's `uses:` lines

- Where: the `KNOWN RESIDUAL` paragraph in `.claude/scripts/lint-workflows.sh`, and the `Install actionlint (pinned)` step in the `checks` job of `.github/workflows/ci.yml` — the version/checksum pair there is what fixes which popular-actions database ships
- What: actionlint checks action _inputs_ against a popular-actions database baked into the binary at release time, so for any action major newer than the pinned actionlint the check silently does nothing. The gate's header states this as a residual; measured against this corpus it is not a hypothetical edge but the normal case. Verified with 1.7.12 by offering a nonexistent input to each `uses:` ref in `.github/workflows`: 22 of the 27 `uses:` lines are unknown to the database and accept the typo silently — `actions/checkout@v7` (8 uses), `actions/setup-node@v7` (6), `pnpm/action-setup@v6` (6), `hashicorp/setup-terraform@v4` (1), `gitleaks/gitleaks-action@v3` (1) — while only `aws-actions/configure-aws-credentials@v6` (5) is covered and flags it. So a misspelled input on almost any step in this repo passes the gate and surfaces at runtime, on jobs holding OIDC credentials. Not fixable in this PR, and not a bug in the pin: a pin that moved on its own would defeat its own purpose. Closing it is a policy choice between advancing the pin whenever the action majors in use outrun it (making that check part of the bump procedure), holding the actions at majors the pinned actionlint knows, or accepting the class explicitly — and it belongs with the pinned-in-CI/floating-locally split already ledgered on [#108](https://github.com/TomBennett-Lloyd/cumulo/issues/108) rather than being decided twice.
- Source: #129 review cycle 1

## 2026-08-02 — No gate covers a constant restated in prose, so docs drift from the code that owns the value

- Where: `docs/design/fleet-simulation.md`, the "Capacity — triangular(2.0, 4.0, 10.0) kWp" paragraph, which cites "`siteSchema`'s 50 kW sanity bound"; the owner it restates is `MAX_PLAUSIBLE_RESIDENTIAL_KW` in `packages/shared/src/site.ts`. Same class, second constant (#194 review): the 1500 W/m² irradiance ceiling — now owned by `MAX_PLAUSIBLE_IRRADIANCE_WM2` in `packages/shared/src/weather-reading.ts` — is restated as a bare literal in three prose sites no test reddens: `packages/forecast/src/power.ts` ("at their 1500 W/m² caps"), and `packages/forecast/src/physics-forecast.ts` twice (the `A = 1500/1377.7` arithmetic comment, and "at its 1500 W/m² weatherReadingSchema cap"); the arithmetic one is the sharpest, since a value change reddens the cross-package test while leaving that ratio quietly wrong
- What: #86 gave the 50 kW ceiling one owner and pointed every code restatement at it, but prose cannot import a constant, so the design doc keeps a bare literal that nothing checks. Change the ceiling and the schemas, the web copy and the test pins all move or go red; this sentence stays quietly wrong. It is the docs↔code analogue of the infra mirrors `architecture.md` rule 8 governs — there the fix was a declared mirror record plus `check-infra-mirrors.sh`, and the same shape would work here (a declared doc↔constant pair, checked by a gate in `verify`). The general problem — a gate reading a value out of a file by shape — is the one already ledgered against the mirror gate's record format, so it wants deciding with the [#109](https://github.com/TomBennett-Lloyd/cumulo/issues/109)/[#189](https://github.com/TomBennett-Lloyd/cumulo/issues/189) family rather than as a third one-off. Not fixed in this diff: a single prose edit would leave the class untouched, and inventing a doc-mirror record mid-refactor is a gate change, which is a retro PR's decision.
- Source: #86 review cycle 1

## 2026-08-02 — The two batch paths refuse an unusable policy in different shapes

- Where: `requireUsablePolicy` in `packages/storage/src/batch.ts`; its two callers — `putArchiveDay`'s loop head (outside `sending`) and `drainBatches` (reached inside `sending` by `putForecastWeather` and the series adapter's batch path)
- What: `putArchiveDay` validates ahead of the wrap, so a sub-1 `maxAttempts` surfaces as the programming error it is; the drain paths reach the identical validation inside `sending`, so the same bad deps surface as a `StorageError` whose context claims DynamoDB failed on the table — exactly the misdiagnosis the loop-head comment argues against. Pre-existing (the validation always sat inside the wrap); the fix is hoisting a policy check ahead of `sending` on the weather and series batch paths, cross-cutting beyond #166's diff.
- Source: #166 review cycle 2

## 2026-08-02 — The API deadline gates loops, not the straight-line prefix

- Where: `apps/api/src/request-budget.ts` — its header's "Where it stops" and "So the timeout is reachable" paragraphs, which count each route's ungated prefix, and `hasBudgetForStorageCommands`, the admission the looping terms call; the clock they ask is `apps/api/src/http/request-deadline.ts`
- What: every _looping_ term on the API now asks the deadline before each command — series pagination, `POST`'s store-and-evict attempts, `DELETE`'s counted deletes, the series-cleanup pass — so none of them can spin an invocation into the function timeout any more. What stays ungated is each route's straight-line prefix: the per-IP limiter's two commands, the lookups that decide what the handler does, and the first page of any Query, which a pagination bound checks _between_ pages. A request whose prefix commands all take their `STORAGE_COMMAND_WORST_MS` worst case therefore still dies at the timeout, where nothing answers in schema — a killed invocation never reaches `main.ts`'s error boundary, so the caller gets a gateway 504 with the gateway's own body, and on `POST /v1/sites` that costs the caller the new site's id for good. It is reachable only under coinciding independent per-command worst cases in one request (`request-budget.ts` counts the prefix per route and states how many it takes), each of which is itself two burnt request timeouts plus a full backoff — a coincidence no honest slack can be sized against, which is why it is stated here rather than priced. Closing it means gating the prefix per command as well, starting with a deadline check in front of the limiter, and that is a decision about what a request that is already out of time should answer — not a line to add. The other, narrower way to the same 504 is not this entry's: two coinciding tail events inside an admitted series-cleanup pass, which is admitted at one command and spends up to two (`apps/api/src/sites/series-cleanup.ts` states why a two-command admission is unavailable at these constants), is owned by [#167](https://github.com/TomBennett-Lloyd/cumulo/issues/167), which eliminates it wholesale by moving the pass off the request path.
- Source: #165

## 2026-08-02 — The ingestion cycle deadline is conditional on no mid-body stall, and no finite slack covers it

- Where: term 2 of the header in `apps/ingestion/src/cycle-budget.ts` and the guarantee stated on `CYCLE_DEADLINE_MS`; the same gap from the other side of the call is the `throwOnRequestTimeout` comment in `packages/storage/src/client.ts`, on the client whose `socketTimeout` is deliberately unset
- What: the pinned request timeouts bound the time to the **first response**, not the whole attempt — the timer is cleared when response headers arrive, while the body is still an open stream. A response whose body then stalls is bounded by nothing, so no finite subtraction covers it, and `CYCLE_DEADLINE_MS`'s guarantee reads in full as "the function timeout is unreachable _unless a response body stalls mid-stream_". Both files name the condition and cite this log for it rather than claiming more than the flags deliver; this entry is what those citations resolve to. Not priced, deliberately: an unbounded term's honest price is infinite, and carrying it as a margin would dress an open gap up as a covered one. Closing it is a `socketTimeout` decision rather than a flag — it is an _inactivity_ timer, so it fires on a slow-but-progressing response too, which adds a term the cycle budget then has to price and changes what a slow DynamoDB or Open-Meteo response does to a cycle. These are small single-chunk JSON responses, so the case is remote; it is the one condition the budget's identity is conditional on, and it should stay visible until that decision is made.
- Source: #165 C2, carried forward from the entry #165 cleared

## 2026-08-02 — `queryAllPages`'s pagination bound is optional, and four of five call sites walk unbounded

- Where: `queryAllPages` in `packages/storage/src/adapters/storage-adapter-base.ts`, whose `bound` parameter defaults to the ungated walk; the one bounded caller is the API series read, and the unbounded four are `listFleetSites`, `listActiveSitePhysicsAtLocation`, `queryMetricsForPeriod` and `queryArchiveRange`
- What: the deadline work under #165 bounded exactly one page walk — the one a route's remaining time visibly pays for. The other four remain unbounded by construction, and one of them, `listFleetSites`, is on a deadline-carrying API route where `request-budget.ts` prices it at one command on a design argument (ADR 0002's single partition plus `MAX_USER_SITES = 40`) rather than on a gate — the argument `list-sites.ts` itself flags as expiring if the cap ever moves. Because `bound` is optional and defaults to unbounded, nothing mechanical notices a new unbounded call site appearing on a request path; the failure mode is a silently growing walk that the prefix arithmetic no longer describes. The fix direction is a decision, not a line: either `bound` becomes required (every caller states its budget or states `unbounded` in words), or the operator-path walks are typed apart from request-path walks so the compiler carries the distinction the header prose carries today.
- Source: #165 review cycle 1

## 2026-08-02 — The split-capture migration silently narrowed the harness family's raw `$out` readers

- Where: the three places a harness reads `$out` raw instead of through an assertion — `budget="$out"` in `.claude/scripts/check-web-bundle.test.sh`, the `expect_order` loop in `run-script-tests.test.sh` (which states the stdout-only choice in a comment), and diagnostic interpolations like `bad "…; output: $out"` across the family
- What: pre-migration, `$out` held both streams merged, so a raw reader saw everything the subject said; post-migration it holds stdout alone, and only `expect_out`/`expect_not_out` kept the either-stream semantics. The #157 wave deliberately forbade re-triaging assertions, so the narrowing of raw readers rode along unstated: `budget="$out"` is the material case — stderr noise on `--print-budget` used to redden the case by making `budget` non-numeric and now passes unnoticed, with `expect_rc 0` the only other guard. Defensible (a `--print-budget` contract is a stdout contract) but undecided, and nothing marks a raw reader as having chosen its stream. The fix is the deferred family-wide stream re-triage, extended to raw readers: each one either gains a comment stating its stream choice (the `expect_order` precedent) or moves to a stream-explicit assertion.
- Source: #157 review (PR 2) cycle 1

## 2026-08-02 — A late-resolving deep link steals focus from whatever the reader reached first

- Where: the heading-focus mount effect in `apps/web/src/dashboard/SitePanel.tsx`; the arrival path is a `?site=` deep link whose `SitePanel` mounts only when the fleet listing resolves
- What: the effect focuses the panel's heading on mount, and on a deep-link arrival that mount is not page load — it is whenever the listing resolves, which can be seconds later. Anything the reader focused in the meantime loses focus with no action of theirs (WCAG 3.2.5 territory). The answer is not local to the effect: either the first run is skipped on the deep-link path, or focus moves only on reader-initiated selection — and the felt half of the decision needs the browser lane (#107) rather than jsdom. The convention in `docs/standards/react.md` records the deep-link focus as decided-for-now; this entry is the recorded doubt against it.
- Source: #161 review cycle 1

## 2026-08-02 — The hooks' "stdin was unreadable" report is dead code behind a hang

- Where: the `read_hook_event` failure arms in `.claude/hooks/post-edit-check.sh` and `.claude/hooks/ensure-deps.sh`; the hang itself is `read_hook_event`'s `cat` in `.claude/hooks/hook-context.sh`
- What: both hooks now carry an honest "could not read the hook event" report on the `read_hook_event` failure path, but the scenario it names cannot reach it — with stdin closed or absent, `cat` blocks and the hook hangs (measured: 5 s timeout, identical on the pre-#102 copies, so pre-existing). The report is right about intent and wrong about reachability; the real fix is in `read_hook_event` itself (a `-t 0`/timeout guard around the read, or reading with a bounded mechanism), after which the failure arms become live. Until then the arms are aspiration, and only the `hook_event_field` interpreter-failure arms — which ARE pinned by harness cases — carry the loud-cannot-judge property.
- Source: #102 review cycle 1

## 2026-08-02 — canon spawns an interpreter per path, and the sweep multiplies it

- Where: `canon` in `.claude/scripts/worktree-lib.sh`; its per-porcelain-line call sites in `reap-worktree.sh` and `sweep-worktrees.sh`
- What: the python→node migration kept canon's one-path-per-process shape, so reap is O(worktrees) node spawns and a sweep is O(N²); the lifecycle harness measured 27 s → 42 s on the same cases. No correctness impact and fine at this repo's worktree counts — recorded so the cost has a name. Fix direction if it ever bites: a `canon_many` reading a NUL-separated list in one spawn, or batching the porcelain parse's canon calls.
- Source: #102 review cycle 1

## 2026-08-02 — reap's broken-git-link shape arm is shadowed by the identity arm

- Where: the shape arm of the broken-git-link guard in `.claude/scripts/reap-worktree.sh`; the boundary is recorded in the case-35 comment of `.claude/scripts/worktree-lifecycle.test.sh`
- What: every fixture that breaks the `.git` link by deleting the file is answered by the identity arm (an empty link joins onto `$wt` and fails the comparison), so the shape arm's `keep` survives mutation — proven twice, by the reviewer and by the override-seam reproduction. Its only unique input is a `.git` file holding the recorded admin dir with the `gitdir: ` prefix stripped: a shape no tool produces, which is why the reviewer sized closing it as defence-in-depth rather than behaviour and declined to spend a cycle. If a future reader wants the arm pinned, the case is six lines on `nested_worktree_fixture` writing that exact content and asserting `broken-git-link`.
- Source: #102 review cycle 1

## 2026-08-02 — The token preview hand-rolls a chart the chrome convention cannot reach

- Where: `apps/web/src/preview/TokensPreviewChart.tsx`; the convention it diverges from is `apps/web/src/charts/chart-copy.ts` and `docs/design/chart-treatment.md`'s "every chart states the clock" paragraph
- What: the preview's swatch builds its own plot and table twin, so its time column still reads `Time` while every shipped twin reads `Time (UTC)`, and its plot prints no clock — invisible to every gate (`preview/` is excluded from the copy contract, and `chart-copy.ts` cannot reach a hand-rolled twin). Not a one-line fix: the swatch's hours are invented strings, not UTC instants, so stamping a clock on them would assert a zone about fabricated data, and the file's own header disclaims being a chart component. Either converge the preview onto `forecastChartTable`/`chart-copy.ts`, or declare the swatch exempt in `chart-treatment.md` so "every chart states the clock" reads as the spec it is rather than a census the repo contradicts.
- Source: #104 review cycle 1

## 2026-08-02 — A dashboard test pins the chart's chrome wording by whole-table toEqual

- Where: the aggregation-completeness test's row assertion in `apps/web/src/dashboard/FleetPanel.test.tsx`; the chrome it restates is `TIME_COLUMN_HEADER` in `apps/web/src/charts/chart-copy.ts`
- What: the whole-table `toEqual` embeds the header row, so any future chrome-wording change breaks a test that is about aggregation, in another directory, by a mechanism its comment never mentions — #104 paid that cost once at a wave boundary. Pattern-level fix is a testing-convention decision: the row assertion drops the header row (a `ForecastChart` test owns the header), or the test imports `TIME_COLUMN_HEADER`. Either ends the recurrence; choosing is the decision.
- Source: #104 review cycle 1

## 2026-08-02 — Five of the twelve consolidated strings sit outside every phrase-class sweep

- Where: `partialAggregateNotice`, `aggregatedFromCaption`, `APP_FAILURE_HEADING`, `APP_FAILURE_ADVICE` and `RETRY_ACTION_LABEL` in `apps/web/src/dashboard/state-copy.ts`; the sweeps are `state-copy-contract.test.ts`'s four assertions
- What: the contract's phrase classes (pending ellipses, failure prefixes, the banned adjective, the empty-fleet sentence) guard seven of the twelve moved strings; the other five are headings, captions and control names — precisely the class the contract's own header says no mechanical rule can separate from legitimate JSX text. They are pinned by rendered-wording component tests, which catch drift but not re-inlining: a second `Try again` button authored beside its JSX passes every gate. A stated residual, not a defect — the fix (per-string allowlist or a stronger rule) is what the header rejected on rot grounds; recorded so the boundary is a decision on file rather than an accident.
- Source: #104 review cycle 1

## 2026-08-02 — The half-open UTC window is still declared five ways beside its named contract

- Where: `UtcWindow` in `packages/shared/src/timestamp.ts` is the named contract; the re-declarations are `metricsPeriodSchema` in `packages/shared/src/metrics.ts` (structural zod shape, not derived), the positional `fromInclusive, toExclusive` pairs on `querySeriesRange` (`packages/storage/src/adapters/series/series-adapter.ts`) and `queryArchiveRange` (`packages/storage/src/adapters/weather/weather-adapter.ts`), and `apps/api`'s `series-window.ts` bounds plus the `{from, to}` request shape in `get-site-series.ts`
- What: #117 named the type and moved it home, but three of the five surviving declarations are positional same-shaped timestamp pairs — exactly the swap hazard the named bounds exist to prevent — and the zod schema restates the shape without `z.infer` tying it. Architecture rule 2's "two definitions of one concept" standard sits against all five. Unification is cross-cutting (storage adapter signatures, an API request shape, a schema derivation) and each piece can move independently; captured as one entry so the follow-up sees the whole set instead of discovering it serially.
- Source: #117 review cycle 1
