import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { StorageError } from '../../errors';
import { captureStorageError } from '../storage-error-capture';

import type { WeatherAdapter } from './weather-adapter';
import {
  CORK,
  DUBLIN_ID,
  NO_REASON,
  TABLE,
  THROTTLING,
  THROUGHPUT_EXCEEDED,
  TRANSACTION_CONFLICT,
  adapter,
  adapterWithPolicy,
  archiveReading,
  ddbMock,
  hourlyFrom,
  instantPolicy,
  shippedAdapter,
  transactInputs,
  transactedItems,
  transactionCancelled,
  writeInputs,
} from './weather-fixtures';

/**
 * The behaviour a partial failure would corrupt most quietly: readings and
 * marker land in one transaction, so a partial fetch can never leave a marker
 * claiming coverage it does not have. Every assertion is on the command input
 * that would reach DynamoDB (`docs/standards/testing.md` rule 3).
 *
 * The capacity re-issue below is counted in *adapter* sends, and only those:
 * `ddbMock` intercepts above the SDK's retry middleware, so nothing here can
 * see how many times the SDK itself would have tried. That layer is pinned
 * separately, at the wire, in `client-retry-classification.test.ts` — the two
 * counts are different facts and neither substitutes for the other.
 */

const DAY = '2026-02-10';
const [firstHour = '', secondHour = ''] = hourlyFrom(`${DAY}T00:00:00Z`, 2);

beforeEach(() => {
  ddbMock.reset();
});

afterAll(() => {
  ddbMock.restore();
});

