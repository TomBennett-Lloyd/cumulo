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

## Why

Visible, meaningful coverage is an explicit portfolio goal — but reviewers at this level can tell coverage theatre from real tests. Five sharp edge-case tests on the aggregation math say more than fifty mock-assertion tests, and the pure-core architecture makes the sharp ones cheap.
