import {
  DYNAMODB_BATCH_WRITE_SIZE,
  STORAGE_BATCH_PAGE_WORST_MS,
  STORAGE_MAX_ATTEMPTS,
  backoffCeilingMs,
  defaultBatchPolicy,
} from '@cumulo/storage';

import {
  FETCH_MAX_ATTEMPTS,
  defaultTimeoutMs,
  retryBaseDelayMs,
} from './open-meteo/fetch-forecast';
import { forecastHours } from './open-meteo/url';
import { INGESTION_SEND_MAX_ATTEMPTS, INGESTION_SEND_REQUEST_TIMEOUT_MS } from './publisher/sqs';

/**
 * What one ingestion cycle is allowed to spend, and why — as arithmetic the
 * compiler evaluates rather than a comment a reader has to trust.
 *
 * **The two bounds, and why there are two.** The deadline protects the
 * timeout; the cap protects the quota; neither substitutes for the other. They
 * are two resources, so they get two bounds, each derived from the limit that
 * actually binds it.
 *
 * **Why the obvious third option is absent.** The tempting design is a single
 * location cap sized so that `cap × worst case ≤ function timeout`. Sizing a
 * count to a scenario that is both catastrophic and simultaneous is the same
 * species of mistake #115 was filed about: a number justified against a model
 * of the system rather than against the system. So the worst case below is not
 * used to choose a fleet size. It is used to answer one narrow question — *how
 * much time must be left in reserve for a location already in flight?* — which
 * is exactly what {@link CYCLE_DEADLINE_MS} subtracts.
 *
 * **Three terms sat outside the arithmetic. Two are now bought; one cannot be,
 * and is named instead.** The identity below holds back
 * {@link UNPRICED_TERMS_SLACK_MS}, sized to cover terms 1 and 3 at the
 * magnitudes stated below. Term 2 is *unbounded*, so no finite slack covers
 * it — carrying it as a margin would dress an open gap up as a covered one, so
 * it is stated as the single condition the guarantee is conditional on:
 *
 * 1. The smithy standard retry strategy honours a server-supplied retry hint,
 *    which can extend any single retry by up to
 *    {@link RETRY_AFTER_HINT_SLACK_MS} beyond the computed delay (verified in
 *    the installed `@smithy/core` 3.31.1). **Bought at one full hint.** A
 *    location that drew a maximal hint on *every* one of its retries is still
 *    unpriced, and deliberately so: neither DynamoDB nor SQS sends `Retry-After`
 *    in normal operation, and pricing {@link WORST_COMMANDS_PER_LOCATION}
 *    simultaneous maximal hints would be sizing against the
 *    catastrophic-and-simultaneous model this module refuses to size a fleet
 *    against — the same #115 species of mistake.
 * 2. The pinned request timeouts bound the time to the **first response**, not
 *    the whole attempt: the timer is cleared when response headers arrive and
 *    the body is still streaming, and neither client sets `socketTimeout`
 *    (`packages/storage/src/client.ts` records the same gap from the other side
 *    of the call). A response whose body stalls after its headers is unbounded,
 *    and a finite number cannot cover an unbounded term. **Not bought — named.**
 *    So {@link CYCLE_DEADLINE_MS}'s guarantee reads in full: the function
 *    timeout is unreachable *unless a response body stalls mid-stream*. The
 *    per-request terms below are therefore bounds on time-to-first-response,
 *    and the gap stays recorded in `docs/tech-debt.md` rather than priced in.
 * 3. Real time spent per attempt *outside* the request timeout — connection
 *    setup, request signing, serialisation, and event-loop scheduling between a
 *    timer firing and the next attempt starting. **Bought at
 *    {@link PER_COMMAND_OVERHEAD_MS} × {@link WORST_COMMANDS_PER_LOCATION}**,
 *    a rounded ceiling over the range {@link PER_COMMAND_OVERHEAD_MS} cites,
 *    times every HTTP attempt one location can make.
 *
 * **Every other term is imported.** Nothing here restates a number that lives
 * somewhere else, because a copied constant is how the previous budget went
 * stale without anyone noticing (#165). That now includes the backoff *ceiling*
 * itself: `backoffCeilingMs` and the two storage worst cases come from
 * `@cumulo/storage`, the package whose curve they sum. Two exceptions are named
 * rather than imported, and both are the AWS SDK's own numbers rather than ours
 * to pin: {@link SDK_THROTTLING_RETRY_DELAY_BASE_MS} and
 * {@link SDK_MAXIMUM_RETRY_DELAY_MS}.
 */

/**
 * The AWS SDK's own throttling backoff base, in milliseconds, for clients that
 * do not replace the delay curve — which the SQS publisher deliberately does
 * not (see `publisher/sqs.ts`).
 *
 * One of the two numbers below that this repo does not set, restated here
 * because a budget cannot be honest about a term it omits. Verified against the
 * installed `@smithy/core` 3.31.1 (`THROTTLING_RETRY_DELAY_BASE = 500`); the
 * storage path needs no equivalent because `createStorageRetryStrategy` pins its
 * own curve.
 */
