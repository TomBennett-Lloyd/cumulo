import { describe, expect, it } from 'vitest';

import { StorageError } from '../../errors';

import { SITE_ID, forecast, generationReading, mockedAdapter } from './series-fixtures';

/**
 * What this adapter refuses before it sends anything, and — the point of every
 * case here — *how* it refuses.
 *
 * Each assertion comes in two halves: the rejection names the caller's mistake,
 * and it is **not** a `StorageError`. The second half is the one with teeth. A
 * precondition that runs inside `sending` still rejects the same input, so a
 * test that only checked "it rejected" would stay green while the message told
 * an operator that DynamoDB had failed on the table (#166,
 * `docs/standards/error-handling.md` rules 1 and 2).
 *
 * A sibling file rather than more cases in `series-adapter.test.ts`, which is
 * within a few lines of the 300-line ceiling — the split
 * `client-retry-classification.test.ts` already set.
 */

/** A policy whose retry loop could never run: the shape a parsed env var takes when it goes wrong. */
const UNUSABLE_POLICY = { maxAttempts: 0, baseDelayMs: 0 };

describe('putForecasts', () => {
  it('refuses two forecasts sharing (siteId, validTime, model) before any command is sent', async () => {
    const { adapter, ddb } = mockedAdapter();
    const duplicated = forecast();

    const rejection = adapter.putForecasts([duplicated, forecast({ model: 'ml' }), duplicated]);

    await expect(rejection).rejects.toThrow(
      `putForecasts: two items share the key ${SITE_ID}|T#2026-07-30T14:00:00Z#FC#physics — the caller must de-duplicate before writing`,
    );
    await expect(rejection).rejects.not.toBeInstanceOf(StorageError);
    // Nothing reached the wire: DynamoDB would reject the whole batch for the
    // repeated key anyway, and the caller learns why from here instead.
    expect(ddb.calls()).toHaveLength(0);
  });

  it('refuses a policy that could never send, as a caller error rather than a table failure', async () => {
    const { adapter, ddb } = mockedAdapter(UNUSABLE_POLICY);

    const rejection = adapter.putForecasts([forecast()]);

    await expect(rejection).rejects.toThrow(
      'putForecasts: policy.maxAttempts must be a positive integer, got 0',
    );
    // The name in the message is the public method, and the error is a plain
    // one: `drainBatches` refuses the identical policy from inside the wrap,
    // where the same bug would arrive as `StorageError: storage operation
    // 'putForecasts' failed on table 'cumulo-series-test'`.
    await expect(rejection).rejects.not.toBeInstanceOf(StorageError);
    expect(ddb.calls()).toHaveLength(0);
  });
});

describe('putGenerationReadings', () => {
  it('refuses two readings for one site-hour before any command is sent', async () => {
    const { adapter, ddb } = mockedAdapter();
    const reading = generationReading();

    const rejection = adapter.putGenerationReadings([reading, reading]);

    await expect(rejection).rejects.toThrow(
      `putGenerationReadings: two items share the key ${SITE_ID}|T#2026-07-30T14:00:00Z#GEN`,
    );
    await expect(rejection).rejects.not.toBeInstanceOf(StorageError);
    expect(ddb.calls()).toHaveLength(0);
  });

  it('refuses a policy that could never send, as a caller error rather than a table failure', async () => {
    const { adapter, ddb } = mockedAdapter(UNUSABLE_POLICY);

    const rejection = adapter.putGenerationReadings([generationReading()]);

    await expect(rejection).rejects.toThrow(
      'putGenerationReadings: policy.maxAttempts must be a positive integer, got 0',
    );
    await expect(rejection).rejects.not.toBeInstanceOf(StorageError);
    expect(ddb.calls()).toHaveLength(0);
  });
});
