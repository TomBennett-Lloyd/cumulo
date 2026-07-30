# 0003 — PV physics model runtime

- **Status:** accepted
- **Date:** 2026-07-30
- **Issue:** #4

## Context

Cumulo's forecast service turns a weather reading into a per-site AC power figure by doing physics. The physics itself is not in question — the question is what executes it. Python with [pvlib](https://pvlib-python.readthedocs.io/) is the default answer in this industry: peer-reviewed, community-maintained, validated against reference implementations, and the library a PV engineer would reach for without thinking. Everything else in this repo is TypeScript. That mismatch is the whole decision.

**A Python runtime is a second toolchain, not a second file.** The repo is a pnpm/TypeScript monorepo with one lockfile, one linter, one type-checker, one test runner, and a CI job that runs `pnpm lint`, `pnpm typecheck`, `pnpm format:check`, and `pnpm test`. Adding Python adds a dependency manifest and lockfile, a formatter and linter, a test runner, a packaging path, and a version pin for the interpreter — each of which is a thing that breaks independently and a thing a reader has to learn before they can run the project. It also changes what "the checks pass" means: `pnpm test` would no longer be the whole gate. Packaging is the sharper end of it. pvlib depends on numpy and pandas, which together run to well over a hundred megabytes unzipped before pvlib's own code; Lambda's zip deployment limit is 250 MB unzipped including layers. A carefully trimmed layer fits, but the margin is thin, keeping it thin is a permanent chore, and the next dependency that gets pulled in — scipy, for coefficient interpolation or a decomposition model — is the one that tips the artefact into a container image, which means an ECR repository, an image build in CI, and image-pull cold starts.

**Cold start is the typical path here, not the tail.** Forecast runs on data arriving from an hourly ingestion cycle (ADR 0001), with no sustained traffic to keep an execution environment warm. A function that imports pandas pays a startup cost measured in seconds; a bundled JavaScript artefact pays low hundreds of milliseconds. The honest version of this argument is not a cost argument: at tens of sites refreshed hourly, either runtime sits inside Lambda's always-free 1M requests and 400,000 GB-seconds, and neither threatens the ~$100/month ceiling. It is a responsiveness and surface-area argument — #17 promises a forecast appears within about a minute of a site being added, and seconds of interpreter startup on a path that is cold almost every time is a real bite out of that budget for no compensating benefit.

**Architecture rule 3 binds either way, so testability is not the discriminator.** The physics must be a pure function of typed inputs — no I/O, no clock reads, no environment access — and pvlib's functions satisfy that as readily as hand-written TypeScript ones would. What differs is not whether the core is pure but where its tests live and who can call it. #16 replays the physics over historical weather to produce error metrics: a season of hindcast for a few dozen sites is on the order of tens of thousands of evaluations. In TypeScript that is an in-process function call over the same typed inputs the production path uses. Across a language boundary it is either a second copy of the model in the harness's language or tens of thousands of serialised round trips — and the first of those is a correctness problem dressed as a performance one.

**The type boundary is where a second runtime costs the most.** Architecture rule 2 puts exactly one zod schema per domain concept in `@cumulo/shared`, and #10 is explicitly responsible for making units, time semantics, and weather-data provenance unambiguous on every field. A Python runtime necessarily expresses the weather-reading and forecast shapes a second time — as pydantic models, or as dictionary-key handling, which is the same thing with less honesty — and nothing checks the two expressions against each other at build time. The failure mode is not a type error, it is a units change or a field rename that type-checks clean in TypeScript, deploys, and produces confidently wrong numbers on the other side of the wire. Generating Python models from the zod schemas is a genuine mitigation, and it converts one authority into one authority plus a generator that lives on the deploy path and must itself be kept honest.

**The subset we actually need is small, and it is small for a specific reason.** Open-Meteo exposes `direct_radiation`, `diffuse_radiation`, and `direct_normal_irradiance` alongside `shortwave_radiation` (GHI), so the components arrive already separated. Irradiance decomposition — the Erbs/DISC/DIRINT family, which is one of the fiddlier parts of pvlib — is therefore a fallback for a GHI-only input, not a required step. The `siteSchema` in `@cumulo/shared` carries a single fixed `tiltDegrees` and `azimuthDegrees`, so tracker geometry, another error-prone area, is not in scope at all. What remains:

