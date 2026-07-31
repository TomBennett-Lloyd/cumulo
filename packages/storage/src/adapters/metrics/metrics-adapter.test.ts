import { PutCommand, QueryCommand, type PutCommandInput } from '@aws-sdk/lib-dynamodb';
import { metricsSortKey } from '@cumulo/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { StorageError } from '../../errors';
import { captureStorageError } from '../storage-error-capture';

import {
  JULY_30,
  SITE_ID,
  TABLE_NAME,
  adapter,
  ddbMock,
  errorMetrics,
  mlItem,
  physicsItem,
} from './metrics-fixtures';

/**
 * Contract tests in the sense `docs/standards/testing.md` rule 3 means: every
 * assertion is on a **captured command input** — the exact request this adapter
 * would put on the wire — or on the domain value it derives from a **fixture
 * response** shaped like DynamoDB's. Nothing here asserts that a mock was
 * called. The pure key logic is pinned separately, in `metrics-item.test.ts`.
 */

/** The item the adapter actually wrote, as the wire carried it. */
type WrittenItem = NonNullable<PutCommandInput['Item']>;

const writtenItem = (): WrittenItem => {
  const item = ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item;
  if (item === undefined) {
    throw new Error('expected a PutCommand carrying an item');
  }
  return item;
};

beforeEach(() => {
  ddbMock.reset();
});

describe('putMetrics', () => {
  it('writes every domain field under the sort key the row composes', async () => {
    const metrics = errorMetrics();

    await adapter().putMetrics(metrics);

    const [call] = ddbMock.commandCalls(PutCommand);
    expect(call?.args[0].input).toEqual({
      TableName: TABLE_NAME,
      Item: {
        ...metrics,
        sk: metricsSortKey(metrics.period, metrics.model, metrics.baseline),
      },
    });
  });

  it('writes a null skill score as a null, not as an absent attribute', async () => {
    // "No comparison available" is a real state of the world (`metrics.ts`), so
    // it has to survive the table; an omitted attribute would come back as a
    // missing required field and fail the parse on the way out.
    await adapter().putMetrics(errorMetrics({ skillScore: null }));

    expect(writtenItem().skillScore).toBeNull();
  });

  it('wraps a rejected write in a StorageError naming the row it was writing', async () => {
    const cause = new Error('ProvisionedThroughputExceededException');
    ddbMock.on(PutCommand).rejects(cause);

    const error = await captureStorageError(() => adapter().putMetrics(errorMetrics()));

    expect(error.context).toEqual({
      operation: 'putMetrics',
      table: TABLE_NAME,
      key: {
        siteId: SITE_ID,
        sk: '2026-07-30T00:00:00Z#2026-07-31T00:00:00Z#physics#persistence-24h',
      },
    });
    expect(error.cause).toBe(cause);
  });
});

describe('queryMetricsForPeriod', () => {
  it('selects one period with a prefix that stops at the delimiter', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await adapter().queryMetricsForPeriod(SITE_ID, JULY_30);

    const [call] = ddbMock.commandCalls(QueryCommand);
    expect(call?.args[0].input).toEqual({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'siteId = :siteId AND begins_with(sk, :periodPrefix)',
      ExpressionAttributeValues: {
        ':siteId': SITE_ID,
        ':periodPrefix': '2026-07-30T00:00:00Z#2026-07-31T00:00:00Z#',
      },
    });
    // Asserted on the captured value rather than only against the literal
    // above: the trailing separator is what stops the prefix matching into a
    // longer end bound, so it is a property of the request, not a spelling.
    const prefix = z
      .string()
      .parse(call?.args[0].input.ExpressionAttributeValues?.[':periodPrefix']);
    expect(prefix.endsWith('#')).toBe(true);
  });

  it('returns both models for the period as parsed domain values', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [mlItem, physicsItem] });

    const metrics = await adapter().queryMetricsForPeriod(SITE_ID, JULY_30);

    expect(metrics.map((row) => row.model)).toEqual(['ml', 'physics']);
    expect(metrics[1]).toEqual(errorMetrics());
  });

  it('round-trips a written row back into the value that was written', async () => {
    const metrics = errorMetrics({ model: 'ml', skillScore: null });
    await adapter().putMetrics(metrics);
    ddbMock.on(QueryCommand).resolves({ Items: [writtenItem()] });

    expect(await adapter().queryMetricsForPeriod(SITE_ID, JULY_30)).toEqual([metrics]);
  });

  it('follows LastEvaluatedKey rather than returning a prefix of the period', async () => {
    const lastEvaluatedKey = { siteId: SITE_ID, sk: mlItem.sk };
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({ Items: [mlItem], LastEvaluatedKey: lastEvaluatedKey })
      .resolves({ Items: [physicsItem] });

    const metrics = await adapter().queryMetricsForPeriod(SITE_ID, JULY_30);

    expect(metrics.map((row) => row.model)).toEqual(['ml', 'physics']);
    const inputs = ddbMock.commandCalls(QueryCommand).map((call) => call.args[0].input);
    expect(inputs).toHaveLength(2);
    expect(inputs[0]?.ExclusiveStartKey).toBeUndefined();
    expect(inputs[1]?.ExclusiveStartKey).toEqual(lastEvaluatedKey);
  });

  it('fails loudly, and not as an outage, on a row it did not write', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ ...physicsItem, maeKw: -1 }] });

    const failure = await adapter()
      .queryMetricsForPeriod(SITE_ID, JULY_30)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(z.ZodError);
    expect(failure).not.toBeInstanceOf(StorageError);
  });

  it('wraps a rejected query in a StorageError naming the site', async () => {
    const cause = new Error('ResourceNotFoundException');
    ddbMock.on(QueryCommand).rejects(cause);

    const error = await captureStorageError(() =>
      adapter().queryMetricsForPeriod(SITE_ID, JULY_30),
    );

    expect(error.context).toEqual({
      operation: 'queryMetricsForPeriod',
      table: TABLE_NAME,
      key: { siteId: SITE_ID },
    });
    expect(error.cause).toBe(cause);
  });

  it('refuses a period that ends at or before it starts, instead of returning nothing', async () => {
    // `begins_with` on an inverted period is not an error DynamoDB reports — it
    // simply matches nothing, which would read as "this site was never
    // evaluated". A caller that assembled such a window has a bug, so it throws
    // (`docs/standards/error-handling.md` rule 1) before any call is made.
    const empty = { startInclusive: JULY_30.startInclusive, endExclusive: JULY_30.startInclusive };

    await expect(adapter().queryMetricsForPeriod(SITE_ID, empty)).rejects.toThrow(
      /at or before its start/,
    );
    await expect(
      adapter().queryMetricsForPeriod(SITE_ID, {
        startInclusive: JULY_30.endExclusive,
        endExclusive: JULY_30.startInclusive,
      }),
    ).rejects.toThrow(/at or before its start/);
    expect(ddbMock.calls()).toHaveLength(0);
  });
});

describe('read consistency', () => {
  it('never sets ConsistentRead on any command it sends', async () => {
    // ADR 0002 Consequence 3: nothing in this package asks for a strongly
    // consistent read, which costs double. Asserted across every operation.
    ddbMock.on(QueryCommand).resolves({ Items: [physicsItem] });

    await adapter().putMetrics(errorMetrics());
    await adapter().queryMetricsForPeriod(SITE_ID, JULY_30);

    expect(ddbMock.calls()).toHaveLength(2);
    expect(ddbMock.calls().some((call) => 'ConsistentRead' in call.args[0].input)).toBe(false);
  });
});
