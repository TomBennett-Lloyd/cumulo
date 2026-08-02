import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ConfiguredRetryStrategy } from '@smithy/core/retry';
import { NodeHttpHandler } from '@smithy/node-http-handler';

import { MAX_BACKOFF_DELAY_MS, fullJitterDelayMs } from './batch';

/**
 * The one place a DynamoDB client is built for this package, and therefore the
 * one place its failure policy is stated (`docs/standards/error-handling.md`
 * rule 3: timeout, retry count and backoff are visible in the adapter's config,
 * never inherited from library defaults).
 */

/**
 * Total attempts per request, initial send included — so exactly one retry.
 *
 * **Which layer owns which failure.** DynamoDB refuses work in five distinct
 * shapes, and this constant is the budget for only three of them. Stacking two
 * budgets over one shape is what #122 came out of and paying nothing for a
 * shape nobody owns is what #166 came out of, so the record is kept per
 * *shape* — owner and budget — rather than per command:
 *
 * 1. **A partially served batch**: `UnprocessedItems`/`UnprocessedKeys`
 *    returned on HTTP 200. Owner: the **drain layer**, `drainBatches` under
 *    `defaultBatchPolicy` (`./batch`) — 3 sends over a 200 ms full-jitter base.
 *    When DynamoDB declines some of a `BatchWriteItem`'s items it does not
 *    reject the request at all: it answers 200 and hands the declined items
 *    back, which the SDK cannot see as a failure. That is ADR 0002 Consequence
 *    4's own mechanism, and re-sending only the declined items is strictly
 *    better than re-sending the whole batch. The SDK layer sees a transport
 *    blip here or nothing at all.
 *
 *    This is also the shape that actually happens, which is the evidence the
 *    budget below rests on: the one observed real throttle event — #29's E7-a
 *    run, recorded on #156, where an ingestion cycle at the 40-distinct-location
 *    worst case drew **1,350 throttled writes in one cycle minute** and lost 26
 *    of 40 locations — arrived here, on `putForecastWeather` against the
 *    provisioned `cumulo-weather` table. No attempt count would have bought
 *    those locations back: the drain layer had already spent its three sends
 *    against a table that was short of capacity for the whole minute. The fix
 *    is capacity (#156), not attempts.
 *
 * 2. **A whole-request throttle**: `ProvisionedThroughputExceededException`
 *    *thrown* rather than reported. That covers `GetItem`, `PutItem` and
 *    `DeleteItem`, every `queryAllPages` page, a `TransactWriteItems` refused
 *    outright before it is cancelled, and — the case that escapes shape 1 — a
 *    *wholly* declined `BatchWriteItem`/`BatchGetItem`: when *none* of a
 *    batch's items can be processed for insufficient provisioned throughput,
 *    DynamoDB rejects the whole request instead of reporting unprocessed items,
 *    and `drainBatches` only re-sends what `send` *returns*, so the rejection
 *    propagates straight through it. Owner: the **SDK layer** — this constant,
 *    2 attempts.
 *
 *    Why the budget stays 2 rather than growing to cover this shape (#166
 *    re-derived it rather than inheriting #122's number):
 *
 *    - **It is already most of the API's request budget.** One command costs
 *      ≈ 7 s worst case — 2 × {@link STORAGE_REQUEST_TIMEOUT_MS} plus under a
 *      second of jitter — against the 15 s Lambda timeout every API request is
 *      measured against (`API_LAMBDA_TIMEOUT_MS`, `apps/api/src/request-budget`
 *      — and #165 derives that number against *this* one). A third attempt does
 *      not fit, least of all on `queryAllPages`, which spends the worst case
 *      once per page.
 *    - **A request still throttled after a full second of jittered backoff is
 *      not blipping.** It is reporting sustained capacity pressure, which is an
 *      alarm to answer rather than a request to retry into: ADR 0002 puts
 *      `ReadThrottleEvents`/`WriteThrottleEvents` alarms behind the provisioned
 *      tables and ~250 dashboard loads of burst reserve in front of the
 *      synchronous fan-out.
 *    - **Every site in the fleet backs off against the same provisioned
 *      tables**, so a longer per-request budget is the thundering-herd
 *      direction — the reason the curve underneath is full jitter (`./batch`).
 *
 *    The cost is real and is stated rather than argued away: on the one
 *    genuinely user-visible throttle path ADR 0002 names, the synchronous
 *    dashboard fan-out, a read that outlives the burst reserve exhausts this
 *    budget after a single retry and reaches the caller as a `StorageError`
 *    (`./errors`), which the API boundary renders as a generic 500.
 *
 * 3. **A capacity-cancelled transaction**: `TransactionCanceledException`,
 *    whose cause is reachable only inside `CancellationReasons[].Code`. The
 *    SDK's classifier cannot see this one at all — verified against the
 *    installed `@aws-sdk/client-dynamodb` 3.1098.0, the exception carries no
 *    `$retryable` trait, and it is absent from `@smithy/core` 3.31.1's
 *    `THROTTLING_ERROR_CODES`; `client-retry-classification.test.ts` pins that
 *    at the wire against a real HTTP response rather than trusting the read.
 *    So this constant spends **zero** attempts here, whatever number it holds.
 *
 *    Owner: the weather adapter's bounded re-issue on `putArchiveDay`
 *    (`capacityCancelled`, `./adapters/transaction-cancellation`), budget
 *    `batchPolicy.maxAttempts` — the same policy that drains that adapter's
 *    batches, because it is the same table running out of the same capacity.
 *    On the *site* adapter's transactions the shape is **deliberately
 *    unretried** and surfaces as a `StorageError`: `cumulo-sites` is on-demand
 *    rather than provisioned, and the budget that would pay for a retry there
 *    is the route handler's request budget, not this package's to spend.
 *
 * 4. **A conflict-cancelled transaction**: `TransactionConflict`, two writers
 *    racing on the same row — the site counter, in practice. Owner: the route
 *    handler, per #155. `apps/api/src/sites/conflict-retry.ts` holds the curve
 *    and the count; the adapter's job stops at reporting `'conflict'` as a
 *    value the caller must handle. Its numbers are the API's decision and are
 *    deliberately not restated here.
 *
 * 5. **A transport blip**: request timeout, connection reset, 5xx. Owner: the
 *    **SDK layer** — this constant, 2 attempts. Those are blips, so one retry
 *    is the whole budget.
 *
 * Before #122 this was 4, and the two curves stacked: 3 drain attempts × 4
 * sends = up to 12 round trips for one batch, both layers backing off over the
 * same throttling. At 2 the ceiling is 3 × 2 = 6 round trips, and a batch's
 * worst case is 21.6 s rather than 57.6 s.
 *
 * **The rule, rather than an inventory that will silently fall out of date:**
 * any command not draining `UnprocessedItems` has the SDK layer as its only
 * retry layer — with exactly two exceptions, both of them `TransactWriteItems`:
 * `putArchiveDay`'s capacity re-issue (shape 3) and the site adapter's conflict
 * path (shape 4), neither of which the SDK layer can see. Everything else takes
 * this constant and nothing more: `SiteAdapter`'s `GetItem`, `PutItem` and
 * `DeleteItem`, `MetricsAdapter`'s `PutItem`, every Query issued through
 * `StorageAdapterBase.queryAllPages` (`./adapters/storage-adapter-base.ts`,
 * used by the series, metrics, site and weather adapters), and `SeriesAdapter`'s
 * bounded read, which walks `LastEvaluatedKey` itself rather than through that
 * helper. The two paginating readers are worth naming twice over: neither
 * retries anything of its own, and because both paginate, every page is a fresh
 * opportunity to be throttled — on the provisioned `series` table in the
 * bounded case.
 *
 * ADR 0002 Consequence 5's requirement is unchanged and is why the number lives
 * here at all: pinned explicitly, never inherited. The SDK's *default* is 3
 * attempts with a 500 ms throttling base; its 2026 behaviour (4 attempts,
 * 1000 ms throttling base) only switches on when the `AWS_NEW_RETRIES_2026`
 * environment variable is set, and it was verified against the installed SDK
 * (`@smithy/core` 3.31.x, `Retry.v2026`) that there is no client-config route
 * to that flag. Reading retry behaviour off an environment variable would mean
 * CI, Lambda and an operator's laptop backing off differently against
 * provisioned-capacity tables, so the numbers are set here instead.
 */
