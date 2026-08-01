import { BatchWriteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';

import { captureStorageError } from '../storage-error-capture';

import {
  SITE_ID,
  TABLE_NAME,
  deleteRequestKeys,
  hourlyForecasts,
  instantPolicy,
  mockedAdapter,
} from './series-fixtures';
import { toForecastItem } from './series-item';

/**
 * X3: removing an evicted site's series. DynamoDB has no range delete, so the
 * keys have to be listed and then deleted — and both halves have a way of
 * lying. The Query pages at 1 MB, so a caller that ignored `LastEvaluatedKey`
 * would leave a tail behind; `BatchWriteItem` answers 200 while declining
 * items, so a caller that ignored `UnprocessedItems` would report a cleanup it
 * did not do. These tests are about both.
 *
 * Contract tests per `docs/standards/testing.md` rule 3 — assertions are on the
 * command input that would reach DynamoDB, or on the outcome derived from a
 * DynamoDB-shaped response.
 */

/** What the projected Query hands back: the two key attributes and nothing else. */
const projectedKeys = (count: number): Record<string, string>[] =>
  hourlyForecasts(count).map((point) => {
    const { siteId, sk } = toForecastItem(point);
    return { siteId, sk };
  });

describe('deleteSiteSeries', () => {
  it('lists the partition projecting keys alone, then deletes what it found', async () => {
    const { adapter, ddb } = mockedAdapter();
    ddb.on(QueryCommand).resolves({ Items: projectedKeys(2) });
    ddb.on(BatchWriteCommand).resolves({});

    const outcome = await adapter.deleteSiteSeries(SITE_ID);

    expect(outcome).toEqual({ status: 'complete' });
    expect(ddb.commandCalls(QueryCommand)[0]?.args[0].input).toEqual({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'siteId = :siteId',
      ExpressionAttributeValues: { ':siteId': SITE_ID },
      // Only the keys: the item bodies would be read capacity spent on data
      // that is about to be deleted.
      ProjectionExpression: 'siteId, sk',
    });
    expect(deleteRequestKeys(ddb)).toEqual([projectedKeys(2)]);
  });

  it('deletes every page of a partition, not just the first', async () => {
    const lastEvaluatedKey = { siteId: SITE_ID, sk: 'T#2026-07-30T00:00:00Z#FC#physics' };
    const { adapter, ddb } = mockedAdapter();
    ddb
      .on(QueryCommand)
      .resolvesOnce({ Items: projectedKeys(1), LastEvaluatedKey: lastEvaluatedKey })
      .resolves({ Items: projectedKeys(2).slice(1) });
    ddb.on(BatchWriteCommand).resolves({});

    await adapter.deleteSiteSeries(SITE_ID);

    expect(ddb.commandCalls(QueryCommand)[1]?.args[0].input.ExclusiveStartKey).toEqual(
      lastEvaluatedKey,
    );
    expect(deleteRequestKeys(ddb).flat()).toHaveLength(2);
  });

  it('splits a full site partition into DynamoDB-sized batches', async () => {
    // ~97 points is what an evicted site actually holds: four days of hourly
    // forecasts is already past one batch, so the chunking is not incidental.
    const { adapter, ddb } = mockedAdapter();
    ddb.on(QueryCommand).resolves({ Items: projectedKeys(97) });
    ddb.on(BatchWriteCommand).resolves({});

    await adapter.deleteSiteSeries(SITE_ID);

    expect(deleteRequestKeys(ddb).map((batch) => batch.length)).toEqual([25, 25, 25, 22]);
  });

  it('reports a drain that never finished rather than claiming a clean sweep', async () => {
    const unprocessed = [{ DeleteRequest: { Key: projectedKeys(1)[0] ?? {} } }];
    const { adapter, ddb } = mockedAdapter(instantPolicy([]));
    ddb.on(QueryCommand).resolves({ Items: projectedKeys(3) });
    ddb.on(BatchWriteCommand).resolves({ UnprocessedItems: { [TABLE_NAME]: unprocessed } });

    expect(await adapter.deleteSiteSeries(SITE_ID)).toEqual({
      status: 'partial',
      unprocessedCount: 1,
    });
  });

  it('sends no write at all for a site that has no series yet', async () => {
    const { adapter, ddb } = mockedAdapter();
    ddb.on(QueryCommand).resolves({});

    expect(await adapter.deleteSiteSeries(SITE_ID)).toEqual({ status: 'complete' });
    expect(ddb.commandCalls(BatchWriteCommand)).toHaveLength(0);
  });

  it('refuses a projected item missing a key, rather than deleting an undefined key', async () => {
    const { adapter, ddb } = mockedAdapter();
    ddb.on(QueryCommand).resolves({ Items: [{ siteId: SITE_ID }] });
    ddb.on(BatchWriteCommand).resolves({});

    await expect(adapter.deleteSiteSeries(SITE_ID)).rejects.toThrow();
    expect(ddb.commandCalls(BatchWriteCommand)).toHaveLength(0);
  });

  it('names itself when the listing half fails', async () => {
    const cause = new Error('throttled beyond the retry budget');
    const { adapter, ddb } = mockedAdapter();
    ddb.on(QueryCommand).rejects(cause);

    const error = await captureStorageError(() => adapter.deleteSiteSeries(SITE_ID));

    expect(error.context).toEqual({
      operation: 'deleteSiteSeries',
      table: TABLE_NAME,
      key: { siteId: SITE_ID },
    });
    expect(error.cause).toBe(cause);
  });
});