export const SDK_THROTTLING_RETRY_DELAY_BASE_MS = 500;

/**
 * The ceiling the AWS SDK's own delay curve flattens at, in milliseconds.
 *
 * The second number this repo does not set, restated for the same reason as
 * {@link SDK_THROTTLING_RETRY_DELAY_BASE_MS}: it is the `maxDelayMs` half of the
 * publish curve's spec, and `backoffCeilingMs` requires one rather than letting
 * a caller describe a curve without stating where it flattens. Verified against
 * the installed `@smithy/core` 3.31.1 (`MAXIMUM_RETRY_DELAY = 20 * 1000`).
 *
 * At {@link INGESTION_SEND_MAX_ATTEMPTS} attempts the curve never reaches it,
 * so it does not move {@link PUBLISH_WORST_MS} today — it is here so that
 * raising the attempt count computes the SDK's real curve instead of an
 * exponential that keeps doubling past the SDK's own cap.
 */
export const SDK_MAXIMUM_RETRY_DELAY_MS = 20_000;

/**
 * Worst case for one location's Open-Meteo fetch: every attempt hitting its
 * deadline, with the retry's full-jitter window spent in full.
 *
 * ≈ 21 s. The curve's base and its ceiling are the same number because
 * `fetchForecast` sleeps uniformly over `[0, retryBaseDelayMs)` with no
 * exponent — there is only ever one retry, so there is nothing to double.
 */
export const FETCH_WORST_MS =
  FETCH_MAX_ATTEMPTS * defaultTimeoutMs +
  backoffCeilingMs(FETCH_MAX_ATTEMPTS, {
    baseDelayMs: retryBaseDelayMs,
    maxDelayMs: retryBaseDelayMs,
  });

/** Round trips one location's horizon costs: 2 `BatchWriteItem` calls. */
export const STORE_BATCHES_PER_LOCATION = Math.ceil(forecastHours / DYNAMODB_BATCH_WRITE_SIZE);

/**
 * Worst case for storing one location's readings.
 *
 * ≈ 43 s, and still the dominant term — {@link STORE_BATCHES_PER_LOCATION}
 * batch pages at {@link STORAGE_BATCH_PAGE_WORST_MS} each. What a page costs is
 * storage's fact to state, not ours to re-derive.
 */
export const STORE_WORST_MS = STORE_BATCHES_PER_LOCATION * STORAGE_BATCH_PAGE_WORST_MS;

/**
 * Worst case for publishing one location to SQS.
 *
 * ≈ 10.5 s — the pinned per-attempt deadline on every attempt, plus the SDK's
 * own throttling backoff, which this client leaves to the standard strategy.
 */
export const PUBLISH_WORST_MS =
  INGESTION_SEND_MAX_ATTEMPTS * INGESTION_SEND_REQUEST_TIMEOUT_MS +
  backoffCeilingMs(INGESTION_SEND_MAX_ATTEMPTS, {
    baseDelayMs: SDK_THROTTLING_RETRY_DELAY_BASE_MS,
    maxDelayMs: SDK_MAXIMUM_RETRY_DELAY_MS,
  });

/**
 * All three of a location's effects at their bounded worst, ≈ 75 s.
 *
 * Read this as "the reserve a location in flight may need", not as "how long a
 * location takes" — a healthy one costs well under a second. It is the number
 * {@link CYCLE_DEADLINE_MS} holds back so that a location started just before
 * the deadline still finishes inside the function timeout.
 */
export const LOCATION_WORST_MS = FETCH_WORST_MS + STORE_WORST_MS + PUBLISH_WORST_MS;

/**
 * The most a single server-supplied retry hint can add to one retry's delay.
 *
 * The smithy standard strategy clamps a `Retry-After` hint to at most
 * `delayFromErrorType` plus this value — verified in the installed
 * `@smithy/core` 3.31.1, in `refreshRetryTokenForRetry`. It is the SDK's
 * number, so it moves when the SDK moves; one of them is what
 * {@link UNPRICED_TERMS_SLACK_MS} buys (header term 1).
 */
export const RETRY_AFTER_HINT_SLACK_MS = 5_000;

/**
 * Wall-clock time one HTTP attempt spends outside its request timeout —
 * connecting, signing, serialising, and waiting on the event loop.
 *
 * **Assumption**, and the only one in this module: a rounded ceiling over the
 * 15–70 ms per command measured in #122. No command re-measures it.
 */
export const PER_COMMAND_OVERHEAD_MS = 100;

/**
 * Every HTTP attempt one location can make, worst case: 17.
 *
 * It counts *attempts*, not effects, because {@link PER_COMMAND_OVERHEAD_MS} is
 * paid per attempt — the retried attempt connects and signs again exactly as
 * the first one did; `cycle-budget.test.ts` carries the breakdown.
 *
 * `listFleetSites` is not in it: that runs once per cycle before the loop, so
 * its time is already elapsed when the deadline is next checked rather than
 * being part of the reserve an in-flight location needs.
 */
