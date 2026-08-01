import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  forecastSchema,
  generationReadingSchema,
  utcIsoTimestampSchema,
  type Forecast,
  type GenerationReading,
  type UtcIsoTimestamp,
} from '@cumulo/shared';
import { mockClient, type AwsClientStub } from 'aws-sdk-client-mock';

import type { BatchPolicy } from '../../batch';
import { createStorageDocumentClient } from '../../client';
import type { RecordingHttpHandler } from '../../recording-http-handler';

import { SeriesAdapter } from './series-adapter';

/**
 * Fixtures shared by this folder's tests: the domain builders, the stored items
 * as DynamoDB would hand them back, and the stubbed adapter.
 *
 * Test support. The SDK is stubbed **per client instance** rather than on the
 * `DynamoDBDocumentClient` class, so that the marshalling tests can run a
 * genuine client — middleware included — alongside the stubbed ones.
 */

export const TABLE_NAME = 'cumulo-series-test';

export const SITE_ID = '3f1a2b4c-5d6e-4f7a-8b9c-0d1e2f3a4b5c';

/** `2026-07-30T14:00:00Z` + 90 days, in epoch seconds. Hand-computed, pinned. */
export const EXPIRES_AT_14H = 1_793_196_000;
/** The same, one hour later: 3600 seconds more. */
export const EXPIRES_AT_15H = 1_793_199_600;

export const at = (iso: string): UtcIsoTimestamp => utcIsoTimestampSchema.parse(iso);

type ForecastOverrides = Partial<Record<keyof Forecast, unknown>>;

export const forecast = (overrides: ForecastOverrides = {}): Forecast =>
  forecastSchema.parse({
    siteId: SITE_ID,
    model: 'physics',
    validTime: '2026-07-30T14:00:00Z',
    issuedAt: '2026-07-30T13:00:00Z',
    weatherSource: 'open-meteo',
    poaIrradianceWm2: 640.5,
    acPowerKw: 3.2,
    ...overrides,
  });

export const generationReading = (
  overrides: Partial<Record<keyof GenerationReading, unknown>> = {},
): GenerationReading =>
  generationReadingSchema.parse({
    siteId: SITE_ID,
    validTime: '2026-07-30T14:00:00Z',
    acPowerKw: 3.05,
    ...overrides,
  });

/** `count` consecutive hourly physics forecasts starting at midnight. */
export const hourlyForecasts = (count: number): Forecast[] => {
  const startMs = Date.parse('2026-07-30T00:00:00Z');
  return Array.from({ length: count }, (_unused, index) =>
    forecast({
      validTime: new Date(startMs + index * 3_600_000).toISOString().replace('.000Z', 'Z'),
    }),
  );
};

/**
 * Stored items written out literally rather than produced by `toForecastItem` —
 * a fixture that agreed with the code under test by construction would prove
 * nothing about the wire shape. Sorted here as DynamoDB would return them:
 * `#FC#ml` < `#FC#physics` < `#GEN`, and 14:00 before 15:00.
 */
export const mlItem14h = {
  siteId: SITE_ID,
  sk: 'T#2026-07-30T14:00:00Z#FC#ml',
  expiresAt: EXPIRES_AT_14H,
  model: 'ml',
  validTime: '2026-07-30T14:00:00Z',
  issuedAt: '2026-07-30T13:00:00Z',
  weatherSource: 'open-meteo',
  poaIrradianceWm2: 640.5,
  acPowerKw: 3.4,
  uncertainty: { p10AcPowerKw: 2.8, p90AcPowerKw: 3.9 },
};

export const physicsItem14h = {
  siteId: SITE_ID,
  sk: 'T#2026-07-30T14:00:00Z#FC#physics',
  expiresAt: EXPIRES_AT_14H,
  model: 'physics',
  validTime: '2026-07-30T14:00:00Z',
  issuedAt: '2026-07-30T13:00:00Z',
  weatherSource: 'open-meteo',
  poaIrradianceWm2: 640.5,
  acPowerKw: 3.2,
};

