import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import {
  forecastSchema,
  generationReadingSchema,
  seriesSortKey,
  utcIsoTimestampSchema,
  type Forecast,
  type GenerationReading,
  type UtcIsoTimestamp,
} from '@cumulo/shared';
import { HttpResponse, type HttpRequest } from '@smithy/core/transport';
import { mockClient, type AwsClientStub } from 'aws-sdk-client-mock';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { BatchPolicy } from './batch';
import { createStorageDocumentClient } from './client';
import { StorageError } from './errors';
import {
  createSeriesAdapter,
  fromItem,
  toForecastItem,
  toGenerationReadingItem,
  type ForecastItem,
  type GenerationReadingItem,
  type SeriesAdapter,
} from './series-adapter';

/**
 * Contract tests in the sense `docs/standards/testing.md` rule 3 means: every
 * assertion is on a **captured command input** — the exact request this adapter
 * would put on the wire — on a **fixture response** shaped like DynamoDB's, or
 * on the serialized HTTP body the real marshaller produces. Nothing here
 * asserts that a mock was called.
 *
 * The SDK is stubbed **per client instance** rather than on the
 * `DynamoDBDocumentClient` class, so that the marshalling tests below can run a
 * genuine client — middleware included — in the same file.
 */

const TABLE_NAME = 'cumulo-series-test';

const SITE_ID = '3f1a2b4c-5d6e-4f7a-8b9c-0d1e2f3a4b5c';

/** `2026-07-30T14:00:00Z` + 90 days, in epoch seconds. Hand-computed, pinned. */
const EXPIRES_AT_14H = 1_793_196_000;
/** The same, one hour later: 3600 seconds more. */
const EXPIRES_AT_15H = 1_793_199_600;

function at(iso: string): UtcIsoTimestamp {
  return utcIsoTimestampSchema.parse(iso);
}

type ForecastOverrides = Partial<Record<keyof Forecast, unknown>>;

function forecast(overrides: ForecastOverrides = {}): Forecast {
  return forecastSchema.parse({
    siteId: SITE_ID,
    model: 'physics',
    validTime: '2026-07-30T14:00:00Z',
    issuedAt: '2026-07-30T13:00:00Z',
    weatherSource: 'open-meteo',
    poaIrradianceWm2: 640.5,
    acPowerKw: 3.2,
    ...overrides,
  });
}

function generationReading(
  overrides: Partial<Record<keyof GenerationReading, unknown>> = {},
): GenerationReading {
  return generationReadingSchema.parse({
    siteId: SITE_ID,
    validTime: '2026-07-30T14:00:00Z',
    acPowerKw: 3.05,
    ...overrides,
  });
}

/** `count` consecutive hourly physics forecasts starting at midnight. */
function hourlyForecasts(count: number): Forecast[] {
  const startMs = Date.parse('2026-07-30T00:00:00Z');
  return Array.from({ length: count }, (_, index) =>
    forecast({
      validTime: new Date(startMs + index * 3_600_000).toISOString().replace('.000Z', 'Z'),
    }),
  );
}

/**
 * Stored items written out literally rather than produced by `toForecastItem` —
 * a fixture that agreed with the code under test by construction would prove
 * nothing about the wire shape. Sorted here as DynamoDB would return them:
 * `#FC#ml` < `#FC#physics` < `#GEN`, and 14:00 before 15:00.
 */
