import { BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { StorageError } from '../../errors';
import { captureStorageError } from '../storage-error-capture';

import {
  CORK,
  DUBLIN_ID,
  TABLE,
  adapter,
  adapterWithPolicy,
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

    // Consecutive hours rather than the same hour twice, precisely *because*
    // the two longitudes collapse to one partition: at one hour these would be
    // two Puts for one key, which this method now refuses (and DynamoDB would
    // reject) — see the duplicate-key case below. Different hours keep the
    // partition question the only one being asked.
    const [firstHour = '', secondHour = ''] = hourlyFrom(HOUR, 2);
    await adapter().putForecastWeather([
      forecastReading(firstHour, { latitude: -16.5, longitude: 180 }),
      forecastReading(secondHour, { latitude: -16.5, longitude: -180 }),
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

  it('refuses two readings for one location-hour before any command is sent', async () => {
    ddbMock.on(BatchWriteCommand).resolves({});
    const repeated = forecastReading(HOUR);

    const rejection = adapter().putForecastWeather([
      repeated,
      forecastReading(HOUR, CORK),
      repeated,
    ]);

    await expect(rejection).rejects.toThrow(
      `putForecastWeather: two items share the key ${DUBLIN_ID}|FORECAST#T#${HOUR} — the caller must de-duplicate before writing`,
    );
    // A plain error, not a `StorageError`: a provider response repeating an
    // hour is a fault upstream of this table, and naming the table would send
    // the operator to the wrong place (#166). The Cork reading at the same
    // hour is untouched by the check — the location is half the key.
    await expect(rejection).rejects.not.toBeInstanceOf(StorageError);
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it('refuses a policy that could never send, as a caller error rather than a table failure', async () => {
    ddbMock.on(BatchWriteCommand).resolves({});

    const rejection = adapterWithPolicy({ maxAttempts: 0, baseDelayMs: 0 }).putForecastWeather([
      forecastReading(HOUR),
    ]);

    await expect(rejection).rejects.toThrow(
      'putForecastWeather: policy.maxAttempts must be a positive integer, got 0',
    );
    // `drainBatches` refuses the identical policy from inside `sending`, where
    // it would arrive as a `StorageError` claiming the table failed. Hoisted,
    // this path answers as `putArchiveDay` already does.
    await expect(rejection).rejects.not.toBeInstanceOf(StorageError);
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