export const STORAGE_MAX_ATTEMPTS = 2;

/**
 * Delay base for retry backoff, in milliseconds — the cap on the first retry's
 * sleep, doubling thereafter.
 *
 * This is the *throttling* base of ADR 0002 Consequence 5, pinned rather than
 * inherited for the reasons on {@link STORAGE_MAX_ATTEMPTS}, and it is applied
 * to every retryable error rather than only to throttling ones. Since #122 the
 * errors it actually delays are transport blips — throttling on batch
 * operations arrives as `UnprocessedItems` and is backed off by the drain layer
 * instead — and there is exactly one such delay per request. A full second
 * before the single retry is the conservative direction for a connection reset
 * or a 5xx, and it keeps the policy a single number a reader can check against
 * the ADR. It is deliberately left at 1000 while the attempt count drops: the
 * collapse #122 wanted was of *stacked layers*, not of the pause before a
 * retry.
 */
export const STORAGE_RETRY_BASE_DELAY_MS = 1000;

/**
 * Milliseconds to wait before retry number `retryAttempt` (1-based).
 *
 * Full jitter over an exponentially growing window — see `fullJitterDelayMs`.
 */
export const storageRetryDelayMs = (retryAttempt: number, random?: () => number): number =>
  fullJitterDelayMs(retryAttempt, {
    baseDelayMs: STORAGE_RETRY_BASE_DELAY_MS,
    maxDelayMs: MAX_BACKOFF_DELAY_MS,
    ...(random === undefined ? {} : { random }),
  });