1. **Solar position** — apparent solar zenith and azimuth from latitude, longitude, and a UTC instant. The NREL SPA algorithm is accurate to ±0.0003°; simpler closed-form algorithms reach ~0.01°, which is orders of magnitude below the error the weather input contributes. Intricate but fully specified and closed-form.
2. **Plane-of-array transposition** — angle of incidence from solar position and array geometry; beam, sky-diffuse, and ground-reflected components summed into POA irradiance. The choice within this step matters: an anisotropic Hay-Davies model with a horizon-brightening term is closed-form and self-contained, whereas Perez requires transcribing published coefficient tables and getting the bin interpolation right — more surface to get wrong for a difference well below the weather's error floor.
3. **Cell temperature and efficiency derate** — module temperature from POA irradiance, ambient temperature, and wind speed (the Faiman form uses exactly the variables Open-Meteo provides), then a power temperature coefficient of roughly −0.4 %/K for crystalline silicon. Note that Open-Meteo's wind is at 10 m and the model wants module height, so a height adjustment is a modelling choice that has to be pinned rather than assumed.
4. **DC to AC** — an inverter efficiency and clipping at site capacity. `capacityKw` is nameplate DC, so the DC/AC ratio and the clipping convention need stating; #12 already requires the unit convention to be explicit and clipping to be either implemented or documented as out of scope.
5. **Irradiance decomposition** — Erbs or DISC, required only if #10's weather reading turns out to be GHI-only.

Deliberately outside the subset, and therefore not being ported: single-diode module models, spectral and incidence-angle-modifier corrections, soiling, bifacial gain, tracking, and horizon shading.

**Four tickets depend on the answer.** #12 implements the physics in whatever this decides and is told not to re-litigate it. #16 calls it at volume. #18 publishes real-world accuracy metrics, which stakes public correctness claims on this code. #20 faces the same runtime question for an ML correction layer, and would be materially influenced by a Python toehold existing already. ADR 0001 left the runtime contained inside a single deployable and named "a runtime that cannot be packaged alongside the rest of forecast" as a trigger to revisit its boundaries — a Python forecast Lambda would not trip that trigger, since forecast is its own deployable. The cost of Python here is toolchain surface, not a boundary violation, and this ADR should not overstate it.

Finally, this is a portfolio repo whose reasoning is read by humans, and that cuts in a specific direction. Rewriting numerical code that a mature library already implements is exactly the decision a reviewer will interrogate. It is defensible only if the correctness argument is stronger than "we wrote tests" — and if it is, the reasoning becomes an asset rather than something to explain away.

## Decision

**The PV physics runs in TypeScript. That is the only production runtime for the physics, and there is no Python in production or in CI.** The forecast service ships as a bundled JavaScript artefact in a plain zip; the physics subset stated above is ported by hand into domain-named modules inside it, as pure functions of types inferred from the `@cumulo/shared` zod schemas, per architecture rules 2, 3, and 5.

**pvlib remains the correctness authority, used offline.** A developer-run Python script generates **golden reference fixtures** — typed inputs paired with pvlib's expected outputs — which are committed to the repo. The TypeScript implementation must reproduce them within the tolerances below. pvlib is never installed in CI, never on the deploy path, and never at runtime; the fixtures are the artefact that crosses the language boundary, and they cross as committed data.

This substitutes inherited validation for inherited code. The distinction that makes it work is that the reference values are produced by an implementation nobody here wrote, so a fixture mismatch is evidence about our port rather than a restatement of our own assumptions.

### The fixture contract

This is the part #12 implements, and it is specified here because the strength of the decision rests entirely on it.

**Shape.** Fixtures are committed JSON, validated on load by a zod schema so they are typed data rather than `any` (testing rule 5). Each case carries an `id`, the site geometry it uses (`latitude`, `longitude`, `tiltDegrees`, `azimuthDegrees`, `capacityKw`), a UTC ISO 8601 `timestamp`, the weather inputs with their units (GHI/DNI/DHI in W·m⁻², ambient temperature in °C, wind speed in m·s⁻¹, and the albedo assumed), the module and derate parameters used, and an `expected` block.

**`expected` records every intermediate, not just the final power**: solar zenith and azimuth (degrees), angle of incidence (degrees), the POA beam, sky-diffuse, ground-reflected, and total components (W·m⁻²), cell temperature (°C), DC power and AC power (kW). A fixture that asserts only AC power lets two compensating errors through and, when it does fail, says nothing about where.