export const generationItem14h = {
  siteId: SITE_ID,
  sk: 'T#2026-07-30T14:00:00Z#GEN',
  expiresAt: EXPIRES_AT_14H,
  validTime: '2026-07-30T14:00:00Z',
  acPowerKw: 3.05,
};

export const mlItem15h = {
  ...mlItem14h,
  sk: 'T#2026-07-30T15:00:00Z#FC#ml',
  expiresAt: EXPIRES_AT_15H,
  validTime: '2026-07-30T15:00:00Z',
  acPowerKw: 2.7,
};

export const physicsItem15h = {
  ...physicsItem14h,
  sk: 'T#2026-07-30T15:00:00Z#FC#physics',
  expiresAt: EXPIRES_AT_15H,
  validTime: '2026-07-30T15:00:00Z',
  acPowerKw: 2.5,
};

/** The interleaved page: two models and one actual at 14:00, two models at 15:00. */
export const interleavedPage = [
  mlItem14h,
  physicsItem14h,
  generationItem14h,
  mlItem15h,
  physicsItem15h,
];

export const offlineBaseClient = (requestHandler?: RecordingHttpHandler): DynamoDBClient =>
  new DynamoDBClient({
    region: 'eu-west-1',
    credentials: { accessKeyId: 'test-access-key-id', secretAccessKey: 'test-secret-access-key' },
    ...(requestHandler === undefined ? {} : { requestHandler }),
  });

export interface MockedAdapter {
  readonly adapter: SeriesAdapter;
  readonly ddb: AwsClientStub<DynamoDBDocumentClient>;
}

export const mockedAdapter = (batchPolicy?: BatchPolicy): MockedAdapter => {
  const client = createStorageDocumentClient({ baseClient: offlineBaseClient() });

  return {
    ddb: mockClient(client),
    adapter: new SeriesAdapter({
      client,
      tableName: TABLE_NAME,
      ...(batchPolicy === undefined ? {} : { batchPolicy }),
    }),
  };
};

/** A batch policy that retries the documented number of times but never waits. */
export const instantPolicy = (delays: number[]): BatchPolicy => ({
  maxAttempts: 3,
  baseDelayMs: 200,
  sleep: (ms) => {
    delays.push(ms);
    return Promise.resolve();
  },
});

export const writeRequests = (
  ddb: AwsClientStub<DynamoDBDocumentClient>,
): Record<string, unknown>[][] =>
  ddb.commandCalls(BatchWriteCommand).map((call) => {
    const requests = call.args[0].input.RequestItems?.[TABLE_NAME];
    if (requests === undefined) {
      throw new Error(`BatchWriteCommand did not target ${TABLE_NAME}`);
    }
    return requests.map((request) => {
      const item = request.PutRequest?.Item;
      if (item === undefined) {
        throw new Error('expected every batch entry to be a PutRequest');
      }
      return item;
    });
  });

/** The keys of every `DeleteRequest` the adapter batched, batch by batch. */
export const deleteRequestKeys = (
  ddb: AwsClientStub<DynamoDBDocumentClient>,
): Record<string, unknown>[][] =>
  ddb.commandCalls(BatchWriteCommand).map((call) => {
    const requests = call.args[0].input.RequestItems?.[TABLE_NAME];
    if (requests === undefined) {
      throw new Error(`BatchWriteCommand did not target ${TABLE_NAME}`);
    }
    return requests.map((request) => {
      const key = request.DeleteRequest?.Key;
      if (key === undefined) {
        throw new Error('expected every batch entry to be a DeleteRequest');
      }
      return key;
    });
  });

export const anyInputHasConsistentRead = (ddb: AwsClientStub<DynamoDBDocumentClient>): boolean =>
  ddb.calls().some((call) => 'ConsistentRead' in call.args[0].input);
