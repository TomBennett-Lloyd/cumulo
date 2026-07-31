import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  BatchWriteCommand,
  DynamoDBDocumentClient,
  QueryCommand,
  TransactWriteCommand,
  type BatchGetCommandInput,
  type BatchWriteCommandInput,
  type QueryCommandInput,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import {
  utcIsoTimestampSchema,
  weatherReadingSchema,
  weatherSortKey,
  type UtcIsoTimestamp,
} from '@cumulo/shared';
import { mockClient } from 'aws-sdk-client-mock';
import { expect } from 'vitest';
import { z } from 'zod';

import type { BatchPolicy } from '../../batch';

import { WeatherAdapter } from './weather-adapter';
import type { ArchiveWeatherReading, ForecastWeatherReading } from './weather-item';

/**
 * Fixtures shared by this folder's tests: the two `kind`-narrowed reading
 * builders, the adapter under test, and the readers that turn a captured
 * command input into typed items.
 *
 * Test support. The captured items are re-parsed out of the SDK's
 * `NativeAttributeValue` (whose value type is `any`) so that every assertion in
 * the tests is on a typed value; parsing also asserts that the two key
 * attributes are present on every item.
 */

export const TABLE = 'cumulo-weather-test';

/** Dublin, and the location id it rounds to (~1.1 km buckets). */
export const DUBLIN = { latitude: 53.3498, longitude: -6.2603 };
export const DUBLIN_ID = '53.35,-6.26';
/** Far enough away to land in another bucket, close enough to be a plausible mistake. */
export const CORK = { latitude: 51.8985, longitude: -8.4756 };

export const ddbMock = mockClient(DynamoDBDocumentClient);
const client = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    region: 'eu-west-1',
    credentials: { accessKeyId: 'test-access-key-id', secretAccessKey: 'test-secret-access-key' },
  }),
);

/** Retries with no wall-clock cost; the shipped policy gets its own test. */
export const instantPolicy: BatchPolicy = {
  maxAttempts: 3,
  baseDelayMs: 0,
  sleep: () => Promise.resolve(),
};

export const adapter = (): WeatherAdapter =>
  new WeatherAdapter({ client, tableName: TABLE, batchPolicy: instantPolicy });

/** The adapter exactly as production builds it — no injected batch policy. */
export const shippedAdapter = (): WeatherAdapter =>
  new WeatherAdapter({ client, tableName: TABLE });

export const at = (iso: string): UtcIsoTimestamp => utcIsoTimestampSchema.parse(iso);

const archiveReadingSchema = weatherReadingSchema.extend({ kind: z.literal('archive') });
const forecastReadingSchema = weatherReadingSchema.extend({ kind: z.literal('forecast') });

const readingFields = (validTime: string, coords: { latitude: number; longitude: number }) => ({
  latitude: coords.latitude,
  longitude: coords.longitude,
  validTime,
  source: 'open-meteo',
  shortwaveRadiationWm2: 420,
  directRadiationWm2: 300,
  diffuseRadiationWm2: 120,
  directNormalIrradianceWm2: 500,
  temperature2mC: 17.5,
  windSpeed10mMs: 4.2,
  cloudCoverPct: 35,
});

export const archiveReading = (validTime: string, coords = DUBLIN): ArchiveWeatherReading =>
  archiveReadingSchema.parse({ ...readingFields(validTime, coords), kind: 'archive' });

export const forecastReading = (validTime: string, coords = DUBLIN): ForecastWeatherReading =>
  forecastReadingSchema.parse({ ...readingFields(validTime, coords), kind: 'forecast' });

/** `count` consecutive hourly UTC timestamps in the schema's fixed-width form. */
export const hourlyFrom = (start: string, count: number): string[] => {
  const startMs = Date.parse(start);
  return Array.from({ length: count }, (_unused, index) =>
    new Date(startMs + index * 3_600_000).toISOString().replace('.000Z', 'Z'),
  );
};

const itemSchema = z.object({ locationId: z.string(), sk: z.string() }).catchall(z.unknown());
export type Item = z.infer<typeof itemSchema>;

export const transactInputs = (): TransactWriteCommandInput[] =>
  ddbMock.commandCalls(TransactWriteCommand).map((call) => call.args[0].input);
export const writeInputs = (): BatchWriteCommandInput[] =>
  ddbMock.commandCalls(BatchWriteCommand).map((call) => call.args[0].input);
export const getInputs = (): BatchGetCommandInput[] =>
  ddbMock.commandCalls(BatchGetCommand).map((call) => call.args[0].input);
export const queryInputs = (): QueryCommandInput[] =>
  ddbMock.commandCalls(QueryCommand).map((call) => call.args[0].input);

/** Every transaction item, asserted to be a Put carrying an item. */
export const transactedItems = (input: TransactWriteCommandInput): Item[] =>
  (input.TransactItems ?? []).map((transactItem) => {
    const put = transactItem.Put;
    if (put?.Item === undefined) {
      throw new Error('expected every transaction item to be a Put carrying an Item');
    }
    expect(put.TableName).toBe(TABLE);
    return itemSchema.parse(put.Item);
  });

/** Every item a batch write would store, across all of its batches. */
export const writtenItems = (input: BatchWriteCommandInput): Item[] =>
  (input.RequestItems?.[TABLE] ?? []).map((request) => {
    if (request.PutRequest?.Item === undefined) {
      throw new Error('expected every batch write request to be a PutRequest carrying an Item');
    }
    return itemSchema.parse(request.PutRequest.Item);
  });

export const putRequestsFor = (
  readings: readonly ForecastWeatherReading[],
): { PutRequest: { Item: Item } }[] =>
  readings.map((reading) => ({
    PutRequest: {
      Item: { locationId: DUBLIN_ID, sk: weatherSortKey('forecast', reading.validTime) },
    },
  }));
