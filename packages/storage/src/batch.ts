/**
 * Batch draining and the backoff arithmetic shared by every retry path in this
 * package.
 *
 * DynamoDB's `BatchWriteItem` / `BatchGetItem` answer HTTP 200 while handing
 * back the items they declined to process (`UnprocessedItems` /
 * `UnprocessedKeys`). Treating that 200 as success silently drops writes —
 * exactly the swallowed failure `docs/standards/error-handling.md` rule 2
 * forbids, and the failure mode ADR 0002 Consequence 4 calls out by name. So
 * this module never returns a bare "done": the caller gets a discriminated
 * union and must decide what a partial drain means for its operation.
 */

/**
 * Upper bound on a single backoff sleep, in milliseconds. Matches the AWS SDK's
 * own `MAXIMUM_RETRY_DELAY`; pinned here rather than imported so the ceiling is
 * a decision of ours, visible at the call site (error-handling rule 3).
 */
export const MAX_BACKOFF_DELAY_MS = 20_000;

/**
 * DynamoDB's hard per-request limit for `BatchWriteItem`: 25 items.
 *
 * One copy rather than one per adapter, because it is not a choice either of
 * them made — it is the service's number, and if it ever moved, every adapter
 * that split a write into batches would be wrong until it changed the same way
 * (`docs/standards/structure.md` rule 7).
 *
 * It is on this package's public surface because a caller sizing a *time*
 * budget needs it: how many round trips a write of N items costs is
 * `ceil(N / 25)`, and `@cumulo/ingestion`'s cycle budget derives its per-location
 * worst case from exactly that (#115). A number quoted from memory there would
 * be the assumption this export exists to remove.
 */
export const DYNAMODB_BATCH_WRITE_SIZE = 25;

/** Inputs to the full-jitter backoff formula. */
export interface BackoffSpec {
  /** Delay base `x`: the cap on the first retry's sleep. */
  readonly baseDelayMs: number;
  /** Ceiling on the exponential term, applied before jitter. */
  readonly maxDelayMs: number;
  /** Injectable for tests; production uses `Math.random`. */
  readonly random?: () => number;
}

/**
 * Full jitter: `sleep = uniform(0, min(base * 2^(retryAttempt - 1), max))`.
 *
 * Full rather than equal jitter because every site in the fleet retries against
 * the same provisioned-capacity tables — correlated backoff is what turns a
 * throttle into a thundering herd.
 *
 * `retryAttempt` is 1-based: 1 is the first retry (the initial try is not a
 * retry), so the first retry's cap is exactly `baseDelayMs`.
 */
export const fullJitterDelayMs = (retryAttempt: number, spec: BackoffSpec): number => {
  if (!Number.isInteger(retryAttempt) || retryAttempt < 1) {
    throw new Error(
      `fullJitterDelayMs: retryAttempt must be a positive integer, got ${String(retryAttempt)}`,
    );
  }
  const random = spec.random ?? Math.random;
  const cap = Math.min(spec.baseDelayMs * 2 ** (retryAttempt - 1), spec.maxDelayMs);
  return Math.floor(random() * cap);
};

/**
 * How hard to push a batch before accepting a partial result.
 *
 * `maxAttempts` counts the initial send, so `3` means one send plus two
 * retries. `sleep` is injected only by tests; production leaves it unset and
 * gets the real timer.
 */
export interface BatchPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * The failure policy for batch operations, stated once and reused (error-handling
 * rule 3): three attempts, 200 ms full-jitter base. Deliberately short — an
 * unresolved batch is reported to the caller as `partial`, not hidden behind a
 * long retry loop.
 */
export const defaultBatchPolicy: BatchPolicy = {
  maxAttempts: 3,
  baseDelayMs: 200,
};

/**
 * Result of draining every request. `partial` carries the exact leftovers so a
 * caller can count them, log them, or re-queue them — never a silent success.
 */
export type DrainOutcome<TReq> =
  { readonly status: 'complete' } | { readonly status: 'partial'; readonly unprocessed: TReq[] };

/**
 * The result of a batched write, as an adapter reports it to its caller: the
 * same distinction {@link DrainOutcome} draws, with the leftover *requests*
 * reduced to a count.
 *
 * Adapters narrow the outcome this way because the unprocessed entries are
 * SDK-shaped write requests — transport, not domain — so handing them out would
 * leak the wire format through the package surface. The count is what a caller
 * can act on: log it, alarm on it, or re-derive the items from its own input.
 *
 * It lives here, next to the drain that produces it, because both the series and
 * the weather adapter return exactly this union. Two identical copies would be
 * two things a caller could not pass to one function, and one edit away from
 * disagreeing (architecture rule 2 applied to a type rather than a schema).
 */
export type BatchWriteOutcome =
  | { readonly status: 'complete' }
  | { readonly status: 'partial'; readonly unprocessedCount: number };

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const chunk = <TReq>(requests: readonly TReq[], batchSize: number): TReq[][] => {
  const chunks: TReq[][] = [];
  for (let index = 0; index < requests.length; index += batchSize) {
    chunks.push(requests.slice(index, index + batchSize));
  }
  return chunks;
};

/**
 * Splits `requests` into batches of at most `batchSize`, sends each one, and
 * re-sends whatever `send` reports as unprocessed until the batch drains or the
 * policy's attempts run out.
 *
 * `send` returns the *unprocessed* subset of the batch it was given (empty
 * array = fully accepted). It is injected rather than being an SDK call so the
 * retry arithmetic is pure and testable without mocking AWS, and so adapters
 * keep ownership of command construction and error wrapping — a rejection from
 * `send` propagates untouched (the adapter converts it to a `StorageError`).
 *
 * Batches are independent: a batch that never drains does not stop later
 * batches from being attempted, and every leftover from every batch is returned
 * together, in request order.
 */
export const drainBatches = async <TReq>(
  send: (batch: TReq[]) => Promise<TReq[]>,
  requests: readonly TReq[],
  batchSize: number,
  policy: BatchPolicy,
): Promise<DrainOutcome<TReq>> => {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`drainBatches: batchSize must be a positive integer, got ${String(batchSize)}`);
  }
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new Error(
      `drainBatches: policy.maxAttempts must be a positive integer, got ${String(policy.maxAttempts)}`,
    );
  }
  if (!Number.isFinite(policy.baseDelayMs) || policy.baseDelayMs < 0) {
    throw new Error(
      `drainBatches: policy.baseDelayMs must be a non-negative number, got ${String(policy.baseDelayMs)}`,
    );
  }

  const sleep = policy.sleep ?? realSleep;
  const unprocessed: TReq[] = [];

  for (const batch of chunk(requests, batchSize)) {
    let pending = batch;
    for (let attempt = 1; attempt <= policy.maxAttempts && pending.length > 0; attempt += 1) {
      if (attempt > 1) {
        await sleep(
          fullJitterDelayMs(attempt - 1, {
            baseDelayMs: policy.baseDelayMs,
            maxDelayMs: MAX_BACKOFF_DELAY_MS,
          }),
        );
      }
      pending = await send(pending);
    }
    unprocessed.push(...pending);
  }

  return unprocessed.length === 0 ? { status: 'complete' } : { status: 'partial', unprocessed };
};
