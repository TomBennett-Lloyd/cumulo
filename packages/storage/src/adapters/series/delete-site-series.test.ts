import { BatchWriteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';

import { captureStorageError } from '../storage-error-capture';

import {
  SITE_ID,
  TABLE_NAME,
  deleteRequestKeys,
  hourlyForecasts,
  mockedAdapter,
} from './series-fixtures';
import { toForecastItem } from './series-item';

/**
 * X3: removing a departed site's series, under a caller-stated budget.
 *
 * Two things have a way of lying here and the tests are about both. The listing
 * Query stops at `Limit` or at 1 MB and says so only through
 * `LastEvaluatedKey`, so a caller that ignored it would report a partition
 * emptied when it was merely sampled; and `BatchWriteItem` answers 200 while
 * declining items, so a caller that ignored `UnprocessedItems` would report a
 * cleanup it did not do. The outcome carries both facts separately because
 * they mean different things to an operator — arithmetic versus capacity.
 *
 * The budget itself is not this adapter's decision. It is derived from the API
 * function timeout in `apps/api/src/request-budget.ts`; here it is just a
 * number the caller states, and these tests pin that the adapter obeys it.
 *
 * Contract tests per `docs/standards/testing.md` rule 3 — assertions are on the
 * command input that would reach DynamoDB, or on the outcome derived from a
 * DynamoDB-shaped response.
 */

const BUDGET = 25;

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

    const outcome = await adapter.deleteSiteSeries(SITE_ID, BUDGET);

    expect(outcome).toEqual({ deletedCount: 2, declinedCount: 0, budgetReached: false });
    expect(ddb.commandCalls(QueryCommand)[0]?.args[0].input).toEqual({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'siteId = :siteId',
      ExpressionAttributeValues: { ':siteId': SITE_ID },
      // Only the keys: the item bodies would be read capacity spent on data
      // that is about to be deleted.
      ProjectionExpression: 'siteId, sk',
      // Newest first — those rows have the longest left to live under the TTL,
      // so a bounded pass reclaims the most by taking them.
      ScanIndexForward: false,
      Limit: BUDGET,
    });
    expect(deleteRequestKeys(ddb)).toEqual([projectedKeys(2)]);
  });

  it('makes exactly one listing request, however much the partition holds', async () => {
    // The bound that matters: the old unbounded version walked every page of a
    // partition that reaches thousands of rows, and did it after the caller's
    // write had already committed.
    const { adapter, ddb } = mockedAdapter();
    ddb.on(QueryCommand).resolves({
      Items: projectedKeys(BUDGET),
      LastEvaluatedKey: { siteId: SITE_ID, sk: 'T#2026-07-30T00:00:00Z#FC#physics' },
    });
    ddb.on(BatchWriteCommand).resolves({});

    await adapter.deleteSiteSeries(SITE_ID, BUDGET);

    expect(ddb.commandCalls(QueryCommand)).toHaveLength(1);
  });

  it('reports hitting its budget rather than claiming the partition is clean', async () => {
    const { adapter, ddb } = mockedAdapter();
    ddb.on(QueryCommand).resolves({
      Items: projectedKeys(BUDGET),
      LastEvaluatedKey: { siteId: SITE_ID, sk: 'T#2026-07-30T00:00:00Z#FC#physics' },
    });
    ddb.on(BatchWriteCommand).resolves({});

    expect(await adapter.deleteSiteSeries(SITE_ID, BUDGET)).toEqual({
      deletedCount: BUDGET,
      declinedCount: 0,
      budgetReached: true,
    });
  });

  it('never sends more than one batch of deletes', async () => {
    // A budget is only a budget if the drain honours it: at one batch's worth
    // of keys there is exactly one round trip, so the pass costs the two
    // DynamoDB requests it was priced at.
    const { adapter, ddb } = mockedAdapter();
    ddb.on(QueryCommand).resolves({ Items: projectedKeys(BUDGET) });
    ddb.on(BatchWriteCommand).resolves({});

    await adapter.deleteSiteSeries(SITE_ID, BUDGET);

    expect(deleteRequestKeys(ddb).map((batch) => batch.length)).toEqual([BUDGET]);
  });

  it('re-sends nothing that DynamoDB declined, and counts it instead', async () => {
    // Deletes that bounce mean the table is out of write capacity. Re-sending
    // would spend the capacity the ingestion cycle needs, to bring forward a
    // deletion the TTL performs for free.
    const unprocessed = [{ DeleteRequest: { Key: projectedKeys(1)[0] ?? {} } }];
    const { adapter, ddb } = mockedAdapter();
    ddb.on(QueryCommand).resolves({ Items: projectedKeys(3) });
    ddb.on(BatchWriteCommand).resolves({ UnprocessedItems: { [TABLE_NAME]: unprocessed } });

    expect(await adapter.deleteSiteSeries(SITE_ID, BUDGET)).toEqual({
      deletedCount: 2,
      declinedCount: 1,
      budgetReached: false,
    });
    expect(ddb.commandCalls(BatchWriteCommand)).toHaveLength(1);
  });

  it('sends no write at all for a site that has no series yet', async () => {
    const { adapter, ddb } = mockedAdapter();
    ddb.on(QueryCommand).resolves({});

    expect(await adapter.deleteSiteSeries(SITE_ID, BUDGET)).toEqual({
      deletedCount: 0,
      declinedCount: 0,
      budgetReached: false,
    });
    expect(ddb.commandCalls(BatchWriteCommand)).toHaveLength(0);
  });

  it('touches the table not at all when the budget is zero', async () => {
    // Reachable by construction: the budget is derived from the function
    // timeout, and a timeout low enough to price out the delete batch leaves
    // the whole job to the TTL. It must not become a listing nobody deletes.
    const { adapter, ddb } = mockedAdapter();

    expect(await adapter.deleteSiteSeries(SITE_ID, 0)).toEqual({
      deletedCount: 0,
      declinedCount: 0,
      budgetReached: true,
    });
    expect(ddb.calls()).toHaveLength(0);
  });

  it('refuses a budget that is not a whole number of items', async () => {
    const { adapter } = mockedAdapter();

    await expect(adapter.deleteSiteSeries(SITE_ID, -1)).rejects.toThrow('non-negative integer');
  });

  it('refuses a projected item missing a key, rather than deleting an undefined key', async () => {
    const { adapter, ddb } = mockedAdapter();
    ddb.on(QueryCommand).resolves({ Items: [{ siteId: SITE_ID }] });
    ddb.on(BatchWriteCommand).resolves({});

    await expect(adapter.deleteSiteSeries(SITE_ID, BUDGET)).rejects.toThrow();
    expect(ddb.commandCalls(BatchWriteCommand)).toHaveLength(0);
  });

  it('names itself when the listing half fails', async () => {
    const cause = new Error('throttled beyond the retry budget');
    const { adapter, ddb } = mockedAdapter();
    ddb.on(QueryCommand).rejects(cause);

    const error = await captureStorageError(() => adapter.deleteSiteSeries(SITE_ID, BUDGET));

    expect(error.context).toEqual({
      operation: 'deleteSiteSeries',
      table: TABLE_NAME,
      key: { siteId: SITE_ID },
    });
    expect(error.cause).toBe(cause);
  });
});
