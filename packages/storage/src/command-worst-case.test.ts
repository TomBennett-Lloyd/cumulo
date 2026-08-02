import { describe, expect, it } from 'vitest';

import { MAX_BACKOFF_DELAY_MS, defaultBatchPolicy } from './batch';
import { STORAGE_RETRY_BASE_DELAY_MS, storageRetryDelayMs } from './client';
import {
  STORAGE_BATCH_PAGE_WORST_MS,
  STORAGE_COMMAND_WORST_MS,
  backoffCeilingMs,
} from './command-worst-case';

/**
 * The production curve's own answer for `attempts` attempts: the sleep
 * `storageRetryDelayMs` — the function the SDK retry strategy actually runs —
 * takes before each retry, with its random source pinned to the top of every
 * jitter window (`fullJitterDelayMs` floors `random() * cap`, so `() => 1`
 * returns exactly the cap).
 *
 * Driving the real curve rather than restating its arithmetic is the point: it
 * is what lets the property below compare two *independent* routes to the same
 * number instead of comparing a formula with itself.
 */
const productionCurveCeilingMs = (attempts: number): number =>
  Array.from({ length: attempts - 1 }, (_, retryIndex) =>
    storageRetryDelayMs(retryIndex + 1, () => 1),
  ).reduce((total, sleepMs) => total + sleepMs, 0);

describe('backoffCeilingMs', () => {
  it('flattens the exponential term at maxDelayMs instead of doubling forever', () => {
    // The divergence #165 was filed about. Seven attempts at a 1,000 ms base
    // sleep 1,000 + 2,000 + 4,000 + 8,000 + 16,000 + 20,000: the sixth retry
    // hits the ceiling. The uncapped sum the old ingestion helper computed —
    // 1,000 + … + 32,000 — is 63,000, overstating the bound by 12,000 ms.
    expect(backoffCeilingMs(7, { baseDelayMs: 1000, maxDelayMs: MAX_BACKOFF_DELAY_MS })).toBe(
      51_000,
    );
  });

  it('matches the production retry curve it models, at short and flattened lengths', () => {
    // The assertion that stops the two models forking again: if the curve in
    // `client.ts` changes shape, this fails loudly rather than leaving a second
    // derivation quietly wrong. Two attempts is the shipped configuration;
    // seven reaches past MAX_BACKOFF_DELAY_MS, where the two models used to
    // disagree.
    for (const attempts of [2, 7]) {
      expect(
        backoffCeilingMs(attempts, {
          baseDelayMs: STORAGE_RETRY_BASE_DELAY_MS,
          maxDelayMs: MAX_BACKOFF_DELAY_MS,
        }),
      ).toBe(productionCurveCeilingMs(attempts));
    }
  });

  it('costs nothing when the policy allows no retry at all', () => {
    // `attempts` counts the initial try, so a single-attempt policy never sleeps.
    expect(backoffCeilingMs(1, { baseDelayMs: 1000, maxDelayMs: MAX_BACKOFF_DELAY_MS })).toBe(0);
  });

  it('refuses an attempt count that describes no curve', () => {
    for (const attempts of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        backoffCeilingMs(attempts, { baseDelayMs: 1000, maxDelayMs: MAX_BACKOFF_DELAY_MS }),
      ).toThrow(/attempts must be a positive integer/u);
    }
  });
});

describe('the worst cases this package states about itself', () => {
  it('prices one command at 7 s: both attempts timing out, plus the backoff between them', () => {
    expect(STORAGE_COMMAND_WORST_MS).toBe(7_000);
  });

  it('prices one batch page at 21.6 s: three sends of a whole command, plus the drain backoff', () => {
    expect(STORAGE_BATCH_PAGE_WORST_MS).toBe(21_600);
    // The multiplication is the load-bearing part — the page is bounded by the
    // drain layer's sends each costing a full command, not by three bare
    // round trips.
    expect(STORAGE_BATCH_PAGE_WORST_MS).toBeGreaterThan(
      defaultBatchPolicy.maxAttempts * STORAGE_COMMAND_WORST_MS,
    );
  });
});
