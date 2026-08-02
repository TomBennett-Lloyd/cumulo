import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';

/**
 * DynamoDB's cancellation vocabulary for `TransactWriteItems`: the `Code`
 * strings it reports per item in `CancellationReasons`, and the one
 * classification this package acts on rather than merely names.
 *
 * The codes are the *service's*, not either adapter's. Two adapters here send
 * transactions against two different tables and both read the same reason
 * codes, so if one copy changed the other would be wrong until it changed the
 * same way — the test `docs/standards/structure.md` rule 7 puts on a duplicate,
 * and the same reasoning that puts `DYNAMODB_BATCH_WRITE_SIZE` in `batch.ts`.
 *
 * The strings carry no `Exception` suffix — `ProvisionedThroughputExceeded`,
 * not `ProvisionedThroughputExceededException`. That is not a slip: the
 * suffixed names are error types raised against a *whole request*, while these
 * are per-item reason codes on a request that reached the service and was
 * cancelled. AWS's `TransactWriteItems` API reference lists the full set
 * unsuffixed — `None`, `ConditionalCheckFailed`,
 * `ItemCollectionSizeLimitExceeded`, `TransactionConflict`,
 * `ProvisionedThroughputExceeded`, `ThrottlingError`, `ValidationError`.
 *
 * Nothing here is on the package's public surface (`index.ts` exports none of
 * it): classifying a cancellation is this package's job, and a caller handed
 * these strings would be one step from re-implementing the classification
 * itself.
 */

/**
 * DynamoDB's cancellation code for a transaction item whose `ConditionExpression`
 * evaluated false. Every other code — `TransactionConflict`,
 * `ProvisionedThroughputExceeded`, `ThrottlingError`, `ValidationError` — means
 * the write did not happen for a reason that is *not* a domain outcome.
 */
export const CONDITIONAL_CHECK_FAILED = 'ConditionalCheckFailed';

/**
 * DynamoDB's cancellation code for a transaction item that collided with
 * another in-flight transaction on the same row — the site counter item, in
 * practice, which every capped create and counted delete writes.
 */
export const TRANSACTION_CONFLICT = 'TransactionConflict';

/** The code DynamoDB reports for an item that was itself fine. */
export const NO_CANCELLATION_REASON = 'None';

/**
 * The capacity code of a *provisioned* table or index: the transaction asked
 * for more capacity units than the table has, and DynamoDB cancelled the whole
 * request rather than serving it partially.
 */
export const PROVISIONED_THROUGHPUT_EXCEEDED = 'ProvisionedThroughputExceeded';

/**
 * The capacity code of an *on-demand* table or index still scaling up to the
 * offered load. It is the same failure to the caller — the write did not
 * happen, for want of capacity, and a later attempt may well succeed — so
 * {@link capacityCancelled} treats the two alike.
 */
export const THROTTLING_ERROR = 'ThrottlingError';

/** Both ways DynamoDB says "there was not enough capacity for this item". */
const capacityCode = (code: string | undefined): boolean =>
  code === PROVISIONED_THROUGHPUT_EXCEEDED || code === THROTTLING_ERROR;

/**
 * Was this rejection a transaction cancelled for capacity, and for nothing
 * else?
 *
 * This is the shape nobody else retries. A `TransactWriteItems` throttled
 * before it starts throws `ProvisionedThroughputExceededException`, which the
 * SDK's classifier knows; a transaction cancelled *mid-flight* for capacity
 * instead answers `TransactionCanceledException`, whose cause is reachable only
 * inside `CancellationReasons[].Code`. Verified against the installed
 * `@aws-sdk/client-dynamodb` 3.1098.0, that exception carries no `$retryable`
 * trait and does not appear in `@smithy/core` 3.31.1's `THROTTLING_ERROR_CODES`
 * — so the SDK layer spends zero retries on it and this predicate is what gives
 * the shape an owner at all (`client-retry-classification.test.ts` pins that at the wire).
 *
 * Both clauses are load-bearing, in the same way `conflictCancelled`'s `every`
 * is:
 *
 * - The **`some`** clause refuses a cancellation that names no capacity code —
 *   an empty or all-`None` reasons array says only that the transaction was
 *   cancelled, and re-issuing a request whose cause is unknown is a guess, not
 *   a retry.
 * - The **`every`** clause refuses every mix. A `ConditionalCheckFailed`
 *   alongside a capacity code is a *domain verdict* — some condition was
 *   genuinely false — and re-issuing it blind would spend capacity to be told
 *   the same thing, or worse, race a caller that has already been answered. A
 *   `TransactionConflict` is not a bare capacity signal either: it means a
 *   concurrent writer, which on the only path that retries here
 *   (`putArchiveDay`) has no retry owner and stays a `StorageError`. Anything
 *   else in the vocabulary — `ValidationError`,
 *   `ItemCollectionSizeLimitExceeded` — is a request that will fail identically
 *   however often it is sent.
 *
 * The predicate only *classifies*. Whether a capacity cancellation is retried,
 * and how hard, is each adapter's decision: the weather adapter re-issues
 * `putArchiveDay` under its batch policy, while the site adapter deliberately
 * does not retry at all (its callers hold an API request budget) and lets the
 * cancellation surface as a `StorageError`.
 */
export const capacityCancelled = (cause: unknown): boolean => {
  if (!(cause instanceof TransactionCanceledException)) {
    return false;
  }
  const reasons = cause.CancellationReasons ?? [];

  return (
    reasons.some((reason) => capacityCode(reason.Code)) &&
    reasons.every((reason) => capacityCode(reason.Code) || reason.Code === NO_CANCELLATION_REASON)
  );
};
