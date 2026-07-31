import {
  DYNAMODB_BATCH_WRITE_SIZE,
  STORAGE_MAX_ATTEMPTS,
  STORAGE_REQUEST_TIMEOUT_MS,
  STORAGE_RETRY_BASE_DELAY_MS,
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
 * timeout; the cap protects the quota; neither substitutes for the other.
 * A cycle can exhaust its time without going near the Open-Meteo allowance (one
 * stalled location does it), and it can exhaust the allowance without going near
 * its time (five hundred fast locations do it). They are two resources, so they
 * get two bounds, each derived from the limit that actually binds it.
 *
 * **Why the obvious third option is absent.** The tempting design is a single
 * location cap sized so that `cap × worst case ≤ function timeout`. That is
 * arithmetic against a world where every location simultaneously takes its
 * pathological path, and at the numbers below it yields a cap of **two** — the
 * canonical fleet is twelve, and #17 adds visitor sites on top. Sizing a count
 * to a scenario that is both catastrophic and simultaneous is the same species
 * of mistake #115 was filed about: a number justified against a model of the
 * system rather than against the system. So the worst case below is not used to
 * choose a fleet size. It is used to answer one narrow question — *how much
 * time must be left in reserve for a location already in flight?* — which is
 * exactly what {@link CYCLE_DEADLINE_MS} subtracts.
 *
 * **Two terms are knowingly priced at zero**, and the identity below carries no
 * slack, so each is a way the function timeout becomes reachable rather than
 * unreachable. Both are recorded in `docs/tech-debt.md` rather than priced in,
 * because pricing either would inflate {@link LOCATION_WORST_MS} substantially
 * to insure against something that does not happen in practice:
 *
 * 1. The smithy standard retry strategy honours a server-supplied retry hint,
 *    which can extend any single retry by up to 5,000 ms beyond the computed
 *    delay (verified in the installed `@smithy/core` 3.31.1). Neither DynamoDB
 *    nor SQS sends `Retry-After` in normal operation.
 * 2. The pinned request timeouts bound the time to the **first response**, not
 *    the whole attempt: the timer is cleared when response headers arrive and
 *    the body is still streaming, and neither client sets `socketTimeout`. A
 *    response whose body stalls after its headers is unbounded. These are small
 *    single-chunk JSON responses, so that is remote — but it means the two
 *    per-request terms below are bounds on time-to-first-response.
 *
 * **Every other term is imported.** Nothing here restates a number that lives
 * somewhere else, because a copied constant is how the previous budget went
 * stale without anyone noticing. The one exception is named and explained:
 * {@link SDK_THROTTLING_RETRY_DELAY_BASE_MS}, which belongs to the AWS SDK and
 * is not ours to pin. The payoff is mechanical: when #122
 * lands and a batch write stops costing four SDK attempts inside three drain
 * attempts, {@link LOCATION_WORST_MS} shrinks and {@link CYCLE_DEADLINE_MS}
 * widens on its own, with no comment left behind claiming otherwise.
 */

/**
 * The ceiling on a full-jitter backoff curve: the sum of every retry's cap.
 *
 * Full jitter draws uniformly over `[0, cap)`, so the sum of the caps is the
 * bound, never the expectation — which is the right shape for a budget and the
 * wrong shape for a forecast of how long a cycle takes.
 *
 * `attempts` counts the initial try, so a policy of `n` attempts backs off
 * `n - 1` times, doubling from `baseDelayMs`.
 */
export const backoffCeilingMs = (attempts: number, baseDelayMs: number): number => {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error(
      `backoffCeilingMs: attempts must be a positive integer, got ${String(attempts)}`,
    );
  }
  let total = 0;
  for (let retry = 1; retry < attempts; retry += 1) {
    total += baseDelayMs * 2 ** (retry - 1);
  }
  return total;
};

/**
 * The AWS SDK's own throttling backoff base, in milliseconds, for clients that
 * do not replace the delay curve — which the SQS publisher deliberately does
 * not (see `publisher/sqs.ts`).
 *
 * The one number below that this repo does not set, restated here because a
 * budget cannot be honest about a term it omits. Verified against the installed
 * `@smithy/core` 3.31.1 (`THROTTLING_RETRY_DELAY_BASE = 500`); the storage path
 * needs no equivalent because `createStorageRetryStrategy` pins its own curve.
 */
export const SDK_THROTTLING_RETRY_DELAY_BASE_MS = 500;

/**
 * Worst case for one location's Open-Meteo fetch: every attempt hitting its
 * deadline, with the retry's full-jitter window spent in full.
 *
 * ≈ 21 s — `2 × 10 s + 1 s`.
 */
export const FETCH_WORST_MS =
  FETCH_MAX_ATTEMPTS * defaultTimeoutMs + backoffCeilingMs(FETCH_MAX_ATTEMPTS, retryBaseDelayMs);

/** Round trips one location's horizon costs: `ceil(48 / 25)` = 2 `BatchWriteItem` calls. */
export const STORE_BATCHES_PER_LOCATION = Math.ceil(forecastHours / DYNAMODB_BATCH_WRITE_SIZE);

