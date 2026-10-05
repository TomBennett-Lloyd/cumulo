import { BatchWriteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { FLEET_ROLLUP_FORECAST_KIND, FLEET_ROLLUP_PARTITION } from '@cumulo/shared';
import { describe, expect, it } from 'vitest';

import { toFleetRollupItem } from './fleet-rollup-item';
import {
  LOCATION_ID,
  OTHER_LOCATION_ID,
  TABLE_NAME,
  anyInputHasConsistentRead,
  at,
  mockedAdapter,
  otherRollupItem14h,
  partial,
  rollupItem14h,
  rollupPage,
  writeRequests,
} from './series-fixtures';

/**
 * The `#FLEET` partition's two methods, in the contract style this folder uses throughout
 * (`docs/standards/testing.md` rule 3): every assertion is on a captured command input — the exact
 * request the adapter would put on the wire — or on a fixture response shaped like DynamoDB's.
 *
 * The half-open bounds are asserted **literally** rather than through `fleetRollupTimeBound`. A test
 * that built its expectation with the same function the adapter calls would pass for any pair of
 * strings the two agreed on, including a pair that reads the wrong window; ADR 0009's read depends
 * on these exact strings, so these exact strings are what is pinned.
 */

const from = at('2026-07-30T14:00:00Z');
const to = at('2026-07-30T16:00:00Z');

const queryInputs = (
  ddb: ReturnType<typeof mockedAdapter>['ddb'],
): Record<string, unknown>[] | undefined =>
  ddb.commandCalls(QueryCommand).map((call) => ({ ...call.args[0].input }));

describe('putFleetRollupPartials', () => {
  it('writes one item per hour under the sentinel partition and the location key', async () => {
    const { adapter, ddb } = mockedAdapter();
    ddb.on(BatchWriteCommand).resolves({});

    const outcome = await adapter.putFleetRollupPartials(FLEET_ROLLUP_FORECAST_KIND, LOCATION_ID, [
      partial(),
    ]);

    expect(outcome).toEqual({ status: 'complete' });
    expect(writeRequests(ddb)).toEqual([[rollupItem14h]]);
  });

  it('lets two locations write the same hour without one overwriting the other', async () => {
    const { adapter, ddb } = mockedAdapter();
    ddb.on(BatchWriteCommand).resolves({});

    await adapter.putFleetRollupPartials(FLEET_ROLLUP_FORECAST_KIND, LOCATION_ID, [partial()]);
    await adapter.putFleetRollupPartials(FLEET_ROLLUP_FORECAST_KIND, OTHER_LOCATION_ID, [
      partial({
        acPowerKw: otherRollupItem14h.acPowerKw,
        p10AcPowerKw: otherRollupItem14h.p10AcPowerKw,
        p90AcPowerKw: otherRollupItem14h.p90AcPowerKw,
        contributingSiteCount: otherRollupItem14h.contributingSiteCount,
        contributingCapacityKw: otherRollupItem14h.contributingCapacityKw,
      }),
    ]);

    const [first, second] = writeRequests(ddb);
    expect(first).toEqual([rollupItem14h]);
    expect(second).toEqual([otherRollupItem14h]);
  });

  it('rewrites byte-identical items when a message is redelivered', async () => {
    const { adapter, ddb } = mockedAdapter();
    ddb.on(BatchWriteCommand).resolves({});

    await adapter.putFleetRollupPartials(FLEET_ROLLUP_FORECAST_KIND, LOCATION_ID, [partial()]);
    await adapter.putFleetRollupPartials(FLEET_ROLLUP_FORECAST_KIND, LOCATION_ID, [partial()]);

    const [first, second] = writeRequests(ddb);
    expect(first).toEqual(second);
  });

  it('chunks a 168-hour horizon into DynamoDB-sized batches of at most 25', async () => {
    const { adapter, ddb } = mockedAdapter();
    ddb.on(BatchWriteCommand).resolves({});
    const startMs = Date.parse('2026-07-30T00:00:00Z');
    const horizon = Array.from({ length: 168 }, (_unused, index) =>
      partial({
        validTime: new Date(startMs + index * 3_600_000).toISOString().replace('.000Z', 'Z'),
      }),
    );

    await adapter.putFleetRollupPartials(FLEET_ROLLUP_FORECAST_KIND, LOCATION_ID, horizon);

    expect(writeRequests(ddb).map((batch) => batch.length)).toEqual([25, 25, 25, 25, 25, 25, 18]);
  });

  it('never reports a 200 with UnprocessedItems as a clean run', async () => {
    const { adapter, ddb } = mockedAdapter({
      maxAttempts: 2,
      baseDelayMs: 1,
      sleep: () => Promise.resolve(),
    });
    ddb.on(BatchWriteCommand).resolves({
      UnprocessedItems: {
        [TABLE_NAME]: [
          {
            PutRequest: {
              Item: toFleetRollupItem(FLEET_ROLLUP_FORECAST_KIND, LOCATION_ID, partial()),
            },
          },
        ],
      },
    });

    const outcome = await adapter.putFleetRollupPartials(FLEET_ROLLUP_FORECAST_KIND, LOCATION_ID, [
      partial(),
    ]);

    expect(outcome).toEqual({ status: 'partial', unprocessedCount: 1 });
  });

  it('writes nothing for an empty horizon', async () => {
    const { adapter, ddb } = mockedAdapter();
    ddb.on(BatchWriteCommand).resolves({});

    const outcome = await adapter.putFleetRollupPartials(
      FLEET_ROLLUP_FORECAST_KIND,
      LOCATION_ID,
      [],
    );

    expect(outcome).toEqual({ status: 'complete' });
    expect(writeRequests(ddb)).toEqual([]);
  });
});

describe('queryFleetRollup', () => {
  it('reads the window with one Query, bounded half-open on the kind-led sort key', async () => {
    const { adapter, ddb } = mockedAdapter();
    ddb.on(QueryCommand).resolves({ Items: rollupPage });

    await adapter.queryFleetRollup(FLEET_ROLLUP_FORECAST_KIND, from, to);

    expect(queryInputs(ddb)).toEqual([
      {
        TableName: TABLE_NAME,
        KeyConditionExpression: 'siteId = :siteId AND sk BETWEEN :from AND :to',
        ExpressionAttributeValues: {
          ':siteId': FLEET_ROLLUP_PARTITION,
          ':from': 'FC#physics#T#2026-07-30T14:00:00Z',
          ':to': 'FC#physics#T#2026-07-30T16:00:00Z',
        },
        ScanIndexForward: true,
      },
    ]);
  });

  it('returns every location that wrote the window, each with its own partial', async () => {
    const { adapter, ddb } = mockedAdapter();
    ddb.on(QueryCommand).resolves({ Items: rollupPage });

    const { rows, complete } = await adapter.queryFleetRollup(FLEET_ROLLUP_FORECAST_KIND, from, to);

    expect(complete).toBe(true);
    expect(rows.map((row) => row.locationId)).toEqual([
      LOCATION_ID,
      OTHER_LOCATION_ID,
      LOCATION_ID,
    ]);
    expect(rows[0]?.partial.acPowerKw).toBe(rollupItem14h.acPowerKw);
    expect(rows[1]?.partial.acPowerKw).toBe(otherRollupItem14h.acPowerKw);
  });

  it('reads the actuals kind under its own bounds, never past the forecast items', async () => {
    const { adapter, ddb } = mockedAdapter();
    ddb.on(QueryCommand).resolves({ Items: [] });

    await adapter.queryFleetRollup({ kind: 'generation' }, from, to);

    expect(queryInputs(ddb)?.[0]?.ExpressionAttributeValues).toEqual({
      ':siteId': FLEET_ROLLUP_PARTITION,
      ':from': 'GEN#T#2026-07-30T14:00:00Z',
      ':to': 'GEN#T#2026-07-30T16:00:00Z',
    });
  });

  it('walks pages, because DynamoDB pages at 1 MB however few items that is', async () => {
    const { adapter, ddb } = mockedAdapter();
    ddb
      .on(QueryCommand)
      .resolvesOnce({ Items: [rollupItem14h], LastEvaluatedKey: { siteId: '#FLEET' } })
      .resolves({ Items: [otherRollupItem14h] });

    const { rows, complete } = await adapter.queryFleetRollup(FLEET_ROLLUP_FORECAST_KIND, from, to);

    expect(rows).toHaveLength(2);
    expect(complete).toBe(true);
  });

  it('reports a bounded read that stopped short as incomplete rather than as the answer', async () => {
    const { adapter, ddb } = mockedAdapter();
    ddb
      .on(QueryCommand)
      .resolves({ Items: [rollupItem14h], LastEvaluatedKey: { siteId: '#FLEET' } });
    // The first page is always sent — the bound is asked *between* pages, never before the first
    // (`QueryPaginationBound`). So a caller with no budget still gets one page, and the flag is what
    // tells it that page is a prefix.
    const { rows, complete } = await adapter.queryFleetRollup(
      FLEET_ROLLUP_FORECAST_KIND,
      from,
      to,
      {
        hasBudgetForNextPage: () => false,
      },
    );

    expect(rows).toHaveLength(1);
    expect(complete).toBe(false);
  });

  it('never asks for a consistent read (ADR 0002 Consequence 3)', async () => {
    const { adapter, ddb } = mockedAdapter();
    ddb.on(QueryCommand).resolves({ Items: rollupPage });

    await adapter.queryFleetRollup(FLEET_ROLLUP_FORECAST_KIND, from, to);

    expect(anyInputHasConsistentRead(ddb)).toBe(false);
  });

  it('answers an empty partition with no rows rather than by throwing', async () => {
    const { adapter, ddb } = mockedAdapter();
    ddb.on(QueryCommand).resolves({});

    const { rows, complete } = await adapter.queryFleetRollup(FLEET_ROLLUP_FORECAST_KIND, from, to);

    expect(rows).toEqual([]);
    expect(complete).toBe(true);
  });
});