describe('putArchiveDay', () => {
  it('writes the day’s readings and its marker in a single transaction', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});

    await adapter().putArchiveDay(DAY, [archiveReading(firstHour), archiveReading(secondHour)]);

    expect(transactInputs()).toHaveLength(1);
    const [input] = transactInputs();
    if (input === undefined) {
      throw new Error('expected one TransactWriteCommand');
    }
    const items = transactedItems(input);

    expect(items).toHaveLength(3);
    expect(items.map((item) => item.sk)).toEqual([
      `ARCHIVE#T#${firstHour}`,
      `ARCHIVE#T#${secondHour}`,
      `ARCHIVE#DAY#${DAY}`,
    ]);
    expect(items.map((item) => item.locationId)).toEqual([DUBLIN_ID, DUBLIN_ID, DUBLIN_ID]);
    // Nothing else is batched alongside: one command, atomically.
    expect(writeInputs()).toEqual([]);
  });

  it('gives the marker no attributes beyond its key, and no reading a TTL', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});

    await adapter().putArchiveDay(DAY, [archiveReading(firstHour)]);

    const [input] = transactInputs();
    if (input === undefined) {
      throw new Error('expected one TransactWriteCommand');
    }
    const [reading, marker] = transactedItems(input);

    expect(marker).toEqual({ locationId: DUBLIN_ID, sk: `ARCHIVE#DAY#${DAY}` });
    // Archive weather is the hindcast's permanent input: TTL is per item, and
    // this item must not carry one.
    expect(reading).toBeDefined();
    expect(Object.keys(reading ?? {})).not.toContain('expiresAt');
    expect(reading?.temperature2mC).toBe(17.5);
    expect(reading?.source).toBe('open-meteo');
  });

  it('accepts a full 24-hour day', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});

    await adapter().putArchiveDay(
      DAY,
      hourlyFrom(`${DAY}T00:00:00Z`, 24).map((hour) => archiveReading(hour)),
    );

    const [input] = transactInputs();
    expect(input === undefined ? [] : transactedItems(input)).toHaveLength(25);
  });

  describe('refuses to write a marker it cannot stand behind', () => {
    const cases: {
      name: string;
      call: (adapter: WeatherAdapter) => Promise<void>;
      message: RegExp;
    }[] = [
      {
        name: 'no readings at all',
        call: (weather) => weather.putArchiveDay(DAY, []),
        message: /no readings/,
      },
      {
        name: 'more readings than there are hours in a day',
        call: (weather) =>
          weather.putArchiveDay(
            DAY,
            hourlyFrom(`${DAY}T00:00:00Z`, 25).map((hour) => archiveReading(hour)),
          ),
        message: /more than the 24 hours/,
      },
      {
        name: 'a reading belonging to another day',
        call: (weather) =>
          weather.putArchiveDay(DAY, [
            archiveReading(firstHour),
            archiveReading('2026-02-11T03:00:00Z'),
          ]),
        message: /different day/,
      },
      {
        name: 'readings from two locations',
        call: (weather) =>
          weather.putArchiveDay(DAY, [archiveReading(firstHour), archiveReading(secondHour, CORK)]),
        message: /span two locations/,
      },
      {
        name: 'a day that is not zero-padded YYYY-MM-DD',
        call: (weather) => weather.putArchiveDay('2026-2-10', [archiveReading(firstHour)]),
        message: /YYYY-MM-DD/,
      },
      {
        name: 'a day that does not exist in the calendar',
        // `archiveDayMarkerSortKey` validates shape only, so '2026-02-31'
        // produces a well-formed key. What makes it unwritable is that no
        // reading can be valid on it — the timestamp schema rejects the date
        // — so the day-prefix precondition is the real guard.
        call: (weather) => weather.putArchiveDay('2026-02-31', [archiveReading(firstHour)]),
        message: /different day/,
      },
    ];

    for (const { name, call, message } of cases) {
      it(`throws and sends nothing for ${name}`, async () => {
        ddbMock.on(TransactWriteCommand).resolves({});

        await expect(call(adapter())).rejects.toThrow(message);
        expect(ddbMock.calls()).toHaveLength(0);
      });
    }
  });

  it('refuses a day that repeats an hour, before any command is sent', async () => {
    // One location and one day are already enforced above, so a duplicate item
    // can only be a repeated hour. `TransactWriteItems` rejects a transaction
    // carrying one key twice, so refusing here changes only who gets blamed:
    // the caller that built the day, rather than the table.
    ddbMock.on(TransactWriteCommand).resolves({});

    const rejection = adapter().putArchiveDay(DAY, [
      archiveReading(firstHour),
      archiveReading(secondHour),
      archiveReading(firstHour),
    ]);

    await expect(rejection).rejects.toThrow(
      `putArchiveDay: two items share the key ${firstHour} — the caller must de-duplicate before writing`,
    );
    await expect(rejection).rejects.not.toBeInstanceOf(StorageError);
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it('wraps a failed transaction in a StorageError naming the marker it was writing', async () => {
    const failure = new Error('TransactionCanceledException');
    ddbMock.on(TransactWriteCommand).rejects(failure);

    const error = await captureStorageError(() =>
      adapter().putArchiveDay(DAY, [archiveReading(firstHour)]),
    );

    expect(error.context).toEqual({
      operation: 'putArchiveDay',
      table: TABLE,
      key: { locationId: DUBLIN_ID, sk: `ARCHIVE#DAY#${DAY}` },
    });
    expect(error.cause).toBe(failure);
    // A rejection that is not a capacity cancellation is not re-issued: the
    // wrap is immediate, on the first and only send.
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  /**
   * The 25 items of a location-day share one `locationId` partition by
   * construction, so on-demand's per-partition instantaneous limits can still
   * cancel the transaction for capacity — an edge case now, where
   * until #156 a 50 WCU burst against a 5 WCU ceiling made it the expected shape.
   * DynamoDB cancels the whole transaction and reports the cause per
   * item, where neither the SDK's classifier nor `drainBatches` can see it —
   * on-demand or not. These pin the one layer that can.
   */
  describe('re-issues a transaction DynamoDB cancelled for capacity', () => {
    const oneDay = [archiveReading(firstHour)];

    for (const [name, code] of [
      ['a provisioned table out of write capacity', THROUGHPUT_EXCEEDED],
      ['an on-demand table still scaling up', THROTTLING],
    ] as const) {
      it(`re-sends the identical items after ${name}`, async () => {
        ddbMock
          .on(TransactWriteCommand)
          .rejectsOnce(transactionCancelled(code, NO_REASON))
          .resolves({});

        await expect(adapter().putArchiveDay(DAY, oneDay)).resolves.toBeUndefined();

        const inputs = transactInputs();
        expect(inputs).toHaveLength(2);
        const [first, second] = inputs;
        // The same day, not a rebuilt or trimmed one: a cancelled transaction
        // wrote nothing, so the second send must ask for everything again.
        expect(second).toEqual(first);
      });
    }

    it('gives up after the policy’s attempts and surfaces the last cancellation', async () => {
      const cancellation = transactionCancelled(THROUGHPUT_EXCEEDED, NO_REASON);
      ddbMock.on(TransactWriteCommand).rejects(cancellation);

      const error = await captureStorageError(() => adapter().putArchiveDay(DAY, oneDay));

      expect(error.context).toEqual({
        operation: 'putArchiveDay',
        table: TABLE,
        key: { locationId: DUBLIN_ID, sk: `ARCHIVE#DAY#${DAY}` },
      });
      expect(error.cause).toBe(cancellation);
      // Bounded by the injected policy — the loop cannot outlive it, and a
      // sustained throttle becomes an outage the operator sees rather than a
      // request that never ends.
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(instantPolicy.maxAttempts);
    });

    it('honours the shipped batch policy when none is injected', async () => {
      // No `batchPolicy` in the deps, and so the only test on this path that
      // lets `realSleep` actually run: every case above injects an instant
      // sleep, which would leave the shipped curve — the one production spends
      // — proven by nothing (`docs/standards/testing.md` rule 7).
      ddbMock
        .on(TransactWriteCommand)
        .rejects(transactionCancelled(THROUGHPUT_EXCEEDED, NO_REASON));

      const started = Date.now();
      const error = await captureStorageError(() => shippedAdapter().putArchiveDay(DAY, oneDay));

      expect(error.context.operation).toBe('putArchiveDay');
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(3);
      // Two full-jitter sleeps at the shipped 200 ms base cap at 200 + 400 ms,
      // so the whole refusal fits inside a second of wall clock — the bound is
      // loose because jitter is random, and tight enough that a policy that
      // stopped injecting would blow it.
      expect(Date.now() - started).toBeLessThan(2000);
    });
  });

  it('refuses a policy that could never send, instead of reporting a silent success', async () => {
    // A `maxAttempts` below 1 makes the re-issue loop run zero iterations, and
    // a loop that runs zero iterations does not fail — it falls out and the
    // day is reported written without a single byte leaving the process. That
    // is the shape the guard exists to make loud; `drainBatches` refuses the
    // identical policy, so the two paths in this adapter answer alike.
    ddbMock.on(TransactWriteCommand).resolves({});

    const rejection = adapterWithPolicy({ ...instantPolicy, maxAttempts: 0 }).putArchiveDay(DAY, [
      archiveReading(firstHour),
    ]);

    await expect(rejection).rejects.toThrow(/maxAttempts must be a positive integer/);
    // A plain error, which is the half that the hoist buys: the same policy
    // reaching `drainBatches` inside a wrap would arrive as a `StorageError`
    // blaming the table. The other three batch entry points now answer alike.
    await expect(rejection).rejects.not.toBeInstanceOf(StorageError);
    expect(ddbMock.calls()).toHaveLength(0);
  });

  /**
   * The negative controls, and they are the only tests that can do this job:
   * every case above would stay green if the classification *widened*, so only
   * cancellations the adapter must refuse prove that either clause bites.
   *
   * - **No reason names capacity.** An all-`None` cancellation says the
   *   transaction was cancelled and nothing more; re-sending on it is a guess
   *   about a cause we were never told.
   * - **A conflict travels with the capacity code.** A concurrent writer on
   *   these rows has no retry owner on this path (#166) — two backfills of the
   *   same location-day are an operator mistake, not a throttle — so the mix
   *   stays an outage rather than becoming a blind re-send.
   */
  describe('re-issues nothing when capacity is not the whole story', () => {
    const oneDay = [archiveReading(firstHour)];

    for (const [name, codes] of [
      ['no reason names capacity', [NO_REASON, NO_REASON]],
      [
        'a conflict travels with the capacity code',
        [THROUGHPUT_EXCEEDED, TRANSACTION_CONFLICT, NO_REASON],
      ],
    ] as const) {
      it(`surfaces a StorageError on one send when ${name}`, async () => {
        ddbMock.on(TransactWriteCommand).rejects(transactionCancelled(...codes));

        const error = await captureStorageError(() => adapter().putArchiveDay(DAY, oneDay));

        expect(error.context.operation).toBe('putArchiveDay');
        expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
      });
    }
  });
});
