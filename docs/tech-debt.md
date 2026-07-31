# Tech-debt log

A **buffer, not an archive**. `/review-loop` appends SYSTEMIC findings here instead of iterating on them; `/triage` periodically clusters entries, files root-cause GitHub issues, and **deletes** what it captured. A long-lived entry here means triage is overdue.

Entry format:

```
## YYYY-MM-DD — short title
- Where: file/module references
- What: the pattern or problem (symptom AND suspected root cause if known)
- Source: PR/issue #
```

---

## 2026-07-30 — seed parameter silently coerces to uint32

- Where: `packages/shared/src/fleet.ts` (`generateFleet`, mulberry32 seeding via `seed >>> 0`)
- What: `seed` is typed as bare `number` but coerced, so distinct inputs collide — `generateFleet(1)`, `generateFleet(1.5)`, and `generateFleet(4294967297)` all return the same fleet, and the "different seeds → different fleets" test only holds for distinct uint32s. Root cause is the missing branded type for a meaningful primitive (typing.md rule 1); a `FleetSeed` uint32 brand belongs in the #50 branded-unit retrofit rather than a local fix.
- Source: #9 review cycle 2

## 2026-07-30 — `uncertaintyBandSchema` / `UncertaintyBand` not exported

- Where: `packages/shared/src/forecast.ts`, `packages/shared/src/index.ts`
- What: the plan pinned four exports and the band is not one of them, so it stays module-private. #19's fleet aggregate needs exactly this vocabulary (summing per-site bands into a fleet band), and without a decision it will re-declare the concept in a second place. Decide before #19: export the schema and its inferred type, or standardize on `NonNullable<Forecast['uncertainty']>` as the referencing idiom. Either is defensible; silently having neither is what produces the duplicate.
- Source: #10 review cycle 1

## 2026-07-30 — Latitude/longitude are unbranded, so a swapped pair parses cleanly