/**
 * Worst case for a single `BatchWriteItem` round trip: every SDK attempt
 * hitting {@link STORAGE_REQUEST_TIMEOUT_MS}, with the pinned storage backoff
 * spent in full between them.
 *
 * ≈ 19 s — `4 × 3 s + (1 + 2 + 4) s`. Before #115 this term did not exist:
 * without a pinned request timeout the SDK's default is no timeout at all, and
 * a stalled socket here was bounded by nothing this repo sets.
 */
export const STORE_SEND_WORST_MS =
  STORAGE_MAX_ATTEMPTS * STORAGE_REQUEST_TIMEOUT_MS +
  backoffCeilingMs(STORAGE_MAX_ATTEMPTS, STORAGE_RETRY_BASE_DELAY_MS);

/**
 * Worst case for storing one location's readings.
 *
 * ≈ 115 s, and the dominant term by a wide margin. Two retry layers stack here:
 * `drainBatches` re-sends whatever `BatchWriteItem` declines
 * (`defaultBatchPolicy`, three attempts), and each of those sends is itself
 * retried by the SDK ({@link STORAGE_MAX_ATTEMPTS}, four attempts). One batch
 * can therefore cost twelve round trips under two independent backoff curves.
 * That stacking is tracked as #122; collapsing it is the single
 * largest reduction available to this budget, and this module is arranged so
 * that landing it needs no edit here.
 */
export const STORE_WORST_MS =
  STORE_BATCHES_PER_LOCATION *
  (defaultBatchPolicy.maxAttempts * STORE_SEND_WORST_MS +
    backoffCeilingMs(defaultBatchPolicy.maxAttempts, defaultBatchPolicy.baseDelayMs));

/**
 * Worst case for publishing one location to SQS.
 *
 * ≈ 10.5 s — `3 × 3 s` of pinned per-attempt deadline plus the SDK's own
 * throttling backoff, which this client leaves to the standard strategy.
 */
export const PUBLISH_WORST_MS =
  INGESTION_SEND_MAX_ATTEMPTS * INGESTION_SEND_REQUEST_TIMEOUT_MS +
  backoffCeilingMs(INGESTION_SEND_MAX_ATTEMPTS, SDK_THROTTLING_RETRY_DELAY_BASE_MS);

/**
 * All three of a location's effects at their bounded worst, ≈ 147 s.
 *
 * Read this as "the reserve a location in flight may need", not as "how long a
 * location takes" — a healthy one costs well under a second. It is the number
 * {@link CYCLE_DEADLINE_MS} holds back so that a location started just before
 * the deadline still finishes inside the function timeout.
 */
export const LOCATION_WORST_MS = FETCH_WORST_MS + STORE_WORST_MS + PUBLISH_WORST_MS;

/**
 * The function timeout in `infra/ingestion/lambda.tf`, mirrored.
 *
 * A mirror, not a source: Terraform owns the deployed value and its comment
 * cites this constant by name, as this one cites the file. They are checked
 * against each other by eye today; the drift that a mirrored constant invites
 * is tracked as #123.
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
 * How long a cycle may keep *starting* locations, ≈ 148 s.
 *
 * The deadline is checked before each location and never interrupts one in
 * flight, so the guarantee is: `elapsed at last start ≤ deadline`, plus at most
 * {@link LOCATION_WORST_MS} for that location, plus
 * {@link SHUTDOWN_MARGIN_MS} — which is {@link INGESTION_LAMBDA_TIMEOUT_MS} by
 * construction. That is what makes the function timeout **unreachable** rather
 * than merely unlikely, and it is why the timeout is no longer a number anyone
 * has to size against a fleet.
 *
 * A healthy twelve-location cycle finishes in seconds and never comes near
 * this. If it ever fires in production, the constants above are wrong at their
 * source — that is the intended way to find out.
 */
export const CYCLE_DEADLINE_MS =
  INGESTION_LAMBDA_TIMEOUT_MS - LOCATION_WORST_MS - SHUTDOWN_MARGIN_MS;

/**
 * Locations one cycle may fetch weather for.
 *
 * Derived from the Open-Meteo allowance in CLAUDE.md — 10,000 calls/day — and
 * not from time, which {@link CYCLE_DEADLINE_MS} already owns. At an hourly
 * cadence, 100 locations is `100 × 24 = 2,400` calls/day, **24% of the daily
 * allowance**, leaving the rest for #16's archive backfill, for a re-run after
 * a failed cycle, and for the retry each location is allowed. The per-minute
 * ceiling (600) stays unreachable because locations are fetched sequentially.
 *
 * 100 is comfortable headroom over every fleet size this repo has committed to:
 * `docs/design/fleet-simulation.md`'s canonical fleet implies 12 locations, and
 * ADR 0002's "Assumed scale" sizes storage against ~50 sites over ~30
 * locations at 720 calls/day. The gap between 30 and 100 is deliberate room for
 * #17, which adds visitor sites at arbitrary coordinates by design — that is
 * why ingestion enforces a bound of its own instead of inheriting one from a
 * property of the seed fleet.
 *
 * Reaching it is not an error, and the code says so rather than only the
 * comment: a capped location is reported as `skipped` with reason
 * `location-cap`, counted in the report's `deferred` — which is deliberately
 * **not** part of `failed` — and so it does not raise `CycleFailedError` or the
 * `ingestion_errors` alarm. A fleet legitimately larger than the cap would
 * otherwise page every hour forever. Rotation means the deferred locations are
 * not the same ones next hour.
 */
export const MAX_LOCATIONS_PER_CYCLE = 100;
