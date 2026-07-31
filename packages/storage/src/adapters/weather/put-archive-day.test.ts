import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { captureStorageError } from '../storage-error-capture';

import type { WeatherAdapter } from './weather-adapter';
import {
  CORK,
  DUBLIN_ID,
  TABLE,
  adapter,
  archiveReading,
  ddbMock,
  hourlyFrom,
  transactInputs,
  transactedItems,
  writeInputs,
} from './weather-fixtures';

/**
 * The behaviour a partial failure would corrupt most quietly: readings and
 * marker land in one transaction, so a partial fetch can never leave a marker
 * claiming coverage it does not have. Every assertion is on the command input
 * that would reach DynamoDB (`docs/standards/testing.md` rule 3).
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
  });
});