**Provenance is recorded per fixture file**: the pvlib version, the numpy and pandas versions, the generating script's git commit, the exact pvlib functions and model options used for each step, and the generation timestamp. Without this, a mismatch after an upgrade is a mystery instead of a diagnosis.

**Generator and port must use the same named model.** The tolerances below only mean something if the reference and the implementation are the same physics — a Hay-Davies port compared against Perez reference values measures the difference between two valid models, not the fidelity of the port. #12 pins one variant per step, records it in fixture provenance, and implements that one.

**Tolerances, per quantity class.** Stated as absolute-or-relative, whichever is looser, so values near zero are not held to impossible relative precision and midday values are not held to absurd absolute precision:

- **Solar position** (zenith, azimuth) and **angle of incidence**: 0.01° absolute.
- **POA irradiance components and total**: 0.5 W·m⁻² absolute or 0.1% relative.
- **Cell temperature**: 0.1 °C absolute.
- **DC and AC power**: 0.1% relative with a 1 W absolute floor.
- **Zero cases** (sun below horizon, polar night): **exactly zero** — not a tolerance. Zero is a correctness property, and a small negative or a `NaN` is a bug that a tolerance would hide.

These are far tighter than the physical accuracy of the forecast, where Open-Meteo's irradiance error under cloud is a percent-level-to-tens-of-percent affair. That is deliberate: **fixtures test implementation fidelity to the reference, not physical accuracy.** Physical accuracy is what #16 and #18 measure. Conflating the two is how a project ends up with a "validated" model that is validated against nothing.

**Tolerances may not be widened to make a failing test pass.** If a value cannot be hit, either the algorithm is aligned with the reference or the divergence is recorded explicitly, with its reason, in the test file. A quietly loosened constant is the specific failure this contract exists to prevent, and it is a review-blocking change.

**Regeneration.** The generator lives under `tools/`, outside `apps/` and `packages/` so it is in no deployable's build graph and excluded from `pnpm lint` and `pnpm typecheck`. It pins pvlib, numpy, and pandas to exact versions, documents how to run it, and emits deterministic output — stable key ordering and fixed float formatting — so that regenerating produces a reviewable diff rather than noise. Regeneration is a deliberate, reviewed act performed by a human, never a CI step.

**Coverage.** The set is a grid sample across latitude, season, hour, and array geometry — on the order of a few hundred cases, enough to cover the everyday domain while staying fast and reviewable — **plus these edge cases, which are required, not suggested**:

- **Polar-ish latitude** (around 68–70°N): low sun elevations and long shallow sun paths, where transposition errors are largest.
- **Midnight sun**: a polar-summer instant where the sun is above the horizon at local midnight. This also proves the model keys off geometry rather than the clock — a clock read would violate architecture rule 3 anyway, and this is the case that catches it.
- **Polar winter night**: a whole day where the sun never rises; expected exactly zero throughout.
- **Ordinary night**: sun below the horizon at a mid-latitude site; exactly zero, and specifically no negative POA.
- **Sun behind the panel**: angle of incidence above 90°, where the beam contribution must be exactly zero while sky-diffuse and ground-reflected stay positive. An uncleaned `cos(AOI)` producing a negative or spuriously large beam term is the canonical transposition bug.
- **Sunrise and sunset boundary hours**: solar zenith within a degree of 90°, where `cos(zenith)` approaches zero and naive division blows up.
- **Geometric extremes the schema permits**: `tiltDegrees` of 0 (horizontal) and 90 (vertical), the latter both south- and north-facing.
- **Southern hemisphere with a north-facing azimuth**, so the "degrees clockwise from true north" convention is exercised in both hemispheres rather than only the one it was written in.
- **Near-overhead sun at the equator around an equinox**, where solar azimuth changes fast and can flip.
- **A clipping case** where DC output exceeds `capacityKw`, pinning the clipping convention.
- **High albedo (snow)**, because ground reflection is the term most often dropped silently and never noticed.
- **A DST transition at a site whose local offset shifts**, expressed in UTC — the physics is a function of the instant alone, and testing rule 2 names clock boundaries for exactly this reason.

This decision governs the physics runtime and nothing else. It does **not** decide #20's ML runtime, and it does not touch the storage split owned by #3.

## Options considered

### A. Python Lambda running pvlib directly

