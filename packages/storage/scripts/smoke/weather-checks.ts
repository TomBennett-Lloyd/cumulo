import { deepStrictEqual, equal, ok } from 'node:assert/strict';

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { WeatherAdapter, storageTableName } from '../../src/index';
import { ENVIRONMENT } from '../storage-environment';

import { eventually, type CheckRunner } from './check-runner';
import {
  HOUR_0,
  HOUR_1,
  HOUR_2,
  SMOKE_DAY,
  SMOKE_LOCATION,
  UNFETCHED_DAY,
  smokeArchiveReading,
  smokeForecastReading,
} from './smoke-data';

/** The `cumulo-weather` checks: the archive transaction, its marker, and the ranges. */
export const runWeatherChecks = async (
  runner: CheckRunner,
  client: DynamoDBDocumentClient,
): Promise<void> => {
  const weather = new WeatherAdapter({
    client,
    tableName: storageTableName('weather', ENVIRONMENT),
  });
  const archiveHours = [smokeArchiveReading(HOUR_0), smokeArchiveReading(HOUR_1)];

  await runner.check('weather: putArchiveDay writes the day and its marker', async () => {
    await weather.putArchiveDay(SMOKE_DAY, archiveHours);
  });

  await runner.check('weather: the day marker is visible and the next day is not', async () => {
    const coverage = await eventually(
      'weather: the archive-day marker is readable',
      () => weather.listFetchedArchiveDays(SMOKE_LOCATION, [SMOKE_DAY, UNFETCHED_DAY]),
      (found) => found.fetched.has(SMOKE_DAY),
    );
    equal(coverage.status, 'complete', 'BatchGet left keys undetermined');
    ok(!coverage.fetched.has(UNFETCHED_DAY), 'a day that was never written reports as fetched');
  });

  await runner.check('weather: queryArchiveRange returns the day, markers excluded', async () => {
    const readings = await eventually(
      'weather: both archive hours are readable',
      () => weather.queryArchiveRange(SMOKE_LOCATION, HOUR_0, HOUR_2),
      (found) => found.length === 2,
    );
    // Not merely a count: the marker shares the partition and sorts adjacent to
    // these items, so "two weather readings, in order" is what proves the sort
    // key really keeps `ARCHIVE#DAY#…` out of `ARCHIVE#T#…` range reads.
    deepStrictEqual(
      readings.map((reading) => reading.validTime),
      [HOUR_0, HOUR_1],
      'the archive range is not the two hours written, in order',
    );
    deepStrictEqual(readings, archiveHours, 'an archive reading changed across the round trip');
  });

  await runner.check('weather: the archive range is half-open at its upper bound', async () => {
    const readings = await weather.queryArchiveRange(SMOKE_LOCATION, HOUR_0, HOUR_1);
    deepStrictEqual(
      readings.map((reading) => reading.validTime),
      [HOUR_0],
      'the [hour0, hour1) window included the reading at hour 1',
    );
  });

  await runner.check('weather: forecast weather batch-writes completely', async () => {
    const outcome = await weather.putForecastWeather([smokeForecastReading(HOUR_0)]);
    equal(outcome.status, 'complete', 'the forecast-weather batch did not drain');
  });
};
