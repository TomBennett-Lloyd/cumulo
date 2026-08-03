import { deepStrictEqual } from 'node:assert/strict';

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { MetricsAdapter, storageTableName } from '../../src/index';
import { ENVIRONMENT } from '../storage-environment';

import { eventually, type CheckRunner } from './check-runner';
import { HOUR_0, HOUR_1, SMOKE_METRICS_PERIOD, smokeErrorMetrics } from './smoke-data';
import { assertTtlStatus } from './ttl-status';

/** The `cumulo-metrics` checks: the per-period `begins_with`, and the absent TTL. */
export const runMetricsChecks = async (
  runner: CheckRunner,
  client: DynamoDBDocumentClient,
  siteId: string,
): Promise<void> => {
  const metricsTable = storageTableName('metrics', ENVIRONMENT);
  const metrics = new MetricsAdapter({ client, tableName: metricsTable });
  const ml = smokeErrorMetrics(siteId, 'ml');
  const physics = smokeErrorMetrics(siteId, 'physics');

  await runner.check('metrics: putMetrics lands one row per model', async () => {
    await metrics.putMetrics(physics);
    await metrics.putMetrics(ml);
  });

  await runner.check(
    'metrics: queryMetricsForPeriod returns both models for the window',
    async () => {
      const found = await eventually(
        'metrics: both metrics rows are readable',
        () => metrics.queryMetricsForPeriod(siteId, SMOKE_METRICS_PERIOD),
        (rows) => rows.length === 2,
      );
      // Not merely a count. Deep equality proves every domain field survived the
      // sort key `toItem` adds and `fromItem` strips — `period` included, which
      // goes down as a map attribute and comes back through a schema parse — and
      // the order is the live half of access pattern H5: one Query returns both
      // models, `#ml#` sorting before `#physics#`.
      deepStrictEqual(
        found,
        [ml, physics],
        'the period query is not the two rows written, in sort-key order',
      );
    },
  );

  await runner.check('metrics: a neighbouring period matches nothing', async () => {
    // `begins_with` selectivity against the service rather than against a mock.
    // This window shares its *start* bound with the one that was written and
    // differs only in its end, which is the near-miss that carries information:
    // the failure `metricsPeriodPrefix`'s trailing `#` is written against
    // (`metrics-item.ts`) is a prefix that stops after the start bound and drops
    // the end, and such a prefix — `HOUR_0#` — still matches the sort key this
    // run wrote (`HOUR_0#HOUR_2#…`), so that bug fails here. A window differing
    // in its *start* would be rejected by the broken prefix too, and so would
    // pass either way.
    const found = await metrics.queryMetricsForPeriod(siteId, {
      startInclusive: HOUR_0,
      endExclusive: HOUR_1,
    });
    deepStrictEqual(found, [], 'a period this run never wrote matched rows anyway');
  });

  await runner.check('metrics: TTL is deliberately not configured', async () => {
    // The negative control for `assertTtlStatus`: three checks in this run
    // assert ENABLED, and a helper that could only ever report ENABLED would
    // pass all three. This is the table that has no TTL —
    // metrics are published evidence and must never expire — so a helper that
    // does not distinguish the two postures fails here.
    await assertTtlStatus(client, metricsTable, 'DISABLED');
  });
};
