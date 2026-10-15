import { BatchWriteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { FLEET_ROLLUP_PARTITION } from '@cumulo/shared';
import { describe, expect, it } from 'vitest';

import {
  TABLE_NAME,
  anyInputHasConsistentRead,
  at,
  mockedAdapter,
  totalItem14h,
  totalItem15h,
  totalPoint14h,
  totalPoint15h,
  writeRequests,
} from './series-fixtures';

/**
 * The `#FLEET` partition's three totals methods, in the contract style of
 * `fleet-rollup-adapter.test.ts`: assertions on captured command inputs, with the half-open bounds
 * written out literally for that file's reason.
 */

const from = at('2026-07-30T14:00:00Z');
const to = at('2026-07-30T16:00:00Z');

const queryInputs = (
  ddb: ReturnType<typeof mockedAdapter>['ddb'],
): Record<string, unknown>[] | undefined =>
  ddb.commandCalls(QueryCommand).map((call) => ({ ...call.args[0].input }));

const BOUNDS = {
  ':siteId': FLEET_ROLLUP_PARTITION,
  ':from': 'GEN#TOTAL#T#2026-07-30T14:00:00Z',
  ':to': 'GEN#TOTAL#T#2026-07-30T16:00:00Z',
};

describe('putFleetActualsTotals', () => {
  it('writes one item per hour under the sentinel partition and the total key', async () => {
    const { adapter, ddb } = mockedAdapter();
    ddb.on(BatchWriteCommand).resolves({});

    const outcome = await adapter.putFleetActualsTotals([totalPoint14h]);

    expect(outcome).toEqual({ status: 'complete' });
    expect(writeRequests(ddb)).toEqual([[totalItem14h]]);
  });

  it('rewrites byte-identical items for identical inputs', async () => {
    const { adapter, ddb } = mockedAdapter();
    ddb.on(BatchWriteCommand).resolves({});

    await adapter.putFleetActualsTotals([totalPoint14h]);
    await adapter.putFleetActualsTotals([totalPoint14h]);

    const [first, second] = writeRequests(ddb);
    expect(first).toEqual(second);
  });

  it('refuses two totals for one hour, naming the operation', async () => {
    const { adapter, ddb } = mockedAdapter();
    ddb.on(BatchWriteCommand).resolves({});

    await expect(adapter.putFleetActualsTotals([totalPoint14h, totalPoint14h])).rejects.toThrow(
      /putFleetActualsTotals/u,
    );
    expect(writeRequests(ddb)).toEqual([]);
  });
});

describe('queryFleetActualsTotals', () => {
  it('reads the window with one Query, bounded half-open on the total sort key', async () => {
    const { adapter, ddb } = mockedAdapter();
    ddb.on(QueryCommand).resolves({ Items: [totalItem14h, totalItem15h] });

    const { rows, complete } = await adapter.queryFleetActualsTotals(from, to);

    expect(queryInputs(ddb)).toEqual([
      {
        TableName: TABLE_NAME,
        KeyConditionExpression: 'siteId = :siteId AND sk BETWEEN :from AND :to',
        ExpressionAttributeValues: BOUNDS,
        ScanIndexForward: true,
      },
    ]);
    expect(rows).toEqual([totalPoint14h, totalPoint15h]);
    expect(complete).toBe(true);
    expect(anyInputHasConsistentRead(ddb)).toBe(false);
  });

  it('reports a bounded read that stopped short as incomplete rather than as the answer', async () => {
    const { adapter, ddb } = mockedAdapter();
    ddb
      .on(QueryCommand)
      .resolves({ Items: [totalItem14h], LastEvaluatedKey: { siteId: '#FLEET' } });

    const { rows, complete } = await adapter.queryFleetActualsTotals(from, to, {
      hasBudgetForNextPage: () => false,
    });

    expect(rows).toHaveLength(1);
    expect(complete).toBe(false);
  });
});

describe('queryLatestFleetActualsTotals', () => {
  it('asks for the newest `limit` totals in the same literal bounds, descending', async () => {
    const { adapter, ddb } = mockedAdapter();
    ddb.on(QueryCommand).resolves({ Items: [totalItem15h, totalItem14h] });

    const rows = await adapter.queryLatestFleetActualsTotals(from, to, 3);

    expect(queryInputs(ddb)).toEqual([
      {
        TableName: TABLE_NAME,
        KeyConditionExpression: 'siteId = :siteId AND sk BETWEEN :from AND :to',
        ExpressionAttributeValues: BOUNDS,
        ScanIndexForward: false,
        Limit: 3,
      },
    ]);
    expect(rows).toEqual([totalPoint15h, totalPoint14h]);
    expect(anyInputHasConsistentRead(ddb)).toBe(false);
  });

  it('answers an empty window with no rows', async () => {
    const { adapter, ddb } = mockedAdapter();
    ddb.on(QueryCommand).resolves({});

    await expect(adapter.queryLatestFleetActualsTotals(from, to, 3)).resolves.toEqual([]);
  });

  it('throws on a limit that is not a positive integer, before any command is sent', async () => {
    const { adapter, ddb } = mockedAdapter();
    ddb.on(QueryCommand).resolves({ Items: [] });

    await expect(adapter.queryLatestFleetActualsTotals(from, to, 0)).rejects.toThrow(/limit/u);
    expect(ddb.commandCalls(QueryCommand)).toEqual([]);
  });
});