/**
 * Per-attempt deadline, in milliseconds. The SDK's default is **0 — no timeout
 * at all** (`@smithy/node-http-handler`'s `DEFAULT_REQUEST_TIMEOUT`), so
 * without this a stalled socket on the storage path is bounded by nothing this
 * repo sets: {@link STORAGE_MAX_ATTEMPTS} bounds how many times a request is
 * *retried*, never how long one of them may hang.
 *
 * That asymmetry was the point of #115. `@cumulo/ingestion`'s SQS client had
 * already pinned its own (`INGESTION_SEND_REQUEST_TIMEOUT_MS`), so a location's
 * publish was bounded while its DynamoDB write was not, and the ingestion
 * Lambda's whole time budget rested on the unbounded one.
 *
 * 3 s is the same number the SQS client uses, and for the same reason: roughly
 * thirty times a healthy regional request. The heaviest single request this
 * package issues is a 25-item `BatchWriteItem`, a 25-item `TransactWriteItems`
 * or a 100-key `BatchGetItem`, all of which answer in low tens of milliseconds
 * in-region. It is deliberately generous enough to survive the package's
 * non-Lambda consumers too — the operator smoke script and #16's hindcast CLI
 * run from a laptop over the public internet, where a round trip costs tens of
 * milliseconds rather than single digits, and aborting those would trade a
 * bounded wait for a spurious failure.
 */
export const STORAGE_REQUEST_TIMEOUT_MS = 3_000;

/**
 * Connection-establishment deadline, in milliseconds: a DNS or TCP stall is not
 * a slow table, and the SDK retries a failed connection under
 * {@link STORAGE_MAX_ATTEMPTS} like any other transient error.
 */
export const STORAGE_CONNECTION_TIMEOUT_MS = 1_000;

/**
 * `ConfiguredRetryStrategy` is the SDK's supported seam for owning the backoff
 * curve: it extends the standard strategy — keeping its retry-quota accounting
 * and its classification of which errors are retryable at all — while replacing
 * the delay computation wholesale, including the environment-dependent
 * throttling base we are pinning away from.
 *
 * `random` is injectable for tests only; production takes `Math.random`.
 */
export const createStorageRetryStrategy = (random?: () => number): ConfiguredRetryStrategy =>
  new ConfiguredRetryStrategy(STORAGE_MAX_ATTEMPTS, (retryAttempt: number) =>
    storageRetryDelayMs(retryAttempt, random),
  );

export interface StorageClientOptions {
  readonly region?: string;
  /**
   * An already-built base client. Used by tests and by callers that need to
   * share one connection pool; note that supplying one also supplies its retry
   * configuration, so production code should not.
   */
  readonly baseClient?: DynamoDBClient;
}

