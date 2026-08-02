import { BatchWriteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { seriesSortKey } from '@cumulo/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { captureStorageError } from '../storage-error-capture';

import {
  SITE_ID,
  TABLE_NAME,
  anyInputHasConsistentRead,
  at,
  forecast,
  generationItem14h,
  generationReading,
  hourlyForecasts,
  instantPolicy,
  interleavedPage,
  mlItem14h,
  mlItem15h,
  mockedAdapter,
  physicsItem14h,
  physicsItem15h,
  writeRequests,
} from './series-fixtures';
import { toForecastItem, toGenerationReadingItem, type SeriesPoint } from './series-item';

/**
 * Contract tests in the sense `docs/standards/testing.md` rule 3 means: every
 * assertion is on a **captured command input** — the exact request this adapter
 * would put on the wire — or on a **fixture response** shaped like DynamoDB's.
 * Nothing here asserts that a mock was called. The serialized-body half of the
 * contract lives in `series-marshalling.test.ts`.
 */

describe('putForecasts', () => {
  it('writes each forecast as a PutRequest carrying its sort key and TTL', async () => {
    const { adapter, ddb } = mockedAdapter();
    ddb.on(BatchWriteCommand).resolves({});

    const outcome = await adapter.putForecasts([forecast(), forecast({ model: 'ml' })]);

    expect(outcome).toEqual({ status: 'complete' });
    expect(writeRequests(ddb)).toEqual([
      [toForecastItem(forecast()), toForecastItem(forecast({ model: 'ml' }))],
    ]);
  });

  it('chunks 60 forecasts into DynamoDB-sized batches of at most 25', async () => {
    const { adapter, ddb } = mockedAdapter();
    ddb.on(BatchWriteCommand).resolves({});

    await adapter.putForecasts(hourlyForecasts(60));

    expect(writeRequests(ddb).map((batch) => batch.length)).toEqual([25, 25, 10]);
  });

  it('never reports a 200 with UnprocessedItems as a clean run', async () => {
    const unprocessed = [
      { PutRequest: { Item: toForecastItem(forecast()) } },
      { PutRequest: { Item: toForecastItem(forecast({ model: 'ml' })) } },
    ];
    const delays: number[] = [];
    const { adapter, ddb } = mockedAdapter(instantPolicy(delays));
    // Every send declines the same two requests, for ever.
    ddb.on(BatchWriteCommand).resolves({ UnprocessedItems: { [TABLE_NAME]: unprocessed } });

    const outcome = await adapter.putForecasts(hourlyForecasts(30));

    // Two batches (25 + 5), each retried to its three-attempt limit, each
    // leaving the same two requests behind: four writes that did not land.
    expect(outcome).toEqual({ status: 'partial', unprocessedCount: 4 });
    expect(ddb.commandCalls(BatchWriteCommand)).toHaveLength(6);
    expect(delays).toHaveLength(4);
  });

  it('reports complete once a retry drains the leftovers', async () => {
    const { adapter, ddb } = mockedAdapter(instantPolicy([]));
    ddb
      .on(BatchWriteCommand)
      .resolvesOnce({
        UnprocessedItems: { [TABLE_NAME]: [{ PutRequest: { Item: toForecastItem(forecast()) } }] },
      })
      .resolves({});

    expect(await adapter.putForecasts([forecast()])).toEqual({ status: 'complete' });
    expect(ddb.commandCalls(BatchWriteCommand)).toHaveLength(2);
  });

  it('sends nothing when there is nothing to write', async () => {
    const { adapter, ddb } = mockedAdapter();

    expect(await adapter.putForecasts([])).toEqual({ status: 'complete' });
    expect(ddb.calls()).toHaveLength(0);
  });

  it('wraps an SDK rejection in a StorageError naming the operation and table', async () => {
    const cause = new Error('connection reset');
    const { adapter, ddb } = mockedAdapter(instantPolicy([]));
    ddb.on(BatchWriteCommand).rejects(cause);

    const error = await captureStorageError(() => adapter.putForecasts([forecast()]));

    expect(error.context).toEqual({ operation: 'putForecasts', table: TABLE_NAME });
    expect(error.cause).toBe(cause);
  });
});

describe('putGenerationReadings', () => {
  it('writes each reading as a PutRequest with the GEN sort key', async () => {
    const { adapter, ddb } = mockedAdapter();
    ddb.on(BatchWriteCommand).resolves({});

    const outcome = await adapter.putGenerationReadings([generationReading()]);

    expect(outcome).toEqual({ status: 'complete' });
    expect(writeRequests(ddb)).toEqual([[toGenerationReadingItem(generationReading())]]);
  });
});

/**
 * One point as `<validTime> <kind>`, so an expectation reads as the window a
 * caller would plot rather than as five object literals.
 */
const pointLabel = (point: SeriesPoint): string =>
  point.type === 'forecast'
    ? `${point.forecast.validTime} forecast/${point.forecast.model}`
    : `${point.reading.validTime} generation`;

describe('querySeriesRange', () => {
  it('pins the half-open window as a BETWEEN over bare time bounds', async () => {
    const { adapter, ddb } = mockedAdapter();
    ddb.on(QueryCommand).resolves({ Items: [] });

    await adapter.querySeriesRange(SITE_ID, at('2026-07-30T00:00:00Z'), at('2026-07-31T00:00:00Z'));

    const [call] = ddb.commandCalls(QueryCommand);
    expect(call?.args[0].input).toEqual({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'siteId = :siteId AND sk BETWEEN :from AND :to',
      ExpressionAttributeValues: {
        ':siteId': SITE_ID,
        ':from': 'T#2026-07-30T00:00:00Z',
        ':to': 'T#2026-07-31T00:00:00Z',
      },
      ScanIndexForward: true,
    });
  });

  it('emits bounds that exclude the end instant and include the start one', async () => {
    // The half-open semantics are a property of the bounds this adapter emits,
    // so they are asserted against the *captured* bounds rather than against a
    // restatement of them: an item at `to` sorts strictly after the upper bound,
    // an item at `from` sorts at or after the lower one.
    const fromInclusive = at('2026-07-30T00:00:00Z');
    const toExclusive = at('2026-07-31T00:00:00Z');
    const { adapter, ddb } = mockedAdapter();
    ddb.on(QueryCommand).resolves({ Items: [] });

    await adapter.querySeriesRange(SITE_ID, fromInclusive, toExclusive);

    const values = ddb.commandCalls(QueryCommand)[0]?.args[0].input.ExpressionAttributeValues;
    const lower = z.string().parse(values?.[':from']);
    const upper = z.string().parse(values?.[':to']);

    for (const kind of [
      { kind: 'generation' } as const,
      { kind: 'forecast', model: 'ml' } as const,
    ]) {
      expect(seriesSortKey(toExclusive, kind) > upper).toBe(true);
      expect(seriesSortKey(fromInclusive, kind) >= lower).toBe(true);
    }
  });

  it('returns an interleaved page as correctly tagged points, in server order', async () => {
    const { adapter, ddb } = mockedAdapter();
    ddb.on(QueryCommand).resolves({ Items: interleavedPage });

    const { points } = await adapter.querySeriesRange(
      SITE_ID,
      at('2026-07-30T14:00:00Z'),
      at('2026-07-30T16:00:00Z'),
    );

    expect(points.map(pointLabel)).toEqual([
      '2026-07-30T14:00:00Z forecast/ml',
      '2026-07-30T14:00:00Z forecast/physics',
      '2026-07-30T14:00:00Z generation',
      '2026-07-30T15:00:00Z forecast/ml',
      '2026-07-30T15:00:00Z forecast/physics',
    ]);
    expect(points[2]).toEqual({ type: 'generation', reading: generationReading() });
  });

  it('follows LastEvaluatedKey rather than returning a prefix of the window', async () => {
    const lastEvaluatedKey = { siteId: SITE_ID, sk: generationItem14h.sk };
    const { adapter, ddb } = mockedAdapter();
    ddb
      .on(QueryCommand)
      .resolvesOnce({
        Items: [mlItem14h, physicsItem14h, generationItem14h],
        LastEvaluatedKey: lastEvaluatedKey,
      })
      .resolves({ Items: [mlItem15h, physicsItem15h] });

    const { points } = await adapter.querySeriesRange(
      SITE_ID,
      at('2026-07-30T14:00:00Z'),
      at('2026-07-30T16:00:00Z'),
    );

    expect(points).toHaveLength(5);
    expect(ddb.commandCalls(QueryCommand)[1]?.args[0].input.ExclusiveStartKey).toEqual(
      lastEvaluatedKey,
    );
  });

  it('surfaces a rejected Query as a StorageError naming the site', async () => {
    const cause = new Error('throttled beyond the retry budget');
    const { adapter, ddb } = mockedAdapter();
    ddb.on(QueryCommand).rejects(cause);

    const error = await captureStorageError(() =>
      adapter.querySeriesRange(SITE_ID, at('2026-07-30T00:00:00Z'), at('2026-07-31T00:00:00Z')),
    );

    expect(error.context).toEqual({
      operation: 'querySeriesRange',
      table: TABLE_NAME,
      key: { siteId: SITE_ID },
    });
    expect(error.cause).toBe(cause);
  });
});

/**
 * A window DynamoDB hands back in three pages: two that continue and a third
 * that ends. Three rather than two on purpose — with two pages, "stopped at the
 * bound" and "the table ran out" produce the same send count, so only a third
 * page distinguishes a drain that was cut short from one that finished.
 */
const pagedWindow = () => {
  const { adapter, ddb } = mockedAdapter();
  ddb
    .on(QueryCommand)
    .resolvesOnce({
      Items: [mlItem14h, physicsItem14h],
      LastEvaluatedKey: { siteId: SITE_ID, sk: physicsItem14h.sk },
    })
    .resolvesOnce({
      Items: [generationItem14h],
      LastEvaluatedKey: { siteId: SITE_ID, sk: generationItem14h.sk },
    })
    .resolves({ Items: [mlItem15h, physicsItem15h] });

  return { adapter, ddb };
};

const PAGED_FROM = at('2026-07-30T14:00:00Z');
const PAGED_TO = at('2026-07-30T16:00:00Z');

/** Every label the three pages hold, in server order. */
const WHOLE_WINDOW = [
  '2026-07-30T14:00:00Z forecast/ml',
  '2026-07-30T14:00:00Z forecast/physics',
  '2026-07-30T14:00:00Z generation',
  '2026-07-30T15:00:00Z forecast/ml',
  '2026-07-30T15:00:00Z forecast/physics',
];

describe('querySeriesRange under a pagination bound', () => {
  it('drains every page and reports the window complete when no bound is passed', async () => {
    const { adapter, ddb } = pagedWindow();

    const { points, complete } = await adapter.querySeriesRange(SITE_ID, PAGED_FROM, PAGED_TO);

    expect(ddb.commandCalls(QueryCommand)).toHaveLength(3);
    expect(points.map(pointLabel)).toEqual(WHOLE_WINDOW);
    expect(complete).toBe(true);
  });

  it('returns the first page alone, marked incomplete, when the bound refuses to continue', async () => {
    const { adapter, ddb } = pagedWindow();

    const { points, complete } = await adapter.querySeriesRange(SITE_ID, PAGED_FROM, PAGED_TO, {
      hasBudgetForNextPage: () => false,
    });

    // The refusal lands *between* pages: the page already on the wire is still
    // awaited and its items still returned, and `complete` is what says the two
    // pages behind it were never read.
    expect(ddb.commandCalls(QueryCommand)).toHaveLength(1);
    expect(points.map(pointLabel)).toEqual(WHOLE_WINDOW.slice(0, 2));
    expect(complete).toBe(false);
  });

  it('is indistinguishable from an unbounded read when the bound always permits', async () => {
    const { adapter, ddb } = pagedWindow();
    let asked = 0;

    const { points, complete } = await adapter.querySeriesRange(SITE_ID, PAGED_FROM, PAGED_TO, {
      hasBudgetForNextPage: () => {
        asked += 1;
        return true;
      },
    });

    expect(ddb.commandCalls(QueryCommand)).toHaveLength(3);
    expect(points.map(pointLabel)).toEqual(WHOLE_WINDOW);
    expect(complete).toBe(true);
    // Twice, not three times: the first page is never subject to the bound, and
    // the last page ends the drain before anything is asked about a fourth.
    expect(asked).toBe(2);
  });
});

describe('querySeriesFrom', () => {
  it('asks for an ascending, limited run at or after the instant', async () => {
    const { adapter, ddb } = mockedAdapter();
    ddb.on(QueryCommand).resolves({ Items: [] });

    await adapter.querySeriesFrom(SITE_ID, at('2026-07-30T14:00:00Z'), 6);

    const [call] = ddb.commandCalls(QueryCommand);
    expect(call?.args[0].input).toEqual({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'siteId = :siteId AND sk >= :from',
      ExpressionAttributeValues: { ':siteId': SITE_ID, ':from': 'T#2026-07-30T14:00:00Z' },
      ScanIndexForward: true,
      Limit: 6,
    });
  });

  it('keeps paging until the limit is filled, asking only for what is missing', async () => {
    const lastEvaluatedKey = { siteId: SITE_ID, sk: physicsItem14h.sk };
    const { adapter, ddb } = mockedAdapter();
    ddb
      .on(QueryCommand)
      .resolvesOnce({ Items: [mlItem14h, physicsItem14h], LastEvaluatedKey: lastEvaluatedKey })
      .resolves({ Items: [generationItem14h, mlItem15h] });

    const points = await adapter.querySeriesFrom(SITE_ID, at('2026-07-30T14:00:00Z'), 4);

    expect(points).toHaveLength(4);
    expect(ddb.commandCalls(QueryCommand).map((call) => call.args[0].input.Limit)).toEqual([4, 2]);
  });

  it('stops when the table runs out, even short of the limit', async () => {
    const { adapter, ddb } = mockedAdapter();
    ddb.on(QueryCommand).resolves({ Items: [generationItem14h] });

    expect(await adapter.querySeriesFrom(SITE_ID, at('2026-07-30T14:00:00Z'), 10)).toHaveLength(1);
    expect(ddb.commandCalls(QueryCommand)).toHaveLength(1);
  });

  it('rejects a limit DynamoDB would refuse, before any call is made', async () => {
    const { adapter, ddb } = mockedAdapter();

    await expect(adapter.querySeriesFrom(SITE_ID, at('2026-07-30T14:00:00Z'), 0)).rejects.toThrow(
      /limit must be a positive integer/,
    );
    await expect(adapter.querySeriesFrom(SITE_ID, at('2026-07-30T14:00:00Z'), 2.5)).rejects.toThrow(
      /limit must be a positive integer/,
    );
    expect(ddb.calls()).toHaveLength(0);
  });
});

describe('read consistency', () => {
  it('never sets ConsistentRead on any command it sends', async () => {
    // ADR 0002 Consequence 3: the 21 RCU on `series` were sized against Query's
    // default eventually-consistent reads, and a strongly-consistent read costs
    // double. This asserts across every operation, not just the query ones.
    const { adapter, ddb } = mockedAdapter();
    ddb.on(BatchWriteCommand).resolves({});
    ddb.on(QueryCommand).resolves({ Items: [physicsItem14h] });

    await adapter.putForecasts([forecast()]);
    await adapter.putGenerationReadings([generationReading()]);
    await adapter.querySeriesRange(SITE_ID, at('2026-07-30T00:00:00Z'), at('2026-07-31T00:00:00Z'));
    await adapter.querySeriesFrom(SITE_ID, at('2026-07-30T00:00:00Z'), 3);

    expect(ddb.calls()).toHaveLength(4);
    expect(anyInputHasConsistentRead(ddb)).toBe(false);
  });
});