const mlItem14h = {
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

const physicsItem14h = {
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

const generationItem14h = {
  siteId: SITE_ID,
  sk: 'T#2026-07-30T14:00:00Z#GEN',
  expiresAt: EXPIRES_AT_14H,
  validTime: '2026-07-30T14:00:00Z',
  acPowerKw: 3.05,
};

const mlItem15h = {
  ...mlItem14h,
  sk: 'T#2026-07-30T15:00:00Z#FC#ml',
  expiresAt: EXPIRES_AT_15H,
  validTime: '2026-07-30T15:00:00Z',
  acPowerKw: 2.7,
};

const physicsItem15h = {
  ...physicsItem14h,
  sk: 'T#2026-07-30T15:00:00Z#FC#physics',
  expiresAt: EXPIRES_AT_15H,
  validTime: '2026-07-30T15:00:00Z',
  acPowerKw: 2.5,
};

/** The interleaved page: two models and one actual at 14:00, two models at 15:00. */
const interleavedPage = [mlItem14h, physicsItem14h, generationItem14h, mlItem15h, physicsItem15h];

function offlineBaseClient(requestHandler?: RecordingHttpHandler): DynamoDBClient {
  return new DynamoDBClient({
    region: 'eu-west-1',
    credentials: { accessKeyId: 'test-access-key-id', secretAccessKey: 'test-secret-access-key' },
    ...(requestHandler === undefined ? {} : { requestHandler }),
  });
}

interface MockedAdapter {
  readonly adapter: SeriesAdapter;
  readonly ddb: AwsClientStub<DynamoDBDocumentClient>;
}

function mockedAdapter(batchPolicy?: BatchPolicy): MockedAdapter {
  const client = createStorageDocumentClient({ baseClient: offlineBaseClient() });

  return {
    ddb: mockClient(client),
    adapter: createSeriesAdapter({
      client,
      tableName: TABLE_NAME,
      ...(batchPolicy === undefined ? {} : { batchPolicy }),
    }),
  };
}

/** A batch policy that retries the documented number of times but never waits. */
function instantPolicy(delays: number[]): BatchPolicy {
  return {
    maxAttempts: 3,
    baseDelayMs: 200,
    sleep: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
}

function writeRequests(ddb: AwsClientStub<DynamoDBDocumentClient>): Record<string, unknown>[][] {
  return ddb.commandCalls(BatchWriteCommand).map((call) => {
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
}

function anyInputHasConsistentRead(ddb: AwsClientStub<DynamoDBDocumentClient>): boolean {
  return ddb.calls().some((call) => 'ConsistentRead' in call.args[0].input);
}

async function captureStorageError(run: () => Promise<unknown>): Promise<StorageError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof StorageError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected the operation to reject with a StorageError');
}

/**
 * Keeps the signed HTTP requests and answers each with an empty successful
 * response. Asserting on the serialized body is what makes the marshalling
 * tests real: the marshalling under test happens in the document client's own
 * middleware, below any SDK-level stub.
 */
class RecordingHttpHandler {
  readonly requests: HttpRequest[] = [];

  handle(request: HttpRequest): Promise<{ response: HttpResponse }> {
    this.requests.push(request);
    return Promise.resolve({
      response: new HttpResponse({
        statusCode: 200,
        headers: { 'content-type': 'application/x-amz-json-1.0' },
        body: new TextEncoder().encode('{}'),
      }),
    });
  }

  updateHttpClientConfig(): void {
    // No configurable HTTP behaviour is exercised by these tests.
  }

  httpHandlerConfigs(): Record<string, unknown> {
    return {};
  }
}

const batchWriteBodySchema = z.object({
  RequestItems: z.record(
    z.string(),
    z.array(z.object({ PutRequest: z.object({ Item: z.record(z.string(), z.unknown()) }) })),
  ),
});

/** The marshalled `AttributeValue` items of the single request that was sent. */
function marshalledItems(handler: RecordingHttpHandler): Record<string, unknown>[] {
  const [request] = handler.requests;
  if (request === undefined) {
    throw new Error('no request reached the HTTP handler');
  }
  if (typeof request.body !== 'string') {
    throw new Error('expected a JSON string body on the DynamoDB request');
  }
  const entries = batchWriteBodySchema.parse(JSON.parse(request.body)).RequestItems[TABLE_NAME];
  if (entries === undefined) {
    throw new Error(`the request did not target ${TABLE_NAME}`);
  }
  return entries.map((entry) => entry.PutRequest.Item);
}

function liveAdapter(handler: RecordingHttpHandler): SeriesAdapter {
  return createSeriesAdapter({
    client: createStorageDocumentClient({ baseClient: offlineBaseClient(handler) }),
    tableName: TABLE_NAME,
  });
}

describe('toForecastItem', () => {
  it('adds the sort key and a 90-day TTL to the domain fields, changing nothing else', () => {
    expect(toForecastItem(forecast())).toEqual({
      siteId: SITE_ID,
      model: 'physics',
      validTime: '2026-07-30T14:00:00Z',
      issuedAt: '2026-07-30T13:00:00Z',
      weatherSource: 'open-meteo',
      poaIrradianceWm2: 640.5,
      acPowerKw: 3.2,
      sk: 'T#2026-07-30T14:00:00Z#FC#physics',
      expiresAt: EXPIRES_AT_14H,
    });
  });

  it('puts the model in the sort key so both models coexist at one valid time', () => {
    expect(toForecastItem(forecast({ model: 'ml' })).sk).toBe('T#2026-07-30T14:00:00Z#FC#ml');
  });

  it('expires an item exactly 90 days after its valid time', () => {
    const ninetyDaysSeconds = 90 * 24 * 60 * 60;

    expect(toForecastItem(forecast()).expiresAt).toBe(EXPIRES_AT_14H);
    expect(EXPIRES_AT_14H - Date.parse('2026-07-30T14:00:00Z') / 1000).toBe(ninetyDaysSeconds);
    expect(toForecastItem(forecast({ validTime: '2026-07-30T15:00:00Z' })).expiresAt).toBe(
      EXPIRES_AT_15H,
    );
  });
});

describe('toGenerationReadingItem', () => {
  it('marks an actual with the GEN suffix and the same TTL rule', () => {
    expect(toGenerationReadingItem(generationReading())).toEqual({
      siteId: SITE_ID,
      validTime: '2026-07-30T14:00:00Z',
      acPowerKw: 3.05,
      sk: 'T#2026-07-30T14:00:00Z#GEN',
      expiresAt: EXPIRES_AT_14H,
    });
  });
});

describe('fromItem', () => {
  /**
   * Widens a typed item to the shape a table hands back. `fromItem` takes
   * `Record<string, unknown>` because a stored item is boundary data, so a
   * round-trip test has to cross that boundary rather than short-circuit it.
   */
  function stored(item: ForecastItem | GenerationReadingItem): Record<string, unknown> {
    return { ...item };
  }

  it('round-trips a physics forecast', () => {
    const point = forecast();

    expect(fromItem(stored(toForecastItem(point)))).toEqual({ type: 'forecast', forecast: point });
  });

  it('round-trips an ML forecast carrying an uncertainty band', () => {
    const point = forecast({
      model: 'ml',
      uncertainty: { p10AcPowerKw: 2.8, p90AcPowerKw: 3.9 },
    });

    expect(fromItem(stored(toForecastItem(point)))).toEqual({ type: 'forecast', forecast: point });
  });

  it('round-trips a generation reading', () => {
    const point = generationReading();

    expect(fromItem(stored(toGenerationReadingItem(point)))).toEqual({
      type: 'generation',
      reading: point,
    });
  });

  it('returns no key or TTL attribute as a domain field', () => {
    const point = fromItem(physicsItem14h);
    if (point.type !== 'forecast') {
      throw new Error('expected the physics item to be tagged as a forecast');
    }

    expect(Object.keys(point.forecast).sort()).toEqual([
      'acPowerKw',
      'issuedAt',
      'model',
      'poaIrradianceWm2',
      'siteId',
      'validTime',
      'weatherSource',
    ]);
  });

  it('dispatches on the sort key, not on which fields happen to be present', () => {
    // The generation schema is a strict subset of the forecast's shape, so an
    // item tagged GEN must be parsed as a reading even though its attributes
    // would also satisfy nothing else. The sort key is the discriminator.
    expect(fromItem(generationItem14h)).toEqual({
      type: 'generation',
      reading: generationReading(),
    });
  });

  it('throws on a malformed sort key rather than guessing the kind', () => {
    expect(() =>
      fromItem({ ...physicsItem14h, sk: 'T#2026-07-30T14:00:00Z#FC#guesswork' }),
    ).toThrow(/Malformed series sort key/);
    expect(() => fromItem({ ...physicsItem14h, sk: 'garbage' })).toThrow(
      /Malformed series sort key/,
    );
  });

  it('throws when the sort key attribute is missing or is not a string', () => {
    const { sk, ...withoutSortKey } = physicsItem14h;
    void sk;

    expect(() => fromItem(withoutSortKey)).toThrow(/no string sort key/);
    expect(() => fromItem({ ...physicsItem14h, sk: 42 })).toThrow(/no string sort key/);
  });

  it('throws on an item the domain schema does not recognise', () => {
    expect(() => fromItem({ ...physicsItem14h, acPowerKw: '3.2' })).toThrow();
    expect(() =>
      fromItem({ ...physicsItem14h, model: 'physics', weatherSource: 'guess' }),
    ).toThrow();
  });
});

describe('putForecasts', () => {
  it('writes each forecast as a PutRequest carrying its sort key and TTL', async () => {
    const { adapter, ddb } = mockedAdapter();
    ddb.on(BatchWriteCommand).resolves({});

    const outcome = await adapter.putForecasts([forecast(), forecast({ model: 'ml' })]);

    expect(outcome).toEqual({ status: 'complete' });
    expect(writeRequests(ddb)).toEqual([
      [toForecastItem(forecast()), toForecastItem(forecast({ model: 'ml' }))],
    ]);
  });

  it('chunks 60 forecasts into DynamoDB-sized batches of at most 25', async () => {
    const { adapter, ddb } = mockedAdapter();
    ddb.on(BatchWriteCommand).resolves({});

    await adapter.putForecasts(hourlyForecasts(60));

    expect(writeRequests(ddb).map((batch) => batch.length)).toEqual([25, 25, 10]);
  });

  it('never reports a 200 with UnprocessedItems as a clean run', async () => {
    const unprocessed = [
      { PutRequest: { Item: toForecastItem(forecast()) } },
      { PutRequest: { Item: toForecastItem(forecast({ model: 'ml' })) } },
    ];
    const delays: number[] = [];
    const { adapter, ddb } = mockedAdapter(instantPolicy(delays));
    // Every send declines the same two requests, for ever.
    ddb.on(BatchWriteCommand).resolves({ UnprocessedItems: { [TABLE_NAME]: unprocessed } });

    const outcome = await adapter.putForecasts(hourlyForecasts(30));

    // Two batches (25 + 5), each retried to its three-attempt limit, each
    // leaving the same two requests behind: four writes that did not land.
    expect(outcome).toEqual({ status: 'partial', unprocessedCount: 4 });
    expect(ddb.commandCalls(BatchWriteCommand)).toHaveLength(6);
    expect(delays).toHaveLength(4);
  });

  it('reports complete once a retry drains the leftovers', async () => {
    const { adapter, ddb } = mockedAdapter(instantPolicy([]));
    ddb
      .on(BatchWriteCommand)
      .resolvesOnce({
        UnprocessedItems: { [TABLE_NAME]: [{ PutRequest: { Item: toForecastItem(forecast()) } }] },
      })
      .resolves({});

    expect(await adapter.putForecasts([forecast()])).toEqual({ status: 'complete' });
    expect(ddb.commandCalls(BatchWriteCommand)).toHaveLength(2);
  });

  it('sends nothing when there is nothing to write', async () => {
    const { adapter, ddb } = mockedAdapter();

    expect(await adapter.putForecasts([])).toEqual({ status: 'complete' });
    expect(ddb.calls()).toHaveLength(0);
  });

  it('wraps an SDK rejection in a StorageError naming the operation and table', async () => {
    const cause = new Error('connection reset');
    const { adapter, ddb } = mockedAdapter(instantPolicy([]));
    ddb.on(BatchWriteCommand).rejects(cause);

    const error = await captureStorageError(() => adapter.putForecasts([forecast()]));

    expect(error.context).toEqual({ operation: 'putForecasts', table: TABLE_NAME });
    expect(error.cause).toBe(cause);
  });
});

describe('putGenerationReadings', () => {
  it('writes each reading as a PutRequest with the GEN sort key', async () => {
    const { adapter, ddb } = mockedAdapter();
    ddb.on(BatchWriteCommand).resolves({});

    const outcome = await adapter.putGenerationReadings([generationReading()]);

    expect(outcome).toEqual({ status: 'complete' });
    expect(writeRequests(ddb)).toEqual([[toGenerationReadingItem(generationReading())]]);
  });
});

describe('putForecasts marshalling', () => {
  // These run a genuine document client against a recording HTTP handler, so
  // lib-dynamodb's marshalling middleware actually executes. An SDK-level stub
  // would skip it and prove nothing about what reaches DynamoDB.

  it('writes a forecast whose uncertainty field is absent', async () => {
    const handler = new RecordingHttpHandler();
    const point = forecast();
    expect(Object.hasOwn(point, 'uncertainty')).toBe(false);

    expect(await liveAdapter(handler).putForecasts([point])).toEqual({ status: 'complete' });

    const [item] = marshalledItems(handler);
    expect(item?.uncertainty).toBeUndefined();
    expect(item?.expiresAt).toEqual({ N: String(EXPIRES_AT_14H) });
    expect(item?.sk).toEqual({ S: 'T#2026-07-30T14:00:00Z#FC#physics' });
  });

  it('writes a forecast whose uncertainty field is explicitly undefined', async () => {
    const handler = new RecordingHttpHandler();
    // The shape `{ ...forecast }` produces under exactOptionalPropertyTypes when
    // the optional band was never set: the key exists, the value is undefined.
    const point: Forecast = { ...forecast(), uncertainty: undefined };
    expect(Object.hasOwn(point, 'uncertainty')).toBe(true);

    expect(await liveAdapter(handler).putForecasts([point])).toEqual({ status: 'complete' });

    const [item] = marshalledItems(handler);
    expect(item).toBeDefined();
    expect(Object.keys(item ?? {}).sort()).toEqual([
      'acPowerKw',
      'expiresAt',
      'issuedAt',
      'model',
      'poaIrradianceWm2',
      'siteId',
      'sk',
      'validTime',
      'weatherSource',
    ]);
  });

  it('marshals a present uncertainty band as a nested map', async () => {
    const handler = new RecordingHttpHandler();
    const point = forecast({ model: 'ml', uncertainty: { p10AcPowerKw: 2.8, p90AcPowerKw: 3.9 } });

    await liveAdapter(handler).putForecasts([point]);

    const [item] = marshalledItems(handler);
    expect(item?.uncertainty).toEqual({
      M: { p10AcPowerKw: { N: '2.8' }, p90AcPowerKw: { N: '3.9' } },
    });
  });
});

describe('querySeriesRange', () => {
  it('pins the half-open window as a BETWEEN over bare time bounds', async () => {
    const { adapter, ddb } = mockedAdapter();
    ddb.on(QueryCommand).resolves({ Items: [] });

    await adapter.querySeriesRange(SITE_ID, at('2026-07-30T00:00:00Z'), at('2026-07-31T00:00:00Z'));

    const [call] = ddb.commandCalls(QueryCommand);
    expect(call?.args[0].input).toEqual({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'siteId = :siteId AND sk BETWEEN :from AND :to',
      ExpressionAttributeValues: {
        ':siteId': SITE_ID,
        ':from': 'T#2026-07-30T00:00:00Z',
        ':to': 'T#2026-07-31T00:00:00Z',
      },
      ScanIndexForward: true,
    });
  });

  it('emits bounds that exclude the end instant and include the start one', async () => {
    // The half-open semantics are a property of the bounds this adapter emits,
    // so they are asserted against the *captured* bounds rather than against a
    // restatement of them: an item at `to` sorts strictly after the upper bound,
    // an item at `from` sorts at or after the lower one.
    const fromInclusive = at('2026-07-30T00:00:00Z');
    const toExclusive = at('2026-07-31T00:00:00Z');
    const { adapter, ddb } = mockedAdapter();
    ddb.on(QueryCommand).resolves({ Items: [] });

    await adapter.querySeriesRange(SITE_ID, fromInclusive, toExclusive);

    const values = ddb.commandCalls(QueryCommand)[0]?.args[0].input.ExpressionAttributeValues;
    const lower = z.string().parse(values?.[':from']);
    const upper = z.string().parse(values?.[':to']);

    for (const kind of [
      { kind: 'generation' } as const,
      { kind: 'forecast', model: 'ml' } as const,
    ]) {
      expect(seriesSortKey(toExclusive, kind) > upper).toBe(true);
      expect(seriesSortKey(fromInclusive, kind) >= lower).toBe(true);
    }
  });

  it('returns an interleaved page as correctly tagged points, in server order', async () => {
    const { adapter, ddb } = mockedAdapter();
    ddb.on(QueryCommand).resolves({ Items: interleavedPage });

    const points = await adapter.querySeriesRange(
      SITE_ID,
      at('2026-07-30T14:00:00Z'),
      at('2026-07-30T16:00:00Z'),
    );

    expect(
      points.map((point) =>
        point.type === 'forecast'
          ? `${point.forecast.validTime} forecast/${point.forecast.model}`
          : `${point.reading.validTime} generation`,
      ),
    ).toEqual([
      '2026-07-30T14:00:00Z forecast/ml',
      '2026-07-30T14:00:00Z forecast/physics',
      '2026-07-30T14:00:00Z generation',
      '2026-07-30T15:00:00Z forecast/ml',
      '2026-07-30T15:00:00Z forecast/physics',
    ]);
    expect(points[2]).toEqual({ type: 'generation', reading: generationReading() });
  });

  it('follows LastEvaluatedKey rather than returning a prefix of the window', async () => {
    const lastEvaluatedKey = { siteId: SITE_ID, sk: generationItem14h.sk };
    const { adapter, ddb } = mockedAdapter();
    ddb
      .on(QueryCommand)
      .resolvesOnce({
        Items: [mlItem14h, physicsItem14h, generationItem14h],
        LastEvaluatedKey: lastEvaluatedKey,
      })
      .resolves({ Items: [mlItem15h, physicsItem15h] });

    const points = await adapter.querySeriesRange(
      SITE_ID,
      at('2026-07-30T14:00:00Z'),
      at('2026-07-30T16:00:00Z'),
    );

    expect(points).toHaveLength(5);
    expect(ddb.commandCalls(QueryCommand)[1]?.args[0].input.ExclusiveStartKey).toEqual(
      lastEvaluatedKey,
    );
  });

  it('surfaces a rejected Query as a StorageError naming the site', async () => {
    const cause = new Error('throttled beyond the retry budget');
    const { adapter, ddb } = mockedAdapter();
    ddb.on(QueryCommand).rejects(cause);

    const error = await captureStorageError(() =>
      adapter.querySeriesRange(SITE_ID, at('2026-07-30T00:00:00Z'), at('2026-07-31T00:00:00Z')),
    );

    expect(error.context).toEqual({
      operation: 'querySeriesRange',
      table: TABLE_NAME,
      key: { siteId: SITE_ID },
    });
    expect(error.cause).toBe(cause);
  });
});

describe('querySeriesFrom', () => {
  it('asks for an ascending, limited run at or after the instant', async () => {
    const { adapter, ddb } = mockedAdapter();
    ddb.on(QueryCommand).resolves({ Items: [] });

    await adapter.querySeriesFrom(SITE_ID, at('2026-07-30T14:00:00Z'), 6);

    const [call] = ddb.commandCalls(QueryCommand);
    expect(call?.args[0].input).toEqual({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'siteId = :siteId AND sk >= :from',
      ExpressionAttributeValues: { ':siteId': SITE_ID, ':from': 'T#2026-07-30T14:00:00Z' },
      ScanIndexForward: true,
      Limit: 6,
    });
  });

  it('keeps paging until the limit is filled, asking only for what is missing', async () => {
    const lastEvaluatedKey = { siteId: SITE_ID, sk: physicsItem14h.sk };
    const { adapter, ddb } = mockedAdapter();
    ddb
      .on(QueryCommand)
      .resolvesOnce({ Items: [mlItem14h, physicsItem14h], LastEvaluatedKey: lastEvaluatedKey })
      .resolves({ Items: [generationItem14h, mlItem15h] });

    const points = await adapter.querySeriesFrom(SITE_ID, at('2026-07-30T14:00:00Z'), 4);

    expect(points).toHaveLength(4);
    expect(ddb.commandCalls(QueryCommand).map((call) => call.args[0].input.Limit)).toEqual([4, 2]);
  });

  it('stops when the table runs out, even short of the limit', async () => {
    const { adapter, ddb } = mockedAdapter();
    ddb.on(QueryCommand).resolves({ Items: [generationItem14h] });

    expect(await adapter.querySeriesFrom(SITE_ID, at('2026-07-30T14:00:00Z'), 10)).toHaveLength(1);
    expect(ddb.commandCalls(QueryCommand)).toHaveLength(1);
  });

  it('rejects a limit DynamoDB would refuse, before any call is made', async () => {
    const { adapter, ddb } = mockedAdapter();

    await expect(adapter.querySeriesFrom(SITE_ID, at('2026-07-30T14:00:00Z'), 0)).rejects.toThrow(
      /limit must be a positive integer/,
    );
    await expect(adapter.querySeriesFrom(SITE_ID, at('2026-07-30T14:00:00Z'), 2.5)).rejects.toThrow(
      /limit must be a positive integer/,
    );
    expect(ddb.calls()).toHaveLength(0);
  });
});

describe('read consistency', () => {
  it('never sets ConsistentRead on any command it sends', async () => {
    // ADR 0002 Consequence 3: the 21 RCU on `series` were sized against Query's
    // default eventually-consistent reads, and a strongly-consistent read costs
    // double. This asserts across every operation, not just the query ones.
    const { adapter, ddb } = mockedAdapter();
    ddb.on(BatchWriteCommand).resolves({});
    ddb.on(QueryCommand).resolves({ Items: [physicsItem14h] });

    await adapter.putForecasts([forecast()]);
    await adapter.putGenerationReadings([generationReading()]);
    await adapter.querySeriesRange(SITE_ID, at('2026-07-30T00:00:00Z'), at('2026-07-31T00:00:00Z'));
    await adapter.querySeriesFrom(SITE_ID, at('2026-07-30T00:00:00Z'), 3);

    expect(ddb.calls()).toHaveLength(4);
    expect(anyInputHasConsistentRead(ddb)).toBe(false);
  });
});
