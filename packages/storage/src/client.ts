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
 * Total attempts per request, initial send included — so three retries.
 *
 * ADR 0002 Consequence 5 requires this to be pinned rather than inherited. The
 * SDK's *default* is 3 attempts with a 500 ms throttling base; its 2026
 * behaviour (4 attempts, 1000 ms throttling base) only switches on when the
 * `AWS_NEW_RETRIES_2026` environment variable is set, and it was verified
 * against the installed SDK (`@smithy/core` 3.31.x, `Retry.v2026`) that there
 * is no client-config route to that flag. Reading retry behaviour off an
 * environment variable would mean CI, Lambda and an operator's laptop backing
 * off differently against provisioned-capacity tables, so the numbers are set
 * here instead.
 */
export const STORAGE_MAX_ATTEMPTS = 4;

/**
 * Delay base for retry backoff, in milliseconds — the cap on the first retry's
 * sleep, doubling thereafter.
 *
 * This is the *throttling* base of ADR 0002 Consequence 5, and it is applied to
 * every retryable error rather than only to throttling ones. The `series` and
 * `weather` tables are provisioned at 14/21 and 5/3 capacity units, so
 * throttling is the expected retryable failure here; backing off a full second
 * on the rarer transient errors too is the conservative direction, and it keeps
 * the policy a single number a reader can check against the ADR.
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
      }),
    });

  return DynamoDBDocumentClient.from(baseClient, {
    marshallOptions: { removeUndefinedValues: true },
  });
};
