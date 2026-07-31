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

## 2026-07-31 — `is_clean` asks the worktree directory which repo it belongs to

- Where: `.claude/scripts/worktree-lib.sh` (`is_clean`), called from `reap-worktree.sh` and `rebranch-worktree.sh`
- What: `is_clean` runs `git -C "$wt" status`, which discovers the repository by walking up from that directory. Cumulo nests worktrees inside the main checkout, so a worktree whose `.git` file is missing answers with the **main checkout** — `is_clean` then reports the main checkout's status while reap believes it is describing the target. Same root cause and same fix direction as the min-age probe, which #83 moved onto the admin dir the main repo records for the worktree; `is_clean` was left alone because it takes a path, not an admin dir, and threading one in as an optional second argument is the mode-flag shape `structure.md` rule 7 warns about. Fail-safe today: reaching a destructive action still requires `git worktree remove`, which refuses to validate a worktree with no `.git` file, so reap exits 2 with nothing deleted. Wants one decision covering both callers — hand `is_clean` an explicit repo (`--git-dir` plus `--work-tree`), or have reap refuse a worktree whose `.git` link does not resolve to its recorded admin dir before any probe runs at all.
- Source: #83

## 2026-07-30 — Nothing resolves a stale worktree admin entry

- Where: `.claude/scripts/sweep-worktrees.sh`:106; `.claude/skills/execute/SKILL.md` step 1
- What: dropping the unconditional prune was correct (it destroyed recoverable admin data under `--dry-run`), but now nothing in the workflow clears a genuinely dead entry. Consequence, verified: `git worktree add` at that path fails with `fatal: … is a missing but already registered worktree`. Since the execute skill uses deterministic paths (`.claude/worktrees/<n>-<slug>`), a killed session whose directory was deleted by hand blocks re-execution of that same issue until a human prunes. Sweep detects it and re-counts it `kept` on every future run, so the warning repeats indefinitely. Git's own error names the remedy, so this is friction rather than a bug — wants a line in the skill docs or an explicit opt-in flag, not a behaviour change.
- Source: #42

## 2026-07-31 — `createPhysicsForecast` throws on boundary-accepted inputs, with no caller policy

