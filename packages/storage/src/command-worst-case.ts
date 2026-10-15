/**
 * How long this package can take, stated by this package.
 *
 * Consumers — `apps/api/src/request-budget.ts`,
 * `apps/ingestion/src/cycle-budget.ts`, `client.test.ts` — import these figures
 * instead of re-deriving them.
 *
 * Every number here is a **bound, not an expectation**. Full jitter draws
 * uniformly over `[0, cap)`, so summing the caps answers "can this fit in the
 * budget?" and answers nothing at all about how long a healthy command takes.
 */

import { MAX_BACKOFF_DELAY_MS, defaultBatchPolicy, type BackoffSpec } from './batch';
import {
  STORAGE_MAX_ATTEMPTS,
  STORAGE_REQUEST_TIMEOUT_MS,
  STORAGE_RETRY_BASE_DELAY_MS,
} from './client';

/**
 * The ceiling on a full-jitter backoff curve: the sum of every retry's cap.
 *
 * `attempts` counts the initial try, so a policy of `n` attempts backs off
 * `n - 1` times, doubling from `spec.baseDelayMs` — and **flattening at
 * `spec.maxDelayMs`**.
 *
 * A non-positive-integer `attempts` describes no curve at all, so it is a
 * violated invariant and throws (`docs/standards/error-handling.md` rule 1),
 * matching `fullJitterDelayMs`, which refuses a non-positive-integer
 * `retryAttempt` for the same reason.
 */
export const backoffCeilingMs = (
  attempts: number,
  spec: Pick<BackoffSpec, 'baseDelayMs' | 'maxDelayMs'>,
): number => {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error(
      `backoffCeilingMs: attempts must be a positive integer, got ${String(attempts)}`,
    );
  }
  let total = 0;
  for (let retry = 1; retry < attempts; retry += 1) {
    total += Math.min(spec.baseDelayMs * 2 ** (retry - 1), spec.maxDelayMs);
  }
  return total;
};

/**
 * Worst case for one storage command, in milliseconds: every attempt
 * {@link STORAGE_MAX_ATTEMPTS} allows spending its whole
 * {@link STORAGE_REQUEST_TIMEOUT_MS} deadline, plus the backoff ceiling between
 * them.
 *
 * This is the unit every consumer's budget is denominated in:
 * the API sizes a request against it (`request-budget.ts`), the
 * ingestion cycle multiplies it out per location (`cycle-budget.ts`), and
 * `client.test.ts` measures a real stalled socket against it end to end.
 *
 * It prices only what the SDK controls — the deadlines and the sleeps between
 * them. Connecting, signing, serialising and event-loop time are not in it;
 * consumers that measure wall clock carry that term explicitly rather than
 * assuming it away (`UNPRICED_TERMS_SLACK_MS` in `cycle-budget.ts`).
 */
export const STORAGE_COMMAND_WORST_MS =
  STORAGE_MAX_ATTEMPTS * STORAGE_REQUEST_TIMEOUT_MS +
  backoffCeilingMs(STORAGE_MAX_ATTEMPTS, {
    baseDelayMs: STORAGE_RETRY_BASE_DELAY_MS,
    maxDelayMs: MAX_BACKOFF_DELAY_MS,
  });

/**
 * Worst case for draining one batch page, in milliseconds: every send
 * `defaultBatchPolicy` allows costing a whole {@link STORAGE_COMMAND_WORST_MS},
 * plus the drain layer's own backoff ceiling between sends.
 *
 * The two retry layers are deliberately
 * multiplied, not added: the drain layer re-sends whatever `BatchWriteItem`
 * declines and the SDK layer retries transport blips underneath each send, so
 * one page costs at most `3 × 2 = 6` round trips (see
 * {@link STORAGE_MAX_ATTEMPTS} on the collapse #122 made here).
 *
 * The same figure bounds `putArchiveDay`'s capacity re-issue, which runs on
 * `defaultBatchPolicy` against the same table for the same reason. That path is
 * operator/hindcast-only and appears in no Lambda time budget (#166's
 * hand-off).
 */
export const STORAGE_BATCH_PAGE_WORST_MS =
  defaultBatchPolicy.maxAttempts * STORAGE_COMMAND_WORST_MS +
  backoffCeilingMs(defaultBatchPolicy.maxAttempts, {
    baseDelayMs: defaultBatchPolicy.baseDelayMs,
    maxDelayMs: MAX_BACKOFF_DELAY_MS,
  });
