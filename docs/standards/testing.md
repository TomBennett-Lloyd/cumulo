# Testing standards

**Trigger:** writing or modifying tests; finishing a change and deciding what to test; fixing a bug.

## Rules

1. **Test behaviour through public surfaces.** Call the module's exported API; assert on outcomes, not internals. A test that breaks under a refactor that preserves behaviour is a bad test.

2. **The pure core gets dense, cheap tests.** Physics, aggregation, and error metrics (see `architecture.md` rule 3) are pure — test them exhaustively with plain inputs/outputs, including domain edge cases: polar-ish latitudes, midnight sun hours, zero-capacity sites, empty fleets, single-site fleets, clock boundaries (DST, UTC offsets).

3. **Adapters get thin integration tests; don't unit-test mocks.** A test that mocks the AWS SDK and asserts the mock was called proves nothing. Test adapters against contracts (recorded/fixture responses — e.g. real Open-Meteo response shapes as fixtures) and keep the logic they wrap in the pure core.

4. **Every bug fix lands with a regression test** that fails on the pre-fix code. No exceptions — this is the cheapest ratchet we have.

5. **Tests are code — standards apply.** Typed (no `any` in fixtures), named for the behaviour they prove (`aggregates overlapping forecast windows by summing overlap only`), no copy-paste walls; use builders/factories for fixtures. No snapshot tests for logic (acceptable for genuinely visual output only).

6. **Vitest, colocated.** `*.test.ts` next to the source it tests. `pnpm test` runs everything; a chunk isn't DONE until its tests pass.

7. **If a test turns a guard off to reach its target, another test must run the production default.** Neutering a knob — env var, feature flag, injected clock, retry limit, rate limiter — is often the only way to make a path reachable. But when _every_ test on a path disables the same knob, the suite proves that path works in a configuration nobody runs, and the default is untested. #42 shipped a reaper that could never reap at its default 60-minute setting: every reaping test forced the guard to `0`, and the one test that left it on asserted only the refusal it always makes. Mutation testing did not catch it — mutation coverage proves your assertions bite, not that you asserted the right thing in the configuration that ships.

8. **A mutant is transient — revert it, never repair it.** Mutation testing (breaking production code on purpose to prove a test bites) dirties the tree deliberately. The whole loop is: apply the mutant, run the one test file, put the source back by targeted edit — the inverse of the edit you made. Do not revert with `git restore` or `git checkout <path>`: they discard every uncommitted change in that file, not only the mutant, and on #91 that swallowed work in progress alongside it. If the inverse edit is awkward, copy the file aside first and restore from the copy. The PostToolUse lint hook will often flag the mutant — an unused binding, a now-unreachable branch — but the edit has already landed on disk, so that red is noise, not a blocker. Do not edit the mutant to satisfy it, add a suppression, or disable the hook for the run. A mutant must never survive into a commit, and a mutation run is never a reason to turn a check off.

9. **Forwarding an optional option with `?? <default>` destroys the coverage of the default it restates.** Under `exactOptionalPropertyTypes`, `{ opt: props.opt ?? true }` is the tempting way to pass an optional flag down — and it converts every default-arm test in the suite into an explicit-value test, so the callee's own parameter default is never exercised. Branch on `undefined` and call the shorter overload instead. The failure is invisible to ordinary review and to coverage: prove a parameter default with a mutant on the signature default itself, which on #178 survived 9 of 9 tests until the forwarding helper was fixed.

10. **The jsdom/browser line — decide which lane a criterion belongs to before you write it.** jsdom suites prove component logic through public surfaces and seams; a stand-in component at the WebGL line is a seam, not a mock (`apps/web`'s `mapRegion` prop is the motivating one), so rule 3 does not bar it. What jsdom cannot host is not a coverage gap to argue about — it is the other lane's work: anything needing layout, paint, computed style, WebGL, a worker boot, or a real input modality. Canvas sizing, clipped chart labels, focus-ring visibility, keyboard activation. That lane is Playwright specs in `apps/web/e2e/`, run against the **built** app (`vite build`, served by `vite preview`) on the demo data source, as the blocking `web-e2e` CI job — deliberately outside `verify`, for reasons owned by that job's own comment in `.github/workflows/ci.yml`; point at it rather than restating them (`architecture.md` rule 9). Naming split: `*.test.ts` colocated is vitest (rule 6), `e2e/*.spec.ts` is the browser lane. Neither is the other's fallback — a jsdom test reaching for a browser criterion asserts something it cannot see, and a lane spec re-proving logic jsdom already covers is a slow copy of a fast test.

## Why

Visible, meaningful coverage is an explicit portfolio goal — but reviewers at this level can tell coverage theatre from real tests. Five sharp edge-case tests on the aggregation math say more than fifty mock-assertion tests, and the pure-core architecture makes the sharp ones cheap.
