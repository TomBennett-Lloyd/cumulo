import { QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { archiveDayMarkerSortKey, weatherSortKey } from '@cumulo/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { StorageError } from '../../errors';
import { captureStorageError } from '../storage-error-capture';

import {
  DUBLIN,
  DUBLIN_ID,
  TABLE,
  adapter,
  archiveReading,
  at,
  ddbMock,
  hourlyFrom,
  queryInputs,
  transactInputs,
  transactedItems,
  type Item,
} from './weather-fixtures';

/**
 * Reading the archive back (access pattern H1), and the sort-key ordering the
 * range bounds rest on. The ordering assertions are plain string comparisons
 * with no AWS involved — DynamoDB orders sort keys by their bytes, which for
 * these ASCII keys is exactly JavaScript's string comparison.
 */

const FROM = at('2026-02-10T00:00:00Z');
const TO = at('2026-02-11T00:00:00Z');

beforeEach(() => {
  ddbMock.reset();
});

afterAll(() => {
  ddbMock.restore();
});

describe('archive sort-key ordering', () => {
  // These are the properties the BETWEEN bounds in `queryArchiveRange` rely on,
  // pinned where a reader can check them (C1 pins the same ordering in
  // `@cumulo/shared`).
  const sortsBefore = (lower: string, higher: string): boolean => lower < higher;

  it('sorts day markers below every archive reading, so a range query excludes them', () => {
    const lowerBound = weatherSortKey('archive', FROM);
    expect(sortsBefore(archiveDayMarkerSortKey('2026-02-10'), lowerBound)).toBe(true);
    expect(sortsBefore(archiveDayMarkerSortKey('2026-02-11'), lowerBound)).toBe(true);
  });

  it('sorts forecast weather above every archive reading, so a range query excludes it', () => {
    expect(sortsBefore(weatherSortKey('archive', TO), weatherSortKey('forecast', FROM))).toBe(true);
  });
});

/**
 * The stored item for one hour, captured from what `putArchiveDay` would
 * actually write. Reading fixtures back out of the write path is what makes the
 * round-trip test below a round trip rather than two hand-written shapes that
 * agree with each other and with nothing else.
 */
const storedItem = async (validTime: string): Promise<Item> => {
  ddbMock.reset();
  ddbMock.on(TransactWriteCommand).resolves({});
  await adapter().putArchiveDay(validTime.slice(0, 10), [archiveReading(validTime)]);
  const [input] = transactInputs();
  if (input === undefined) {
    throw new Error('expected one TransactWriteCommand');
  }
  const [item] = transactedItems(input);
  if (item === undefined) {
    throw new Error('expected the transaction to carry a reading item');
  }
  ddbMock.reset();
  return item;
};

const storedItems = async (validTimes: readonly string[]): Promise<Item[]> => {
  const items: Item[] = [];
  for (const validTime of validTimes) {
    items.push(await storedItem(validTime));
  }
  return items;
};

describe('queryArchiveRange', () => {
  it('bounds the query on the archive run for one location, eventually consistently', async () => {
    ddbMock.on(QueryCommand).resolves({});

    await adapter().queryArchiveRange(DUBLIN, FROM, TO);

    const [input] = queryInputs();
    expect(input?.KeyConditionExpression).toBe(
      'locationId = :locationId AND sk BETWEEN :from AND :to',
    );
    expect(input?.ExpressionAttributeValues).toEqual({
      ':locationId': DUBLIN_ID,
      ':from': `ARCHIVE#T#${FROM}`,
      ':to': `ARCHIVE#T#${TO}`,
    });
    expect(Object.keys(input ?? {})).not.toContain('ConsistentRead');
  });

  it('asks the same question for 180°E and 180°W', async () => {
    ddbMock.on(QueryCommand).resolves({});

    await adapter().queryArchiveRange({ latitude: -16.5, longitude: 180 }, FROM, TO);
    await adapter().queryArchiveRange({ latitude: -16.5, longitude: -180 }, FROM, TO);

    const [east, west] = queryInputs();
    expect(east).toEqual(west);
    expect(east?.ExpressionAttributeValues?.[':locationId']).toBe('-16.50,-180.00');
  });

  it('round-trips a stored item back into the reading that produced it', async () => {
    const reading = archiveReading('2026-02-10T06:00:00Z');
    const items = await storedItems(['2026-02-10T06:00:00Z']);
    ddbMock.on(QueryCommand).resolves({ Items: items });

    expect(await adapter().queryArchiveRange(DUBLIN, FROM, TO)).toEqual([reading]);
  });

  it('includes the reading at the start of the window and excludes the one at its end', async () => {
    // BETWEEN is closed at both ends, so the endpoint exclusion that makes the
    // window half-open happens after the read.
    const items = await storedItems([FROM, '2026-02-10T12:00:00Z', TO]);
    ddbMock.on(QueryCommand).resolves({ Items: items });

    const readings = await adapter().queryArchiveRange(DUBLIN, FROM, TO);

    expect(readings.map((reading) => reading.validTime)).toEqual([FROM, '2026-02-10T12:00:00Z']);
  });

  it('follows pagination and preserves the order DynamoDB returned', async () => {
    const items = await storedItems(hourlyFrom('2026-02-10T00:00:00Z', 4));
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({
        Items: items.slice(0, 2),
        LastEvaluatedKey: { locationId: DUBLIN_ID, sk: 'x' },
      })
      .resolves({ Items: items.slice(2) });

    const readings = await adapter().queryArchiveRange(DUBLIN, FROM, TO);

    expect(readings.map((reading) => reading.validTime)).toEqual(hourlyFrom(FROM, 4));
    expect(queryInputs()).toHaveLength(2);
    expect(queryInputs()[0]?.ExclusiveStartKey).toBeUndefined();
    expect(queryInputs()[1]?.ExclusiveStartKey).toEqual({ locationId: DUBLIN_ID, sk: 'x' });
  });

  it('refuses a window that ends before it starts, rather than letting DynamoDB reject it', async () => {
    ddbMock.on(QueryCommand).resolves({});

    await expect(adapter().queryArchiveRange(DUBLIN, TO, FROM)).rejects.toThrow(/before it starts/);
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it('fails loudly, and not as an outage, on an item it did not write', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ locationId: DUBLIN_ID, sk: `ARCHIVE#T#${FROM}`, kind: 'archive' }],
    });

    const failure = await adapter()
      .queryArchiveRange(DUBLIN, FROM, TO)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(z.ZodError);
    expect(failure).not.toBeInstanceOf(StorageError);
  });

  it('wraps a rejected query in a StorageError naming the location', async () => {
    const failure = new Error('ResourceNotFoundException');
    ddbMock.on(QueryCommand).rejects(failure);

    const error = await captureStorageError(() => adapter().queryArchiveRange(DUBLIN, FROM, TO));

    expect(error.context).toEqual({
      operation: 'queryArchiveRange',
      table: TABLE,
      key: { locationId: DUBLIN_ID },
    });
    expect(error.cause).toBe(failure);
  });
});