The case for it is strong and worth stating at full strength. pvlib is peer-reviewed, actively maintained, and validated against reference implementations, and the algorithms in question — SPA, Perez bins, angle-of-incidence edge handling, decomposition — are genuinely subtle, the kind where a plausible-looking implementation is wrong by several percent in a way nobody notices. Porting effort would be zero, and so would the permanent cost of owning ported numerics: upstream bug fixes and new models arrive with a version bump. It is the natural home for #20's ML correction layer, so choosing it here would pre-pay that ticket's runtime cost rather than deferring it. And Python is the lingua franca of PV modelling, which a reviewer from this industry would recognise immediately as the unsurprising choice.

Genuine downsides:

- **A second toolchain in CI and locally**, with its own lockfile, linter, formatter, test runner, and interpreter pin. `pnpm lint && pnpm typecheck && pnpm test` stops being the whole gate, and every contributor pays the setup cost.
- **Packaging pressure.** numpy plus pandas sits uncomfortably close to Lambda's 250 MB unzipped ceiling before pvlib is added; keeping a trimmed layer under it is an ongoing chore, and one more dependency forces a container image, an ECR repository, and an image build step.
- **Cold start becomes the normal case.** Interpreter plus pandas import costs seconds on a path that is almost always cold, against #17's one-minute promise. It costs almost nothing in dollars, which is precisely why this argument must be made on responsiveness and not smuggled in as a cost claim.
- **An un-policeable type boundary.** The weather-reading and forecast shapes get expressed twice with no build-time check between them, or once plus a generator on the deploy path. Either way `@cumulo/shared` stops being the single authority in practice while remaining it on paper.
- **The pure-core story fragments.** Two test suites in two languages, and #16's hindcast harness must either cross a process boundary tens of thousands of times or keep its own copy of the model.

Rejected, but not because it is wrong — it is the defensible answer, and the trade being refused is one permanent toolchain and its type-drift risk in exchange for zero porting risk.

### B. TypeScript port validated only by its own tests

The cheapest option, and its upside is real: one toolchain, no Python anywhere at any point, no fixture machinery, no regeneration obligation, and #12 unblocked immediately.

Genuine downsides:

- **The correctness risk is at its most naked.** Tests for a transposition model written by the same person who wrote the model, from the same understanding, encode whatever the implementation does; they prove it is self-consistent, not that it is right.
- **The failure mode is silent and downstream.** It is not a crash — it is a POA that is 8% low all summer, which looks like a modelling choice rather than a bug. #16 would absorb it as model error, #20 would train a correction layer on top of it, and #18 would publish it as a real-world result.
- **Hand-picked reference values do not close the gap.** A few values from a paper or a textbook table are a partial mitigation — #12's acceptance criteria already require cited external reference values — but a handful of points is not a domain, and they do not constrain the intermediate steps a refactor might break.

Rejected: for a repo whose deliverable includes published accuracy metrics, correctness resting on the author's own assertion is worthless in exactly the place it matters most.

### C. TypeScript port validated against pvlib-generated golden fixtures — chosen

One toolchain in production and CI, correctness inherited from pvlib through committed reference values, `@cumulo/shared` as the literal and only type boundary, in-process calls for #16, and a plain-zip artefact with a fast cold start.

Genuine downsides, including the ones that do not go away:

- **We own the ported numerics permanently.** A pvlib bug fix or a new model does not arrive with a version bump; a bug in our transposition is ours to find and ours to fix, forever.
- **Fixtures pin a sampled input space, not a proof.** Wherever the sample is thin, the port is unvalidated. This is why the edge-case list above is prescriptive rather than an encouragement to add some.
- **Fixtures are frozen numbers.** When pvlib changes a model or fixes a bug, our fixtures keep the old answer and nothing in CI notices. Regeneration is a manual act that has to be remembered, and reviewing a diff of several hundred changed floats is not a pleasant or reliable read — recording intermediates and formatting deterministically makes it tractable, not easy.
- **The Python dependency is relocated, not eliminated.** Anyone regenerating fixtures needs a working pvlib environment, and that environment rots between uses. "No Python" is a claim about production and CI, not about the repo.
- **Porting effort is nonzero and sits on #12's critical path**, for exactly the class of algorithm where a subtle error is expensive.
- **Tolerance discipline is a human commitment, not a mechanism.** Nothing in CI prevents a future contributor from widening a tolerance to get green. This ADR names that as a review-blocking failure, which is weaker than making it impossible.