const WORST_COMMANDS_PER_LOCATION =
  FETCH_MAX_ATTEMPTS +
  STORE_BATCHES_PER_LOCATION * defaultBatchPolicy.maxAttempts * STORAGE_MAX_ATTEMPTS +
  INGESTION_SEND_MAX_ATTEMPTS;

/**
 * What the identity holds back for the terms {@link LOCATION_WORST_MS} does not
 * price, ≈ 6.7 s.
 *
 * One full `Retry-After` hint plus per-attempt wall-clock overhead on every
 * attempt {@link WORST_COMMANDS_PER_LOCATION} counts — header terms 1 and 3, at
 * the magnitudes argued there. Term 2 is absent by construction: it is
 * unbounded, and a slack line for an unbounded term would be a number
 * pretending to be a bound.
 */
export const UNPRICED_TERMS_SLACK_MS =
  RETRY_AFTER_HINT_SLACK_MS + PER_COMMAND_OVERHEAD_MS * WORST_COMMANDS_PER_LOCATION;

/**
 * The function timeout in `infra/ingestion/lambda.tf`, mirrored.
 *
 * A mirror, not a source: Terraform owns the deployed value and its comment
 * cites this constant by name, as this one cites the file. The two are held
 * equal by `pnpm check:infra-mirrors` in the `verify` composite (#123;
 * `docs/standards/architecture.md` rule 8).
 */
export const INGESTION_LAMBDA_TIMEOUT_MS = 300_000;

/**
 * Time held back for the platform to stop the function cleanly — flushing the
 * summary log line that the whole reporting design rests on. A killed
 * invocation is precisely the failure #115 named as the one ingestion cannot
 * report on, and losing the report at the last moment would reintroduce it.
 */
export const SHUTDOWN_MARGIN_MS = 5_000;

/**
 * How long a cycle may keep *starting* locations, ≈ 214 s.
 *
 * The deadline is checked before each location and never interrupts one in
 * flight, so the guarantee is: `elapsed at last start ≤ deadline`, plus at most
 * {@link LOCATION_WORST_MS} for that location, plus
 * {@link UNPRICED_TERMS_SLACK_MS} for what that figure does not price, plus
 * {@link SHUTDOWN_MARGIN_MS} — which is {@link INGESTION_LAMBDA_TIMEOUT_MS} by
 * construction. That is what makes the function timeout **unreachable unless a
 * response body stalls mid-stream** (header term 2, the one term no finite
 * subtraction can cover) rather than merely unlikely.
 *
 * If it ever fires in production, the constants above are wrong at their
 * source — that is the intended way to find out.
 */
export const CYCLE_DEADLINE_MS =
  INGESTION_LAMBDA_TIMEOUT_MS - LOCATION_WORST_MS - UNPRICED_TERMS_SLACK_MS - SHUTDOWN_MARGIN_MS;

/**
 * Locations one cycle may fetch weather for.
 *
 * Derived from the Open-Meteo allowance in CLAUDE.md and not from time, which
 * {@link CYCLE_DEADLINE_MS} already owns; `cycle-budget.test.ts` asserts the
 * share of the daily allowance an hourly cadence spends, and the headroom left
 * for #16's archive backfill, for a re-run after a failed cycle, and for the
 * retry each location is allowed. The per-minute ceiling stays unreachable
 * because locations are fetched sequentially.
 *
 * It is comfortable headroom over every fleet size this repo has committed to
 * (`docs/design/fleet-simulation.md`'s canonical fleet and ADR 0002's "Assumed
 * scale"), and the gap above them is deliberate room for #17, which adds
 * visitor sites at arbitrary coordinates by design — that is
 * why ingestion enforces a bound of its own instead of inheriting one from a
 * property of the seed fleet.
 *
 * Reaching it is not an error, and the code says so rather than only the
 * comment: a capped location is reported as `skipped` with reason
 * `location-cap`, counted in the report's `deferred` — which is deliberately
 * **not** part of `failed` — and so it does not raise `CycleFailedError` or the
 * `ingestion_errors` alarm. A fleet legitimately larger than the cap would
 * otherwise page every hour forever.
 */
export const MAX_LOCATIONS_PER_CYCLE = 100;

/**
 * How large the fleet may grow before rotation can no longer keep coverage
 * continuous: a cap's worth of locations times the stored horizon, **4,800**.
 *
 * Rotation steps by a whole window each hour (`locations.ts`), and
 * `cycle-budget.test.ts` carries the relation that makes the bound what it is:
 * past it a location's stored horizon expires before its next visit, and the
 * gap becomes permanent rather than transient.
 *
 * Past the bound nothing says so. Deferral is correctly not a failure (see
 * {@link MAX_LOCATIONS_PER_CYCLE}), so a fleet over this size degrades
 * **unobservably** — #164 owns the alarm shape for an absence like that. And the
 * bound is a consequence of the rotation `locations.ts` implements, not a
 * decision about how large the fleet should be: it has to be reconciled with
 * whatever #51 concludes on fleet scale rather than standing in for that answer.
 */
export const CONTINUOUS_COVERAGE_MAX_LOCATIONS = MAX_LOCATIONS_PER_CYCLE * forecastHours;