/**
 * Builds the document client every adapter in this package talks through.
 *
 * Two house rules are fixed here rather than at each call site:
 *
 * 1. `removeUndefinedValues: true`. Under `exactOptionalPropertyTypes` an
 *    optional domain field can legitimately arrive as an explicitly-`undefined`
 *    property — `{ ...forecast }` where `forecast.uncertainty` was never set.
 *    Verified against the installed SDK: a *top-level* item attribute set to
 *    `undefined` is dropped by lib-dynamodb's own key walk regardless of this
 *    option, but an `undefined` nested inside a map or list attribute makes the
 *    default marshaller **throw**. Without this setting the failure would
 *    therefore be conditional on nesting depth — the worst kind, since it only
 *    shows up once a nested optional (an uncertainty band, say) is added. The
 *    alternative — every adapter pruning its own items before writing — is four
 *    copies of the same loop and one forgotten copy away from the same failure.
 *    So: absent and explicitly-`undefined` both mean "no attribute", at every
 *    depth, decided once. (This resolves the explicit-`undefined` tech-debt
 *    entry.)
 *
 * 2. The per-request deadlines of {@link STORAGE_REQUEST_TIMEOUT_MS} and
 *    {@link STORAGE_CONNECTION_TIMEOUT_MS}, set here so that every adapter in
 *    the package inherits them and no call site can forget one. Together with
 *    {@link STORAGE_MAX_ATTEMPTS} and {@link STORAGE_RETRY_BASE_DELAY_MS} they
 *    make a single storage request's worst case a number this repo states
 *    rather than one the network chooses — which is what lets
 *    `@cumulo/ingestion`'s cycle budget compute a bound instead of assuming
 *    one (#115).
 *
 *    A caller that supplies its own `baseClient` supplies its own deadlines
 *    too, exactly as it supplies its own retry configuration.
 *
 * 3. `ConsistentRead` is set nowhere in this package. ADR 0002 sized the
 *    `series` table's 21 RCU against Query's default eventually-consistent
 *    reads; a single `ConsistentRead: true` doubles the cost of that read and
 *    can push the table into throttling. Any future need for one has to be
 *    justified at its own call site — and the adapter tests assert that no
 *    command input carries the flag.
 */
export const createStorageDocumentClient = (
  options?: StorageClientOptions,
): DynamoDBDocumentClient => {
  const baseClient =
    options?.baseClient ??
    new DynamoDBClient({
      ...(options?.region === undefined ? {} : { region: options.region }),
      maxAttempts: STORAGE_MAX_ATTEMPTS,
      retryStrategy: createStorageRetryStrategy(),
      requestHandler: new NodeHttpHandler({
        requestTimeout: STORAGE_REQUEST_TIMEOUT_MS,
        connectionTimeout: STORAGE_CONNECTION_TIMEOUT_MS,
        // Without this, `requestTimeout` is advisory: verified against the
        // installed @smithy/node-http-handler 4.9.13, `setRequestTimeout`
        // only emits a `console.warn` when the deadline passes and leaves the
        // socket hanging — the destroy-and-reject branch is gated entirely on
        // this flag. A timeout that logs is not a bound, and the budget in
        // `@cumulo/ingestion` treats this one as arithmetic.
        //
        // What this buys, stated precisely: `requestTimeout` bounds the time to
        // the **first response** — its timer is armed when the request is
        // issued and cleared when the `response` event fires, which is when
        // headers arrive and the body is still an open stream. A response whose
        // headers arrive and whose body then stalls is bounded by nothing here.
        //
        // `socketTimeout` is what would bound that, and it is deliberately left
        // unset: it is an *inactivity* timer, so it fires on a slow-but-
        // progressing response too, and it would add a term
        // `@cumulo/ingestion`'s cycle budget has to price. These are small
        // single-chunk JSON responses, so a mid-body stall is remote — but it
        // is a real gap rather than a covered case, and `docs/tech-debt.md`
        // records it against the budget's zero-slack identity rather than
        // leaving this comment to claim more than the flag delivers.
        throwOnRequestTimeout: true,
      }),
    });

  return DynamoDBDocumentClient.from(baseClient, {
    marshallOptions: { removeUndefinedValues: true },
  });
};