## Consequences

**Easier.** CI keeps one toolchain: one lockfile, one setup step, and `pnpm lint`/`pnpm typecheck`/`pnpm format:check`/`pnpm test` as the entire gate. The forecast Lambda is a bundled JavaScript zip with a cold start in the low hundreds of milliseconds — no ECR repository, no image build, no container pull — comfortably inside the always-free Lambda tier at hourly refresh for tens of sites, so the ~$100/month ceiling is untouched by this decision. #16 calls the physics as an in-process function over the same typed inputs production uses, which is what makes replaying tens of thousands of site-hours cheap and what guarantees the hindcast measures the deployed model rather than a sibling of it. #12's tests are Vitest files next to the source they test (testing rule 6), with no cross-language plumbing.

**Given up.** pvlib's accumulated domain knowledge now arrives only when we deliberately go and fetch it. We inherit its numbers, not its maintenance — and not its future. We also give up the option of writing the ML layer in the same language and process as the physics without introducing a second runtime.

**The correctness argument is a chain of four independent links, and each catches a different class of error.** Golden fixtures catch porting arithmetic — did we implement the model we meant to implement. #12's externally cited reference values catch a wrong model _configuration_, which fixtures generated from our own script cannot, since a mistaken model choice in the generator would be faithfully reproduced by a faithful port. #16's MAE/RMSE/skill score against our own fleet catches physical bias. #18's open-dataset validation catches it against real installations. The diagnostic value of the chain is the point: if #18's numbers come out poor, the fixture layer tells us immediately whether to look at the port or at the physics, and that is the distinction you want settled _before_ publishing metrics rather than after someone questions them. It also makes #18 a genuinely independent check — fixtures assert we compute what pvlib computes, #18 asserts that what pvlib computes matches reality for real rooftops. Two claims, two pieces of evidence.

**Shared-schema drift is eliminated by construction rather than managed.** There is one expression of the weather-reading and forecast shapes — the zod schemas in `@cumulo/shared` — and the physics consumes their inferred types directly, checked by `tsc` like any other TypeScript. No generator, no pydantic mirror, no second wire format. The fixtures are the single place numbers cross a language boundary, and they cross as committed data validated by a zod schema on load, so a units or field-name change from #10 breaks the fixture parse loudly instead of producing wrong numbers quietly.

**#20 is unbound, and deliberately unsubsidised.** This ADR decides the physics runtime and nothing more. #20 may well want Python for training, and that is entirely compatible with what is decided here: training is an occasional offline job producing a stored artefact — the same offline shape as the fixture generator, which this ADR already tolerates. What is deliberately avoided is creating a Python toehold in production or CI, so that #20 must argue its _inference_ runtime on its own merits and cannot lean on "we already have Python in the deploy path". If #20 concludes that inference must run in Python inside the forecast service, that is a superseding ADR, argued there.

**A standing obligation is accepted.** Someone must regenerate fixtures when pvlib moves, review a large float diff when they do, and keep a Python environment working for a task performed rarely. Ownership sits with whoever changes the physics; #12 lands the script and its documentation so the obligation is discoverable rather than folklore. pvlib is BSD-3-licensed, and a credit in the README data-sources section lands with #12, when it is first actually used.

**What would make us revisit.** ADRs are immutable: any change supersedes this one with a new ADR and never edits it. Concrete triggers:

- **The physics outgrows the stated subset** in a way the port makes expensive — single-diode module models, spectral or incidence-angle-modifier corrections, soiling, bifacial, tracking, or horizon shading. Each of those is a fresh porting bill, and enough of them together is the argument for running pvlib directly.
- **Fixture drift we cannot explain**: a pvlib release changes a model we depend on, or regeneration produces diffs whose cause we cannot account for. Fixtures we no longer trust are worse than no fixtures, because they look like validation.
- **The stated tolerances prove unachievable** for a genuine algorithmic reason. That is a superseding-ADR conversation about the validation strategy, never a quietly widened constant in a test file.
- **#10 lands a GHI-only weather reading**, pulling decomposition into the required subset and enlarging the port. This does not by itself flip the decision, but the "small subset" claim rests on it, so the claim would need restating.
- **#20 concluding that ML inference must be Python inside the forecast service.** A second runtime would then exist regardless of this decision, and every arithmetic above changes — at which point running pvlib directly costs much less than it does today.
