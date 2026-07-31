import { BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { captureStorageError } from '../storage-error-capture';

import {
  DUBLIN_ID,
  TABLE,
  adapter,
  ddbMock,
  forecastReading,
  hourlyFrom,
  instantPolicy,
  putRequestsFor,
  shippedAdapter,
  writeInputs,
  writtenItems,
} from './weather-fixtures';
import { FORECAST_WEATHER_RETENTION_DAYS } from './weather-item';

/**
 * Forecast weather is the appending, expiring half of this table (access
 * pattern I2). The assertions are on the command inputs that would reach
 * DynamoDB and on the outcome the adapter reports back — never on a mock having
 * been called (`docs/standards/testing.md` rule 3).
 */

const HOUR = '2026-02-10T00:00:00Z';

beforeEach(() => {
  ddbMock.reset();
});

afterAll(() => {
  ddbMock.restore();
});

describe('putForecastWeather', () => {
  it('keys every item by location and forecast time, with a 90-day TTL', async () => {
    ddbMock.on(BatchWriteCommand).resolves({});

    const outcome = await adapter().putForecastWeather([forecastReading(HOUR)]);

    expect(outcome).toEqual({ status: 'complete' });
    const [input] = writeInputs();
    if (input === undefined) {
      throw new Error('expected one BatchWriteCommand');
    }
    const [item] = writtenItems(input);

    expect(FORECAST_WEATHER_RETENTION_DAYS).toBe(90);
    expect(item?.locationId).toBe(DUBLIN_ID);
    expect(item?.sk).toBe(`FORECAST#T#${HOUR}`);
    // 2026-02-10T00:00:00Z is epoch 1_770_681_600; 90 days is 7_776_000 s.
    expect(item?.expiresAt).toBe(1_778_457_600);
    expect(item?.validTime).toBe(HOUR);
  });

  it('collapses the antimeridian: 180°E and 180°W share one partition', async () => {
    ddbMock.on(BatchWriteCommand).resolves({});

    await adapter().putForecastWeather([
      forecastReading(HOUR, { latitude: -16.5, longitude: 180 }),
      forecastReading(HOUR, { latitude: -16.5, longitude: -180 }),
    ]);

    const [input] = writeInputs();
    if (input === undefined) {
      throw new Error('expected one BatchWriteCommand');
    }
    expect(writtenItems(input).map((item) => item.locationId)).toEqual([
      '-16.50,-180.00',
      '-16.50,-180.00',
    ]);
  });

  it('splits a horizon into batches of at most 25', async () => {
    ddbMock.on(BatchWriteCommand).resolves({});

    const readings = hourlyFrom(HOUR, 60).map((hour) => forecastReading(hour));
    const outcome = await adapter().putForecastWeather(readings);

    expect(outcome).toEqual({ status: 'complete' });
    expect(writeInputs().map((input) => writtenItems(input).length)).toEqual([25, 25, 10]);
    expect(writeInputs().flatMap((input) => writtenItems(input).map((item) => item.sk))).toEqual(
      readings.map((reading) => `FORECAST#T#${reading.validTime}`),
    );
  });

  it('reports an undrained batch as partial, with the exact count left over', async () => {
    const readings = hourlyFrom(HOUR, 3).map((hour) => forecastReading(hour));
    // HTTP 200 with UnprocessedItems, every time: the failure mode that looks
    // like success (ADR 0002 Consequence 4).
    ddbMock
      .on(BatchWriteCommand)
      .resolves({ UnprocessedItems: { [TABLE]: putRequestsFor(readings.slice(0, 2)) } });

    const outcome = await adapter().putForecastWeather(readings);

    expect(outcome).toEqual({ status: 'partial', unprocessedCount: 2 });
    expect(writeInputs()).toHaveLength(instantPolicy.maxAttempts);
  });

  it('honours the shipped batch policy when none is injected', async () => {
    // No `batchPolicy` in the deps: this is the retry budget production runs
    // (docs/standards/testing.md rule 7).
    const readings = hourlyFrom(HOUR, 1).map((hour) => forecastReading(hour));
    ddbMock
      .on(BatchWriteCommand)
      .resolves({ UnprocessedItems: { [TABLE]: putRequestsFor(readings) } });

    const started = Date.now();
    const outcome = await shippedAdapter().putForecastWeather(readings);

    expect(outcome).toEqual({ status: 'partial', unprocessedCount: 1 });
    expect(writeInputs()).toHaveLength(3);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('sends nothing for an empty horizon', async () => {
    ddbMock.on(BatchWriteCommand).resolves({});

    expect(await adapter().putForecastWeather([])).toEqual({ status: 'complete' });
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it('wraps a rejected batch write in a StorageError', async () => {
    const failure = new Error('socket hang up');
    ddbMock.on(BatchWriteCommand).rejects(failure);

    const error = await captureStorageError(() =>
      adapter().putForecastWeather([forecastReading(HOUR)]),
    );

    expect(error.context).toEqual({ operation: 'putForecastWeather', table: TABLE });
    expect(error.cause).toBe(failure);
  });
});
