import { deepStrictEqual, equal } from 'node:assert/strict';

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { SeriesAdapter, storageTableName, type SeriesPoint } from '../../src/index';
import { ENVIRONMENT } from '../storage-environment';

import { eventually, type CheckRunner } from './check-runner';
import { HOUR_0, HOUR_1, HOUR_2, smokeForecast, smokeGeneration } from './smoke-data';
import { assertTtlStatus } from './ttl-status';

/** A `SeriesPoint` rendered as one comparable string, so order assertions read as data. */
const describePoint = (point: SeriesPoint): string =>
  point.type === 'forecast'
    ? `forecast:${point.forecast.model}@${point.forecast.validTime}`
    : `generation@${point.reading.validTime}`;

/** The `cumulo-series` checks: batch drains, and the two windowed reads. */
export const runSeriesChecks = async (
  runner: CheckRunner,
  client: DynamoDBDocumentClient,
  siteId: string,
): Promise<void> => {
  const seriesTable = storageTableName('series', ENVIRONMENT);
  const series = new SeriesAdapter({ client, tableName: seriesTable });
  const physicsAtHour0 = smokeForecast(siteId, HOUR_0, 'physics');
  const mlAtHour0 = smokeForecast(siteId, HOUR_0, 'ml');
  const generationAtHour1 = smokeGeneration(siteId, HOUR_1);

  await runner.check('series: batch writes drain completely', async () => {
    const forecasts = await series.putForecasts([physicsAtHour0, mlAtHour0]);
    equal(forecasts.status, 'complete', 'the forecast batch did not drain');
    const readings = await series.putGenerationReadings([generationAtHour1]);
    equal(readings.status, 'complete', 'the generation batch did not drain');
  });

  await runner.check(
    'series: querySeriesRange is half-open — the upper bound excludes its own hour',
    async () => {
      // The one behaviour a mock genuinely cannot check: whether real DynamoDB
      // agrees that `T#<hour1>` sorts below `T#<hour1>#GEN`. If it did not, this
      // window would return three points and the dashboard would double-count
      // the boundary hour of every adjacent range.
      const window = await eventually(
        'series: both hour-0 forecasts are readable',
        async () => (await series.querySeriesRange(siteId, HOUR_0, HOUR_1)).points,
        (points) => points.length === 2,
      );
      deepStrictEqual(
        window.map(describePoint),
        [`forecast:ml@${HOUR_0}`, `forecast:physics@${HOUR_0}`],
        'the [hour0, hour1) window is not exactly the two hour-0 forecasts, in sort-key order',
      );
    },
  );

  await runner.check(
    'series: a wider range interleaves forecasts and actuals by time',
    async () => {
      const window = await eventually(
        'series: all three points are readable',
        async () => (await series.querySeriesRange(siteId, HOUR_0, HOUR_2)).points,
        (points) => points.length === 3,
      );
      deepStrictEqual(
        window.map(describePoint),
        [`forecast:ml@${HOUR_0}`, `forecast:physics@${HOUR_0}`, `generation@${HOUR_1}`],
        'the [hour0, hour2) window is not the three points in chronological order',
      );
    },
  );

  await runner.check(
    'series: querySeriesFrom returns the points at or after its bound',
    async () => {
      const points = await eventually(
        'series: the hour-1 reading is readable',
        () => series.querySeriesFrom(siteId, HOUR_1, 10),
        (found) => found.length === 1,
      );
      deepStrictEqual(
        points.map(describePoint),
        [`generation@${HOUR_1}`],
        'querySeriesFrom returned something other than the single hour-1 actual',
      );
    },
  );

  await runner.check('series: TTL is ENABLED on the expiresAt attribute', async () => {
    // Configuration, not deletion. The adapter writes `expiresAt = validTime +
    // 90 days` and ADR 0002's retention consequence rests on DynamoDB acting on
    // it; a reap is asynchronous over days, so what a smoke run can prove is
    // that the deployed table is actually set up to reap — read back from AWS
    // rather than from `infra/storage/tables.tf`.
    await assertTtlStatus(client, seriesTable, 'ENABLED');
  });
};