- Where: `packages/forecast/src/physics-forecast.ts` (`createPhysicsForecast`'s final `forecastSchema.parse`), `packages/forecast/src/irradiance.ts` (`MINIMUM_COS_ZENITH_FOR_PROJECTION_RATIO`)
- What: the final parse is an uncaught throw, justified as a bug guard — but its bounds are reachable from inputs `siteSchema` and `weatherReadingSchema` both accept, so the throw is not exclusively a programmer-error signal. Route: Hay-Davies floors cos(zenith) at 0.01745 (pvlib GH 432), capping `Rb` near 57.3; the circumsolar term is DHI · A · Rb, so with the anisotropy index A = 1.089 at the measured point the amplification is 62.4x. Measured on a schema-valid Dublin site (tilt 90, azimuth 89.47) at 2026-03-20T07:00:00Z with every irradiance field at its 1500 W/m² cap: POA 95 241 W/m², cell 3870 °C, DC −5478 kW, AC −5259 kW — three separate `forecastSchema` bounds violated. Root cause is not the guard (fail-fast is right) but the missing decision one layer up: error-handling rule 1 splits expected failures (values) from bugs (exceptions), and an implausible-but-accepted weather hour is the former wearing the latter's clothes. #13's forecast Lambda and #16's hindcast need one policy between them — abort the cycle on a ZodError, or have the forecast package return a typed expected failure for out-of-range results so a single bad upstream hour cannot take down a fleet-wide run. Decision input for those tickets, not a change to this diff.
- Source: #12 review cycle 1

## 2026-07-30 — Lifecycle tooling has an undeclared python3 dependency

- Where: `.claude/scripts/worktree-lib.sh` (`canon`, which resolves realpaths; `is_merged`, which parses the `gh pr list --json headRefOid` payload), plus the `worktree list --porcelain` parsing in `reap-worktree.sh` and `sweep-worktrees.sh`
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
- What: cycle 2 closed the colour half of the gate (colour-bearing shorthands now demand tokens), but the length half is still allow-list-shaped and the list names only spacing-ish properties. A raw size therefore reaches the page through any property it omits — `width`, `height`, `max-width`, `inset`, `flex-basis`, `border-width`, `letter-spacing`, `stroke-width`, `grid-template-columns`. This is not hypothetical: committed CSS already depends on it (`max-width: 44rem` in preview.css), so the gate as shipped says "no arbitrary sizes" while the repo contains arbitrary sizes. Colour had a property-agnostic backstop available (hex and colour-function literals are recognisable by pattern anywhere); lengths have none, because a length is legal syntax in every property. So the only fix is extending the allow-list, and that cannot be done as a config tweak: the token set has spacing, type-scale and radii, but no measure (`--measure-prose`) or layout-size category, so adding `max-width` today would fail the very stylesheet it guards with no token to point at. Root cause is a missing token category, not a missing rule — a design-system scope ticket that adds the categories and closes the list in one move. The same hole has an inverse face, found in #19: a spacing token divided down through `calc` to stand in for a border width (`calc(var(--space-1) / 4)`) reads as token-compliant and passes the gate on properties the list _does_ cover, while expressing a value the token set has no name for — so the gate cannot distinguish "uses a token" from "uses a token that means something else", and the border silently retunes if the spacing scale ever moves. `preview.css` is the copy-source (`.swatch-chip`, `.chart-table thead th`, `.map-marker`), which is how it spread to `charts.css` before #19 review cycle 1 removed it there. The border-width token category the fix needs is the same missing category as the lengths above, so both faces close together.
- Source: #15 review cycle 2; inverse face #19 review cycle 1

## 2026-07-31 — Neither lint gate has a committed regression test

- Where: `stylelint.config.mjs`, `eslint.config.mjs`, `package.json` (`verify`)
- What: both review cycles found real holes in these gates (cycle 1: property-agnostic colours; cycle 2: colour-bearing shorthands, and `lab()`/`lch()` missing from the ESLint regex), and both were found by ad-hoc probing — scratch stylesheets and scratch `.tsx` files, run by hand, deleted afterwards. Nothing in the repo now proves any of it. The gates are exactly the kind of config where a silent regression is invisible: a mistyped property name, a dropped array entry, or an `overrides` block widening its `files` glob all leave `pnpm verify` green, because a gate that stops firing produces _no_ output. #94 put the react-hooks block in the same bracket — its `files` glob went from `**/*.tsx` to `**/*.{ts,tsx}` on the strength of a hand-run probe that was deleted afterwards, so narrowing it back would silently unlint every hook in a `.ts` file again, and the ratchet below has to cover the hooks rules alongside the colour-literal selectors. testing.md rule 4 ("every bug fix lands with a regression test that fails on the pre-fix code") applies to config fixes as much as to source, and it has now been skipped twice. The ratchet is a fixture pair run under vitest — a should-fail stylesheet asserting a specific error count, a should-pass clean stylesheet, and a tokens-exemption control proving the one legitimate escape still works — plus the equivalent for the ESLint colour-literal selectors. Cross-cutting (it needs a test harness that shells out to the linters and a home for the fixtures), so it is a ticket rather than an addendum to this diff.
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

## 2026-07-31 — "Discover or die" is asserted in two gates and enforced in neither

- Where: `.claude/scripts/lint-shell.sh` (the `git ls-files --cached --others --exclude-standard -z` read loop feeding `shell_files`, and its empty-list guard); `.claude/scripts/run-script-tests.sh` (the `find` discovery, which now writes to a temp file and checks the status)
- What: both gates rest on discovering their own inputs, and both wrote the producer inside a process substitution — where a non-zero exit is invisible to the parent shell, `pipefail` included. The failure that matters is not the producer dying but the producer **partly succeeding**: `find` that cannot descend into one subdirectory, and `git ls-files` in a repository state it cannot fully read, both print to stderr, exit non-zero, and still emit everything they reached. The gate then runs a subset and reports it as the whole, which is worse than reporting nothing — reproduced against the runner in #84 review cycle 1, where a red harness behind an unreadable directory came back "1 harness(es), 0 failed" at exit 0. `run-script-tests.sh` now refuses a partial listing; `lint-shell.sh` has the same shape and still does not, so `pnpm lint:sh` can silently check fewer files than the repo contains. The empty-list guard both gates already have is the same idea stopped one step short: it catches "found nothing", never "found some of it". Fix is one shared idiom for discovery-with-status rather than a second one-off patch — two instances today and a third likely, so it wants extracting into a sourced helper with its own cases, alongside the equivalent guard for the `check-module-names` and `check-adr-index` searches.
- Source: #84 review cycle 1

## 2026-07-31 — Supersession is now stated in two places the gate never cross-validates

- Where: `.claude/scripts/check-adr-index.sh` (`check_supersessions`, `adr_status_value`), `docs/adr/README.md` (index annotation grammar)
- What: #85 validates an index row's `— superseded by NNNN` annotation and an ADR file's `Status:` line each in isolation, so the gate sanctions exactly the disagreement it exists to prevent: an index row can say superseded while the file still says `accepted`, and vice versa, both exiting 0. Three adjacent soft spots share the scan-rather-than-parse root cause: the first `Status:` line in a header wins, so a second, conflicting `Status:` line (the plausible "added instead of replaced" edit) is never read; a self-referential `superseded by 0001` inside `0001-*.md` passes; and the number is regex-scraped from free text, so `superseded by 00021` resolves against `0002`. One fix shape: parse (status, pointer) per file and per row, then require agreement and sanity in one place.
- Source: #85 review cycle 1

## 2026-07-31 — ADR Status vocabulary is duplicated between the template and the gate

- Where: `docs/adr/0000-template.md` (the `Status:` menu line), `.claude/scripts/check-adr-index.sh` (the status `case`)
- What: the allowed vocabulary (`proposed | accepted | superseded by NNNN`) lives in the template's prose and again in the gate's `case`, with nothing binding them — adding a value to the template makes the gate reject conforming ADRs, and extending the gate leaves the template lying. Same restated-list drift class as the `README.md`/`.githooks/pre-commit` gate-list entry. Cheapest fix: the gate derives the vocabulary by reading the template's menu line (the template is already excluded from per-file checks, so reading it is safe), making the template the single source. Also: the two harness cases exercising the new `${hits[@]+…}` empty-array guard run only under the default `bash`, not the `$BASHES` loop the harness header commits to — on CI (bash ≥ 4.4) the 3.2 guard is unexercised; wrap one variant in the loop when next touching the harness.
- Source: #85 review cycle 1

## 2026-07-31 — Test-support modules live in the production source tree with dev-only imports

- Where: `packages/storage/src/adapters/*/​*-fixtures.ts`, `packages/storage/src/adapters/storage-error-capture.ts`, `packages/storage/src/recording-http-handler.ts`
- What: the #77 C3 test split moved shared test support out of `.test.ts` files into plain modules under `src/`, and they statically import dev-only packages (`vitest`'s `expect`, `aws-sdk-client-mock`). Nothing structural stops production code from importing them — the ban is a doc comment and their absence from `index.ts`, not a gate. Harmless while the package is source-only with a single `exports` entry, but the repo now has an unruled category of file. Real fix is cross-cutting: a naming convention for test-support modules plus a `no-restricted-imports` boundary (or a tsconfig `files` split), decided once for every package.
- Source: #77 C3 review

## 2026-07-31 — The ingestion Lambda's timeout is budgeted for fetching only, and for a fleet size nothing enforces

- Where: `infra/ingestion/lambda.tf` (the `timeout = 300` rationale on `aws_lambda_function.ingestion`); `apps/ingestion/src/cycle.ts` (`runCycle`'s sequential loop); `packages/storage/src/client.ts` (`STORAGE_MAX_ATTEMPTS`, `createStorageDocumentClient`); `apps/ingestion/src/publisher/sqs.ts` (`INGESTION_SEND_MAX_ATTEMPTS`, `INGESTION_SEND_REQUEST_TIMEOUT_MS`)
- What: the 300 s budget is argued as 12 locations × ~21 s of _fetching_ (one 10 s attempt plus one retry after up to 1 s of jitter), which silently prices a location's other two effects at zero. A location that succeeds also spends a DynamoDB `putForecastWeather` — a 4-attempt retry strategy with backoff and, unlike the SQS client, **no pinned per-request timeout**, so a stalled socket there is bounded by nothing this repo sets — and an SQS `publishLocationReadings` at up to 3 × 3 s plus backoff. At roughly 30 s for a pathologically slow but _successful_ location, the ceiling is about 10 locations, i.e. below the 12 the budget is written for: the cycle would be killed mid-loop, and a Lambda timeout is the one failure mode that produces no `CycleFailedError`, no summary log line, and no account of which locations published. Compounding it, the comment calls 12 "a property of the fleet rather than a coincidence" — true of the _canonical_ fleet after #78, but the deployed `cumulo-sites` table is what `listFleetSites` actually reads, and #17's visitor-added sites land at locations outside the 12 canonical buckets by design. The two halves want deciding together: a site-count/location-count policy (does ingestion cap locations per cycle, page them, or does #17 constrain where a visitor may add?) and a storage-client timeout posture to match the SQS one. Neither belongs in this branch's diff — the first is #17's contract, the second changes every consumer of `@cumulo/storage`.
- Source: #11 review cycle 1

## 2026-07-31 — Skill score compares two RMSEs computed over different sample sets

- Where: `runHindcast` and `baselineRmseKw` in `packages/hindcast/src/hindcast.ts`; `skillScore` and `errorMetricsSchema` in `packages/shared/src/metrics.ts`
- What: the model RMSE is taken over `replay ∩ in-period observations`, while the baseline RMSE is taken over `shifted observations ∩ in-period observations` — two inner joins with different left operands, so the two numbers routinely score different instants. The gap is not marginal: the `draws the first day of the period from observations made before it` case in `hindcast.test.ts` compares 48 model pairs against 48 baseline pairs in one arm and against 24 in the other, and the published `skillScore` moves accordingly. Standard forecast verification scores model and reference over an identical set of instants, precisely so the ratio means "how much better, on the same problem". Worse, the stored row records only the model's `sampleCount`, so nothing downstream can tell that the denominator came from a smaller sample — a skill score computed against half a window is indistinguishable from one computed against all of it. The honest fixes both cross the approved plan's spec: either restrict both series to the instants where model, baseline and observation all exist (changes the published numbers, and changes what a run with no run-up day reports), or keep the current arms and add a `baselineSampleCount` field so the asymmetry is at least visible. That is an `errorMetricsSchema` change, which is #20's comparison payload as well as this package's, so it wants deciding once for both rather than being settled inside a hindcast runner.
- Source: #16 review cycle 1

## 2026-07-31 — A metrics row cannot say which hours of its own period are missing

- Where: `errorMetricsSchema` in `packages/shared/src/metrics.ts`; the `complete` arm of `runHindcast` and `HindcastCoverage` in `packages/hindcast/src/hindcast.ts`; `report` in `packages/hindcast/scripts/run-hindcast.ts`
- What: a run whose archive coverage is `ready` but carries a non-empty `unavailableDays` publishes a perfectly ordinary-looking row. The holes are reported in the in-memory outcome and printed by the operator CLI, and then they are gone: `cumulo-metrics` stores `sampleCount` and nothing about the window's expected size, so a reader cannot distinguish "24 hours scored because the site only reported 24" from "24 hours scored because two of the three days were never in the archive". #20's comparison endpoint reads that row and nothing else, which is where the omission becomes user-visible — a partial evaluation rendered as a complete one contradicts `docs/standards/error-handling.md` rule 5 ("partial results are labeled partial, in the API response and the UI") at the one layer that survives the process. Fix is schema-level — an expected-sample count, a coverage fraction, or an explicit list of excluded days — and lands in the same `errorMetricsSchema` decision as the entry above, so the two should be taken together. The module comment in `hindcast.ts` has been corrected in the meantime: it previously implied that a partially covered window never produces numbers, which was never true of this arm.
- Source: #16 review cycle 1

## 2026-07-31 — The port-inversion invariant in `@cumulo/hindcast` is convention, not a gate

- Where: `ArchiveDayStore` in `packages/hindcast/src/archive-cache.ts` and `ArchiveReadingStore` in `packages/hindcast/src/hindcast.ts` (the declared ports and their doc comments); `packages/hindcast/scripts/run-hindcast.ts` (the only sanctioned importer of `@cumulo/storage`); `packages/hindcast/package.json`
- What: the package declares its own structural ports rather than importing `@cumulo/storage`'s types, so every test in it runs against a `Map` with no AWS SDK in the graph, and the real `WeatherAdapter` is compiled against those ports at exactly one wiring site. `@cumulo/storage` stays in `dependencies` rather than `devDependencies` — the CLI is a shipped operator entry point and a `--prod` install has to be able to run it — which means nothing stops a module under `src/` from importing it tomorrow. The invariant that keeps the design honest ("no module under `src/` imports `@cumulo/storage`") is stated in two doc comments and enforced by nobody; the first `src/` import would silently pull the SDK into the test graph and turn the ports into decoration. This is the same unruled-boundary class as the test-support-module entry above, and it wants the same kind of answer: an `eslint` `no-restricted-imports` boundary (or a tsconfig project split) applied per package, decided once. Cross-cutting — `apps/*` versus `packages/*` and the `packages/ui` token rule are other instances of "an import boundary we assert in prose".
- Source: #16 review cycle 1