- Where: `packages/shared/src/weather-reading.ts`, `packages/shared/src/site.ts`
- What: both files declare `latitude`/`longitude` as bare `z.number()` with copy-pasted bounds. Structurally the two are the same type, so `{ latitude: -6.26, longitude: 53.35 }` — Dublin's coordinates transposed — parses without complaint and sends a weather fetch to a field in Kazakhstan; the duplicated bounds also drift independently. `typing.md` rule 1 names exactly this (physical-unit confusion, with lat vs lon as its worked example) as the case for branded types. The fix is one shared branded coordinate schema adopted by `site.ts`, ingestion (#11), and ADR 0002's `locationId` key function (#13) in a single move — a coordinated cross-module change, not a bound tweak, and it feeds the #50 branding retrofit. Adjacent to the antimeridian entry above: both are the same missing coordinate abstraction seen from different sides.
- Source: #10 review cycle 2

## 2026-07-30 — site.test.ts bounds are not mutation-proof

- Where: `packages/shared/src/site.test.ts`
- What: single acceptance fixture with no boundary values, so `.gte`/`.lte` inclusivity mutants survive on lat/lon, `capacityKw`, tilt, azimuth — the same gap class closed for the #10 schemas (boundary-acceptance + single-mutation rejection tables). Bring `site.test.ts` up to the same pattern, ideally alongside the #50 branding retrofit since fixtures change anyway. Cycle-3 mutation check found the same residue in `weather-reading.test.ts`: the upper edges of the four irradiance caps (1500) and the wind cap (120) are unpinned — five `boundaryCases` rows close it; batch with this entry.
- Source: #10 review cycle 2 fix agent (discovered)

## 2026-07-30 — `.optional()` under `exactOptionalPropertyTypes` admits explicit `undefined`

- Where: `packages/shared/src/forecast.ts` (`uncertainty`), any future optional schema field
- What: Zod's `.optional()` produces `uncertainty?: T | undefined`, so `{ uncertainty: undefined }` parses even with `exactOptionalPropertyTypes` on — the key is present with an undefined value. DynamoDB `PutItem` marshalling throws on exactly that unless `removeUndefinedValues: true` is set on the document client. #13 needs a house rule (set the marshalling option, or strip undefined keys at the adapter boundary) so this fails at one known place rather than at runtime per-field.
- Source: #10 review cycle 1

## 2026-07-30 — Self-protection guards match paths as globs, not literals

- Where: `.claude/scripts/reap-worktree.sh`:84,109; `.claude/scripts/sweep-worktrees.sh`:69
- What: `case "$path" in "$wt" | "$wt"/*)` expands `$wt` as a glob pattern. A worktree path containing `[`, `*` or `?` can fail to match its own literal cwd, bypassing both the `own-cwd` and `live-session` guards — reap could then remove the directory the running session sits in. No work is lost (the tree must still be clean and merged to reach that point), and the repo's `<n>-<slug>` naming never produces such a path, so this is latent rather than live. The literal form is `[ "${pwd_canon#"$wt"}" != "$pwd_canon" ]`; the idiom repeats in three places, so the fix is one shared helper rather than three edits.
- Source: #42

## 2026-07-30 — Sweep shares stdin with its reap children

- Where: `.claude/scripts/sweep-worktrees.sh`:62-94
- What: the `while read` loop over worktree entries shares stdin (a heredoc) with each `reap-worktree.sh` child, which itself runs a caller-supplied `$WORKTREE_GH_CMD`. A child that reads stdin silently consumes worktree entries, and the sweep skips those worktrees without a word. The failure direction is safe (skipped = kept), but silent skipping in a backstop defeats the point of having a backstop — it would report `swept 0, kept 2` on a repo with five worktrees and look correct. Fix is `< /dev/null` on the child invocations.
- Source: #42

## 2026-07-30 — Reap re-derives the admin dir instead of using the one it was given

- Where: `.claude/scripts/reap-worktree.sh`:97
- What: `git_dir` comes from `rev-parse --absolute-git-dir` run inside the target, which searches ancestors. Because Cumulo nests worktrees _inside_ the main checkout (`.claude/worktrees/`), a worktree whose `.git` file is missing resolves to the **main repo's** `.git`. The min-age probe then measures the main checkout's activity and `is_clean` reports the main checkout's status — two safety guards judging a different repository than the one under consideration. Reproduced by the cycle-2 reviewer. Fail-safe today (`worktree remove` refuses validation, reap exits 2, nothing deleted), which is why it did not block. Structural fix: take the admin dir from the `worktree list --porcelain` block that reap already parses, rather than re-deriving it.
- Source: #42

## 2026-07-30 — Nothing resolves a stale worktree admin entry

- Where: `.claude/scripts/sweep-worktrees.sh`:106; `.claude/skills/execute/SKILL.md` step 1
- What: dropping the unconditional prune was correct (it destroyed recoverable admin data under `--dry-run`), but now nothing in the workflow clears a genuinely dead entry. Consequence, verified: `git worktree add` at that path fails with `fatal: … is a missing but already registered worktree`. Since the execute skill uses deterministic paths (`.claude/worktrees/<n>-<slug>`), a killed session whose directory was deleted by hand blocks re-execution of that same issue until a human prunes. Sweep detects it and re-counts it `kept` on every future run, so the warning repeats indefinitely. Git's own error names the remedy, so this is friction rather than a bug — wants a line in the skill docs or an explicit opt-in flag, not a behaviour change.
- Source: #42

## 2026-07-30 — `--dry-run` destroys nothing, but is not read-only

- Where: `.claude/scripts/worktree-lib.sh`:57 (`is_merged`), called from `reap-worktree.sh`:126 before the dry-run branch at :132
- What: `is_merged` runs `git fetch origin main` in the main checkout, so a dry sweep issues one fetch per candidate — writing remote-tracking refs and objects, plus whatever `gc --auto` decides. The mutation is additive and cannot lose work, so the safety property holds, but the distinction matters: the comments now say "destroys nothing" rather than "read-only". Making the fetch conditional on non-dry-run (or hoisting one fetch per sweep) would both restore the stronger property and remove N-1 redundant network calls.
- Source: #42

## 2026-07-31 — `createPhysicsForecast` throws on boundary-accepted inputs, with no caller policy

- Where: `packages/forecast/src/physics-forecast.ts` (`createPhysicsForecast`'s final `forecastSchema.parse`), `packages/forecast/src/irradiance.ts` (`MINIMUM_COS_ZENITH_FOR_PROJECTION_RATIO`)
- What: the final parse is an uncaught throw, justified as a bug guard — but its bounds are reachable from inputs `siteSchema` and `weatherReadingSchema` both accept, so the throw is not exclusively a programmer-error signal. Route: Hay-Davies floors cos(zenith) at 0.01745 (pvlib GH 432), capping `Rb` near 57.3; the circumsolar term is DHI · A · Rb, so with the anisotropy index A = 1.089 at the measured point the amplification is 62.4x. Measured on a schema-valid Dublin site (tilt 90, azimuth 89.47) at 2026-03-20T07:00:00Z with every irradiance field at its 1500 W/m² cap: POA 95 241 W/m², cell 3870 °C, DC −5478 kW, AC −5259 kW — three separate `forecastSchema` bounds violated. Root cause is not the guard (fail-fast is right) but the missing decision one layer up: error-handling rule 1 splits expected failures (values) from bugs (exceptions), and an implausible-but-accepted weather hour is the former wearing the latter's clothes. #13's forecast Lambda and #16's hindcast need one policy between them — abort the cycle on a ZodError, or have the forecast package return a typed expected failure for out-of-range results so a single bad upstream hour cannot take down a fleet-wide run. Decision input for those tickets, not a change to this diff.
- Source: #12 review cycle 1

## 2026-07-30 — Lifecycle tooling has an undeclared python3 dependency

- Where: `.claude/scripts/worktree-lib.sh`:20,68 (and the porcelain parsing in `reap-worktree.sh`)
- What: a Node/pnpm repo's worktree tooling hard-depends on `python3` for realpath resolution, `worktree list --porcelain` parsing, and JSON handling. Failure is safe (exit 2 everywhere) but total, and it is invisible in `package.json` and CI, so a host without `python3` gets a lifecycle system that silently does nothing useful. `gh pr list --json headRefOid --jq …` and `git worktree list --porcelain -z` would remove most of the need. Related to #47 (CI did not run these scripts at all; fixed by #64) and #48 (no shellcheck gate; fixed by #69 — shellcheck itself has nothing to say about an undeclared `python3`, so this entry survives the gate).
- Source: #42

## 2026-07-31 — `@smithy/core` is a direct dependency whose major we do not own

- Where: `packages/storage/package.json` (`"@smithy/core": "^3.31.1"`), `packages/storage/src/client.ts`:3 (`ConfiguredRetryStrategy` from `@smithy/core/retry`)
- What: pinning the retry curve (ADR 0002 Consequence 5) needs `ConfiguredRetryStrategy`, which is only reachable from `@smithy/core` — an SDK-_internal_ package. Declaring it directly makes us the range-owner of a major version that is really owned by `@aws-sdk/client-dynamodb`: the two ranges can be bumped independently, and a resolution where our `ConfiguredRetryStrategy` is a different copy from the one the DynamoDB client's retry middleware is built against would break the pinned strategy at runtime. Today they dedupe to one copy, and the `toBeInstanceOf(ConfiguredRetryStrategy)` assertion in `packages/storage/src/client.test.ts` (the "pins the retry strategy" test) would fail if they split — so this is latent, not live. The fix is repo-level rather than package-level (a pnpm catalog entry, or a stated policy that smithy ranges are aligned to the SDK's), and until it exists every future package that needs to pin retry behaviour re-takes the same coupling on its own.
- Source: #13 review cycle 1

## 2026-07-31 — Duplicate item keys in write requests surface as StorageError, not caller bugs

- Where: `packages/storage/src/adapters/weather/weather-adapter.ts` (`putArchiveDay`, `putForecastWeather`), `packages/storage/src/adapters/series/series-adapter.ts` (`putForecasts`, `putGenerationReadings`)
- What: two readings/forecasts sharing a key pass every precondition and reach DynamoDB, which rejects the whole request (`ValidationException`) — wrapped as `StorageError`, pointing operators at AWS instead of the caller. The read path already de-duplicates for exactly this reason (`listFetchedArchiveDays`); the reasoning wasn't carried to writes. Different answers per method: the transaction path can take a cheap Set-based precondition; the chunked batch paths need a policy call (reject vs last-wins dedupe). Not a data-integrity bug — rejection is atomic and loud.
- Source: #13 review cycle 2

## 2026-07-31 — Length half of the frontend gate is unenforced outside its allow-list

- Where: `stylelint.config.mjs` (`scale-unlimited/declaration-strict-value` property list), `apps/web/src/preview/preview.css`, `packages/ui/src/tokens/tokens.css`
- What: cycle 2 closed the colour half of the gate (colour-bearing shorthands now demand tokens), but the length half is still allow-list-shaped and the list names only spacing-ish properties. A raw size therefore reaches the page through any property it omits — `width`, `height`, `max-width`, `inset`, `flex-basis`, `border-width`, `letter-spacing`, `stroke-width`, `grid-template-columns`. This is not hypothetical: committed CSS already depends on it (`max-width: 44rem` in preview.css), so the gate as shipped says "no arbitrary sizes" while the repo contains arbitrary sizes. Colour had a property-agnostic backstop available (hex and colour-function literals are recognisable by pattern anywhere); lengths have none, because a length is legal syntax in every property. So the only fix is extending the allow-list, and that cannot be done as a config tweak: the token set has spacing, type-scale and radii, but no measure (`--measure-prose`) or layout-size category, so adding `max-width` today would fail the very stylesheet it guards with no token to point at. Root cause is a missing token category, not a missing rule — a design-system scope ticket that adds the categories and closes the list in one move.
- Source: #15 review cycle 2

## 2026-07-31 — Neither lint gate has a committed regression test

- Where: `stylelint.config.mjs`, `eslint.config.mjs`, `package.json` (`verify`)
- What: both review cycles found real holes in these gates (cycle 1: property-agnostic colours; cycle 2: colour-bearing shorthands, and `lab()`/`lch()` missing from the ESLint regex), and both were found by ad-hoc probing — scratch stylesheets and scratch `.tsx` files, run by hand, deleted afterwards. Nothing in the repo now proves any of it. The gates are exactly the kind of config where a silent regression is invisible: a mistyped property name, a dropped array entry, or an `overrides` block widening its `files` glob all leave `pnpm verify` green, because a gate that stops firing produces _no_ output. testing.md rule 4 ("every bug fix lands with a regression test that fails on the pre-fix code") applies to config fixes as much as to source, and it has now been skipped twice. The ratchet is a fixture pair run under vitest — a should-fail stylesheet asserting a specific error count, a should-pass clean stylesheet, and a tokens-exemption control proving the one legitimate escape still works — plus the equivalent for the ESLint colour-literal selectors. Cross-cutting (it needs a test harness that shells out to the linters and a home for the fixtures), so it is a ticket rather than an addendum to this diff.
- Source: #15 review cycle 2

## 2026-07-31 — JSX presentation attributes escape both halves of the gate

- Where: `eslint.config.mjs` (`no-restricted-syntax` block), `docs/design/chart-treatment.md`, #19's SVG chart component
- What: the two gates divide the world into CSS files (stylelint) and colour-shaped string literals in TS/TSX (ESLint). SVG presentation attributes fall between them: `<line stroke="red" stroke-width="2" />` is not a CSS declaration, and `"red"` is not a hex or colour-function literal, so nothing objects. `JSXAttribute[name.name="style"]` is already banned, which shows the selector shape is available — the omission is the attribute _name list_, not the technique. This matters now rather than in the abstract because #19 is an SVG chart: `stroke`, `fill`, `stop-color`, `stroke-width` are the natural way to write one, and they are precisely the attributes that carry design values. The fix is a deliberate restriction on those attribute names (permitting `var(--token)` strings and the handful of genuine keywords like `none`/`currentColor`), decided once so the chart is written against it rather than retrofitted after review.
- Source: #15 review cycle 2

## 2026-07-31 — Charts render a UTC time axis without saying so on the chart

- Where: `apps/web/src/charts/ForecastChart.tsx` (the `kW` axis title, `xLabelElements`), `apps/web/src/charts/forecast-chart-table.tsx` (the table twin's Time column), `docs/design/chart-treatment.md` ("The time axis")
- What: the clock itself is now settled and written down — #19 chose UTC, the treatment doc states it with the DST reasoning, and `chart-geometry.ts` labels through `getUTC*` accessors only. What remains is the obligation that decision carries: the treatment says a chart owes its clock in words somewhere in its chrome, and neither the axis nor the table twin says "UTC" anywhere. A reader in Ireland in July sees the modelled peak an hour left of local solar noon with nothing on screen to explain it, which reads as a modelling error rather than a labelling convention. The change is small per chart (an axis title, a caption suffix) but the wording is design-system-wide — every future chart and table twin inherits it — so it wants deciding once alongside the UI vocabulary rather than invented per component. The separate, larger question of a per-site _local_ axis stays open and is gated on carrying a timezone per site.
- Source: #15 review cycle 2; the doc half was closed by #19 C7

## 2026-07-31 — A length-1 run renders as nothing, so isolated measurements are invisible

- Where: `apps/web/src/charts/chart-series.ts` (`contiguousRuns`, `polylinePoints`, `bandPolygonPoints`), `apps/web/src/charts/ForecastChart.tsx` (`actualsElements`, `bandElements`), `docs/design/chart-treatment.md` ("Median forecast and actuals")
- What: breaking a series at its gaps is right, and the consequence was not designed. A run of one sample becomes a `<polyline>` with a single vertex and a band polygon with two coincident edges — both render nothing at all. So an hour measured between two gaps, or a lone banded hour, is drawn as empty chart while a neighbouring pair of hours draws a line; the value exists only in the table twin, and the chart silently understates how much was measured. Exactly the shape of the interior-gap entry this branch closed: an unspecified case that the component resolves by accident. The treatment should say what an isolated sample looks like (the obvious answer is the marker vocabulary it already defines for end-dots, ≥ 8px and ringed in `--color-surface`), and the component should render runs of one as marks rather than as degenerate paths — one move across doc and component, not a patch to either.
- Source: #19 review cycle 1

## 2026-07-31 — Two wordings for the same empty-fleet condition

- Where: `apps/web/src/views/SiteDetailView.tsx` ("No sites in the fleet yet"), `apps/web/src/views/FleetAggregateView.tsx` (`NO_SITES_TEXT`, "No active sites yet")
- What: the same fact — the fleet has no sites — reaches the reader in two different sentences depending on which tab they are on, and one of them says "active" while nothing in the data model distinguishes active from inactive. The copy for empty, loading, failed and partial states is product vocabulary, not per-component prose: `views.css` already treats these four as one family with a colour each, and the strings drifted anyway because nothing holds them. Wants a shared copy module (or a documented vocabulary) covering the four state families across every view, so a third view cannot invent a fifth wording. Batch with the parked "say UTC in the chrome" decision above — both are the same missing decision about who owns user-facing wording in `apps/web`.
- Source: #19 review cycle 1

## 2026-07-31 — The chart's keyboard readout is announced to nobody

- Where: `apps/web/src/charts/ForecastChart.tsx` (`role="img"` + `tabIndex={0}` on the `<svg>`), `apps/web/src/charts/forecast-chart-hover.tsx` (`ForecastChartHoverLayer`), `docs/design/chart-treatment.md` ("Hover layer and the table view")
- What: arrowing through the series updates the tooltip visually, and a screen reader says nothing — `role="img"` collapses the subtree to its `aria-label`, so the readout's text is not in the accessibility tree at all, and there is no live region to announce the change. The treatment's "keyboard focus shows exactly what hover shows" is met for a sighted keyboard user and not for an AT user, which is the population the sentence sounds like it is about. The table twin is the sanctioned relief and it is present, so this is a gap in what we claim rather than an unreachable value. Three candidate answers — an `aria-live` region carrying the active sample's readout, `role="application"`-style semantics with a described-by target, or documenting the table as the AT path and dropping the focus affordance's implied promise — and the choice binds every future chart, so it wants deciding once with the treatment doc rather than per component.
- Source: #19 review cycle 1

## 2026-07-31 — `pnpm verify` never builds: export maps and CSS entry drift ship green

- Where: root `package.json` (`verify`), `apps/web/package.json` (`build`), `packages/ui` export map, `apps/web/src/main.tsx`
- What: no gate runs `vite build` or resolves `@cumulo/ui`'s export conditions/CSS imports — `main.tsx` has no test and vitest resolves neither, so a broken `exports` entry, renamed `styles.css`, or missing `@import` renders the demo unstyled while CI stays green. Fix is cross-cutting: `build` scripts in every buildable package, `pnpm -r build` joining `verify`, and a decision on artifact paths vs the `dist/**` lint exemptions.
- Source: #15 review cycle 3

## 2026-07-30 — Terraform guard logic has no way to exercise its failure path

- Where: `infra/bootstrap/budget.tf` (the `data.aws_ssm_parameter.notification_email` postcondition); no `*.tftest.hcl` anywhere in `infra/`
- What: the postcondition exists to turn a malformed notification address into a plan-time failure, and nothing in the repo has ever made it fail. The regex was verified by hand in `terraform console` — which is how cycle 1 caught that `^[^@\s]+@…$` happily accepted `<tom@example.com>`, the exact shape the error message claims to reject. `terraform fmt` and `validate` do not evaluate conditions, so a guard that never fires and a guard that cannot fire look identical to CI. Root cause is a missing harness, not a missing assertion: `terraform test` with a `.tftest.hcl` fixture (`expect_failures` on the data source, mock/override values for the parameter) is the cross-cutting fix, and it applies to every future precondition, postcondition, and variable `validation` block in this stack — the OIDC subject prefix and bucket-name assumptions are the next candidates. Wants one fixture pattern plus a CI step, not a per-resource fix.
- Source: #38 review cycle 1

## 2026-07-30 — `aws_budgets_budget.cost_types` left at AWS defaults

- Where: `infra/bootstrap/budget.tf` (`aws_budgets_budget.monthly_cost_ceiling`)
- What: no `cost_types` block, so the budget uses the AWS defaults, which subtract credits and refunds. On an account carrying promotional credits the meter can therefore run well past $100/month of gross usage while net cost stays under threshold and nothing alerts — the alarm reports what will be billed, not what is being consumed. That is a defensible reading of "cost ceiling" for a project whose ceiling is about the bank balance, and it is the current deliberate choice; it stops being defensible the moment credits land on the account, because the whole point of the ceiling is to catch runaway usage _before_ it is expensive. Revisit if credits appear (or before any AWS-credits programme is used for this project): either add `cost_types { include_credit = true, include_refund = false }`, or add a second usage-oriented budget beside the billed-cost one. Not a fix for this diff — it is a policy decision about what the number means, and it wants the account's credit state as an input.
- Source: #38 review cycle 1

## 2026-07-31 — `test:scripts` hand-enumerates its harnesses, and hides the second one's results

- Where: root `package.json` (`test:scripts`), `.claude/scripts/*.test.sh`
- What: `test:scripts` is a literal list — `bash …/worktree-lifecycle.test.sh && bash …/check-adr-index.test.sh`. Two failure modes, both silent. A third harness added next to these two is green-by-absence until someone remembers to extend the string, which is the same drift class #47/#64 just fixed one level up (CI enumerating `verify`'s gates instead of calling the composite) — fixed for the CI→`verify` edge and left in place for the `verify`→harnesses edge. And `&&` short-circuits: when the first harness fails the second never runs, so a red run reports one harness's findings and conceals the other's, turning what should be one fix-everything cycle into two. Real fix is discovery plus a floor: `find .claude/scripts -name '*.test.sh'` driving a loop that runs every harness, accumulates exit codes rather than short-circuiting, and fails loudly if the search matched nothing — a script rather than a package.json one-liner, which is why it is a ticket and not an addendum here.
- Source: #75 review cycle 1

## 2026-07-31 — ADR row grammar and the ADR immutability policy are on a collision course

- Where: `.claude/scripts/check-adr-index.sh` (`row_re`), `docs/adr/README.md`
- What: `row_re` anchors on `\)[[:space:]]*$`, so an index row may carry nothing after the link. Meanwhile `docs/adr/README.md` states ADRs are immutable once merged and are superseded rather than edited — and the first supersession will want the index to say so: `- [0002 — Storage split](0002-storage-split.md) — superseded by 0007`. The gate will reject that row as malformed, correctly by its own grammar, at the exact moment the policy is first exercised. Whoever hits it will be mid-supersession and will reach for the quickest unblock, which is loosening the trailing anchor to `.*$` and thereby giving up the strictness the grammar exists for. The decision wants making before then, not under pressure: extend the grammar with an optional, _structured_ status suffix the gate can parse and check (a `superseded by NNNN` that must name a real ADR closes a drift hole the index has today), or rule that supersession is recorded only in the ADR bodies and the index stays link-only. Either is defensible; discovering the conflict during a supersession is not.
- Source: #75 review cycle 1

## 2026-07-30 — `lint:sh`'s discovery filter is the untested half of the gate

- Where: `.claude/scripts/lint-shell.sh`:58-88 (shebang regex, `-z` read loop, empty-list guard); `.claude/scripts/lint-shell.test.sh`
- What: the gate's value rests entirely on _which files it finds_, and nothing exercises that. `lint-shell.test.sh` pins the working-tree existence skip (the bug it was written for) and, via its file count, that the skip did not widen into "skip everything" — but the shebang regex, the NUL-delimited loop and the "found nothing → broken filter" guard are still unasserted. A regex edit that silently stops matching `.githooks/pre-commit`, or a loop change that drops the last entry, leaves `pnpm verify` green while the gate covers less than it claims. The regression mode is **silent under-coverage** — the same failure class as #47, where a harness was green by absence. One more instance in the same span: the shebang probe's `read -r first_line <"$file" 2>/dev/null || true` cannot distinguish "empty file" from "could not open", so an unreadable extensionless script is silently dropped from the set. The fix is a discovery case proper: a fixture repo holding one file of each population (`*.sh`, extensionless-with-shebang, extensionless-without, a git-ignored script, an unreadable script) with the gate's chosen set asserted against an expected list, rather than inferred from a count.
- Source: #48/#61 review

## 2026-07-30 — shellcheck version skew between local and CI

- Where: `.claude/scripts/lint-shell.sh` (invokes whatever `shellcheck` is on PATH); `.github/workflows/ci.yml` (relies on the runner's preinstalled binary); `README.md`:24 (`brew install shellcheck`)
- What: local resolves to shellcheck 0.11.0, `ubuntu-latest` ships 0.9.0. Both ends of the gate float independently, so the same commit is analysed by two different analysers — new checks and changed defaults land locally months before CI, and the reverse (a runner image bump) can red a branch nobody touched. This breaks the invariant the composite `verify` exists to provide: that a local pass and a CI pass mean the same thing. Fix is a pinned source rather than a PATH lookup — an npm-wrapped shellcheck in `devDependencies`, or an explicit pinned install step in CI. Which one is a repo-wide dependency-policy call (it sets the precedent for every non-Node tool the gates depend on, gitleaks included), not a line change in this script.
- Source: #48/#61 review

## 2026-07-30 — No policy for pinning tools whose vendors ask to be pinned

- Where: `packages/shared/package.json`, `packages/ui/package.json`, `apps/web/package.json` (three copies of vitest on a caret range); `.claude/scripts/lint-shell.sh` (unpinned shellcheck); `README.md`:35; `.githooks/pre-commit`:15-17
- What: vitest prints "experimental — please pin" for the typecheck mode that #61's type-level gate depends on, and we run it on a caret range: a minor bump can change or remove the feature a gate is built on, with no signal until the gate breaks or, worse, quietly stops asserting. Same class as the shellcheck skew above — floating versions under load-bearing gates — so it wants one decision covering both: which tools get exact pins, what triggers a deliberate bump, and where that is written down. Also folds in a documentation instance of the same drift, now seen in two places: `README.md`:35 enumerates the CI gate list in prose (`pnpm lint`, `typecheck`, `test`, `format:check`) and is already stale — it names neither `check:adr-index` nor `test:scripts` — and the header comment at `.githooks/pre-commit`:15-17 restates the same list for the same purpose ("whole-repo lint, typecheck, test, format:check plus a full-history gitleaks scan"), missing the same two. Two independent copies of a list that only `package.json` owns is the pattern, not two typos — and #64 already removed the third copy from `ci.yml` for exactly this reason. Gates should be enumerated in `package.json` only, with prose pointing at `pnpm verify` rather than restating its contents.
- Source: #48/#61 review

## 2026-07-31 — Tech-debt entries cite line numbers and copied literals, which drift

- Where: this file — e.g. the python3 entry cites `worktree-lib.sh`:20,68 where the second call now sits at :75; the `test:scripts` entry quotes the script literal as two harnesses after this branch made it three; two more pointer corrections were needed on this very PR (#69 closing review)
- What: entries that pin a claim to a line number or a copied code literal go stale the moment an unrelated change moves the code — and a stale pointer sends whoever picks the entry up to a place that does not contain the thing, or silently understates the blast radius. This is the same drift class the pinning entry above diagnoses in `README.md` prose, recursing into the debt log itself. Fix is a convention for this file, not more edits: cite files and symbol/section names (function names, headings, config keys), never bare line numbers; describe code rather than quoting it verbatim unless the quote is the finding. Wants one line in this file's header stating the rule.
- Source: #69 closing review

## 2026-07-31 — Test-support modules live in the production source tree with dev-only imports

- Where: `packages/storage/src/adapters/*/​*-fixtures.ts`, `packages/storage/src/adapters/storage-error-capture.ts`, `packages/storage/src/recording-http-handler.ts`
- What: the #77 C3 test split moved shared test support out of `.test.ts` files into plain modules under `src/`, and they statically import dev-only packages (`vitest`'s `expect`, `aws-sdk-client-mock`). Nothing structural stops production code from importing them — the ban is a doc comment and their absence from `index.ts`, not a gate. Harmless while the package is source-only with a single `exports` entry, but the repo now has an unruled category of file. Real fix is cross-cutting: a naming convention for test-support modules plus a `no-restricted-imports` boundary (or a tsconfig `files` split), decided once for every package.
- Source: #77 C3 review
