import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

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
  archiveReading,
  ddbMock,
  hourlyFrom,
  instantPolicy,
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
 * separately, at the wire, in `client-retry-classification.test.ts` — the two counts are different
 * facts and neither substitutes for the other.
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
   * 25 items ≈ 50 WCU against a table provisioned for 5: DynamoDB cancels the
   * whole transaction and reports the cause per item, where neither the SDK's
   * classifier nor `drainBatches` can see it. These pin the one layer that can.
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
