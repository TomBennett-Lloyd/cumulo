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
  archiveDayMarkerSortKey,
  utcIsoTimestampSchema,
  weatherReadingSchema,
  weatherSortKey,
  type UtcIsoTimestamp,
} from '@cumulo/shared';
import { mockClient } from 'aws-sdk-client-mock';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { type BatchPolicy } from './batch';
import { StorageError } from './errors';
import {
  FORECAST_WEATHER_RETENTION_DAYS,
  createWeatherAdapter,
  type ArchiveWeatherReading,
  type ForecastWeatherReading,
  type WeatherAdapter,
} from './weather-adapter';

/**
 * Contract tests for the `cumulo-weather` adapter: every assertion is either on
 * the command input that would reach DynamoDB or on what the adapter makes of a
 * fixture response (`docs/standards/testing.md` rule 3). Nothing here asserts
 * "the mock was called".
 *
 * The two behaviours worth the most scrutiny are the ones a partial failure
 * would corrupt quietly:
 *  - `putArchiveDay` writes readings and marker in one transaction, so a partial
 *    fetch can never leave a marker claiming coverage it does not have;
 *  - `listFetchedArchiveDays` distinguishes fetched / unfetched / undetermined,
 *    and never coerces undetermined into either neighbour.
 */

const TABLE = 'cumulo-weather-test';

/** Dublin, and the location id it rounds to (~1.1 km buckets). */
const DUBLIN = { latitude: 53.3498, longitude: -6.2603 };
const DUBLIN_ID = '53.35,-6.26';
/** Far enough away to land in another bucket, close enough to be a plausible mistake. */
const CORK = { latitude: 51.8985, longitude: -8.4756 };

const ddbMock = mockClient(DynamoDBDocumentClient);
const client = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    region: 'eu-west-1',
    credentials: { accessKeyId: 'test-access-key-id', secretAccessKey: 'test-secret-access-key' },
  }),
);

/** Retries with no wall-clock cost; the shipped policy gets its own test below. */
const instantPolicy: BatchPolicy = {
  maxAttempts: 3,
  baseDelayMs: 0,
  sleep: () => Promise.resolve(),
};

function adapter(): WeatherAdapter {
  return createWeatherAdapter({ client, tableName: TABLE, batchPolicy: instantPolicy });
}

/** The adapter exactly as production builds it — no injected batch policy. */
function shippedAdapter(): WeatherAdapter {
  return createWeatherAdapter({ client, tableName: TABLE });
}

const at = (iso: string): UtcIsoTimestamp => utcIsoTimestampSchema.parse(iso);

const archiveReadingSchema = weatherReadingSchema.extend({ kind: z.literal('archive') });
const forecastReadingSchema = weatherReadingSchema.extend({ kind: z.literal('forecast') });

function readingFields(validTime: string, coords: { latitude: number; longitude: number }) {
  return {
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
  };
}

function archiveReading(validTime: string, coords = DUBLIN): ArchiveWeatherReading {
  return archiveReadingSchema.parse({ ...readingFields(validTime, coords), kind: 'archive' });
}

function forecastReading(validTime: string, coords = DUBLIN): ForecastWeatherReading {
  return forecastReadingSchema.parse({ ...readingFields(validTime, coords), kind: 'forecast' });
}

/** `count` consecutive hourly UTC timestamps in the schema's fixed-width form. */
function hourlyFrom(start: string, count: number): string[] {
  const startMs = Date.parse(start);
  return Array.from({ length: count }, (_unused, index) =>
    new Date(startMs + index * 3_600_000).toISOString().replace('.000Z', 'Z'),
  );
}

/**
 * A captured item, re-parsed out of the SDK's `NativeAttributeValue` (whose
 * value type is `any`) so that every assertion below is on a typed value.
 * Parsing it also asserts the two key attributes are present on every item.
 */
const itemSchema = z.object({ locationId: z.string(), sk: z.string() }).catchall(z.unknown());
type Item = z.infer<typeof itemSchema>;

const transactInputs = (): TransactWriteCommandInput[] =>
  ddbMock.commandCalls(TransactWriteCommand).map((call) => call.args[0].input);
const writeInputs = (): BatchWriteCommandInput[] =>
  ddbMock.commandCalls(BatchWriteCommand).map((call) => call.args[0].input);
const getInputs = (): BatchGetCommandInput[] =>
  ddbMock.commandCalls(BatchGetCommand).map((call) => call.args[0].input);
const queryInputs = (): QueryCommandInput[] =>
  ddbMock.commandCalls(QueryCommand).map((call) => call.args[0].input);

/** Every transaction item, asserted to be a Put carrying an item. */
function transactedItems(input: TransactWriteCommandInput): Item[] {
  return (input.TransactItems ?? []).map((transactItem) => {
    const put = transactItem.Put;
    if (put?.Item === undefined) {
      throw new Error('expected every transaction item to be a Put carrying an Item');
    }
    expect(put.TableName).toBe(TABLE);
    return itemSchema.parse(put.Item);
  });
}

/** Every item a batch write would store, across all of its batches. */
function writtenItems(input: BatchWriteCommandInput): Item[] {
  return (input.RequestItems?.[TABLE] ?? []).map((request) => {
    if (request.PutRequest?.Item === undefined) {
      throw new Error('expected every batch write request to be a PutRequest carrying an Item');
    }
    return itemSchema.parse(request.PutRequest.Item);
  });
}

function putRequestsFor(
  readings: readonly ForecastWeatherReading[],
): { PutRequest: { Item: Item } }[] {
  return readings.map((reading) => ({
    PutRequest: {
      Item: { locationId: DUBLIN_ID, sk: weatherSortKey('forecast', reading.validTime) },
    },
  }));
}

async function storageErrorFrom(promise: Promise<unknown>): Promise<StorageError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof StorageError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected the operation to reject with a StorageError');
}

beforeEach(() => {
  ddbMock.reset();
});

afterAll(() => {
  ddbMock.restore();
});

describe('archive sort-key ordering', () => {
  // Plain string comparisons, no AWS involved: these are the properties the
  // BETWEEN bounds in `queryArchiveRange` rely on, pinned where a reader can
  // check them (C1 pins the same ordering in `@cumulo/shared`).
  const from = at('2026-02-10T00:00:00Z');
  const to = at('2026-02-11T00:00:00Z');

  // DynamoDB orders sort keys by their bytes; for these ASCII keys that is
  // exactly JavaScript's string comparison.
  const sortsBefore = (lower: string, higher: string): boolean => lower < higher;

  it('sorts day markers below every archive reading, so a range query excludes them', () => {
    const lowerBound = weatherSortKey('archive', from);
    expect(sortsBefore(archiveDayMarkerSortKey('2026-02-10'), lowerBound)).toBe(true);
    expect(sortsBefore(archiveDayMarkerSortKey('2026-02-11'), lowerBound)).toBe(true);
  });

  it('sorts forecast weather above every archive reading, so a range query excludes it', () => {
    expect(sortsBefore(weatherSortKey('archive', to), weatherSortKey('forecast', from))).toBe(true);
  });
});

describe('putArchiveDay', () => {
  const DAY = '2026-02-10';
  const [firstHour = '', secondHour = ''] = hourlyFrom(`${DAY}T00:00:00Z`, 2);

  it('writes the day’s readings and its marker in a single transaction', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});

    await adapter().putArchiveDay(DAY, [archiveReading(firstHour), archiveReading(secondHour)]);

    expect(transactInputs()).toHaveLength(1);
    const [input] = transactInputs();
    if (input === undefined) {
      throw new Error('expected one TransactWriteCommand');
    }
    const items = transactedItems(input);

    expect(items).toHaveLength(3);
    expect(items.map((item) => item.sk)).toEqual([
      `ARCHIVE#T#${firstHour}`,
      `ARCHIVE#T#${secondHour}`,
      `ARCHIVE#DAY#${DAY}`,
    ]);
    expect(items.map((item) => item.locationId)).toEqual([DUBLIN_ID, DUBLIN_ID, DUBLIN_ID]);
    // Nothing else is batched alongside: one command, atomically.
    expect(writeInputs()).toEqual([]);
  });

  it('gives the marker no attributes beyond its key, and no reading a TTL', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});

    await adapter().putArchiveDay(DAY, [archiveReading(firstHour)]);

    const [input] = transactInputs();
    if (input === undefined) {
      throw new Error('expected one TransactWriteCommand');
    }
    const [reading, marker] = transactedItems(input);

    expect(marker).toEqual({ locationId: DUBLIN_ID, sk: `ARCHIVE#DAY#${DAY}` });
    // Archive weather is the hindcast's permanent input: TTL is per item, and
    // this item must not carry one.
    expect(reading).toBeDefined();
    expect(Object.keys(reading ?? {})).not.toContain('expiresAt');
    expect(reading?.temperature2mC).toBe(17.5);
    expect(reading?.source).toBe('open-meteo');
  });

  it('accepts a full 24-hour day', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});

    await adapter().putArchiveDay(
      DAY,
      hourlyFrom(`${DAY}T00:00:00Z`, 24).map((hour) => archiveReading(hour)),
    );

    const [input] = transactInputs();
    expect(input === undefined ? [] : transactedItems(input)).toHaveLength(25);
  });

  describe('refuses to write a marker it cannot stand behind', () => {
    const cases: {
      name: string;
      call: (adapter: WeatherAdapter) => Promise<void>;
      message: RegExp;
    }[] = [
      {
        name: 'no readings at all',
        call: (weather) => weather.putArchiveDay(DAY, []),
        message: /no readings/,
      },
      {
        name: 'more readings than there are hours in a day',
        call: (weather) =>
          weather.putArchiveDay(
            DAY,
            hourlyFrom(`${DAY}T00:00:00Z`, 25).map((hour) => archiveReading(hour)),
          ),
        message: /more than the 24 hours/,
      },
      {
        name: 'a reading belonging to another day',
        call: (weather) =>
          weather.putArchiveDay(DAY, [
            archiveReading(firstHour),
            archiveReading('2026-02-11T03:00:00Z'),
          ]),
        message: /different day/,
      },
      {
        name: 'readings from two locations',
        call: (weather) =>
          weather.putArchiveDay(DAY, [archiveReading(firstHour), archiveReading(secondHour, CORK)]),
        message: /span two locations/,
      },
      {
        name: 'a day that is not zero-padded YYYY-MM-DD',
        call: (weather) => weather.putArchiveDay('2026-2-10', [archiveReading(firstHour)]),
        message: /YYYY-MM-DD/,
      },
      {
        name: 'a day that does not exist in the calendar',
        // `archiveDayMarkerSortKey` validates shape only, so '2026-02-31'
        // produces a well-formed key. What makes it unwritable is that no
        // reading can be valid on it — the timestamp schema rejects the date
        // — so the day-prefix precondition is the real guard.
        call: (weather) => weather.putArchiveDay('2026-02-31', [archiveReading(firstHour)]),
        message: /different day/,
      },
    ];

    for (const { name, call, message } of cases) {
      it(`throws and sends nothing for ${name}`, async () => {
        ddbMock.on(TransactWriteCommand).resolves({});

        await expect(call(adapter())).rejects.toThrow(message);
        expect(ddbMock.calls()).toHaveLength(0);
      });
    }
  });

  it('wraps a failed transaction in a StorageError naming the marker it was writing', async () => {
    const failure = new Error('TransactionCanceledException');
    ddbMock.on(TransactWriteCommand).rejects(failure);

    const error = await storageErrorFrom(adapter().putArchiveDay(DAY, [archiveReading(firstHour)]));

    expect(error.context).toEqual({
      operation: 'putArchiveDay',
      table: TABLE,
      key: { locationId: DUBLIN_ID, sk: `ARCHIVE#DAY#${DAY}` },
    });
    expect(error.cause).toBe(failure);
  });
});

describe('putForecastWeather', () => {
  const HOUR = '2026-02-10T00:00:00Z';

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

    const error = await storageErrorFrom(adapter().putForecastWeather([forecastReading(HOUR)]));

    expect(error.context).toEqual({ operation: 'putForecastWeather', table: TABLE });
    expect(error.cause).toBe(failure);
  });
});

describe('listFetchedArchiveDays', () => {
  const FETCHED = '2026-02-10';
  const UNFETCHED = '2026-02-11';
  const UNDETERMINED = '2026-02-12';

  const marker = (day: string): Item => ({
    locationId: DUBLIN_ID,
    sk: archiveDayMarkerSortKey(day),
  });

  it('asks for exactly the requested markers, eventually consistently', async () => {
    ddbMock.on(BatchGetCommand).resolves({});

    await adapter().listFetchedArchiveDays(DUBLIN, [FETCHED, UNFETCHED]);

    const [input] = getInputs();
    const request = input?.RequestItems?.[TABLE];
    expect(request?.Keys).toEqual([marker(FETCHED), marker(UNFETCHED)]);
    // ADR 0002 Consequence 3: a ConsistentRead here would double the read cost
    // of a table provisioned at 3 RCU.
    expect(Object.keys(request ?? {})).not.toContain('ConsistentRead');
  });

  it('separates fetched, unfetched and undetermined days without coercing any of them', async () => {
    ddbMock.on(BatchGetCommand).resolves({
      Responses: { [TABLE]: [marker(FETCHED)] },
      UnprocessedKeys: { [TABLE]: { Keys: [marker(UNDETERMINED)] } },
    });

    const coverage = await adapter().listFetchedArchiveDays(DUBLIN, [
      FETCHED,
      UNFETCHED,
      UNDETERMINED,
    ]);

    expect(coverage.status).toBe('incomplete');
    expect(coverage.fetched).toEqual(new Set([FETCHED]));
    expect(coverage.status === 'incomplete' ? coverage.undeterminedDays : []).toEqual([
      UNDETERMINED,
    ]);
    // The unfetched day is in neither bucket — that is what "unfetched" is.
    expect(coverage.fetched.has(UNFETCHED)).toBe(false);
    // And the undetermined day is never reported as fetched: doing so would
    // skip data that then never arrives.
    expect(coverage.fetched.has(UNDETERMINED)).toBe(false);
  });

  it('reports complete once a retry resolves a previously unprocessed key', async () => {
    ddbMock
      .on(BatchGetCommand)
      .resolvesOnce({
        Responses: { [TABLE]: [marker(FETCHED)] },
        UnprocessedKeys: { [TABLE]: { Keys: [marker(UNDETERMINED)] } },
      })
      .resolves({ Responses: { [TABLE]: [marker(UNDETERMINED)] } });

    const coverage = await adapter().listFetchedArchiveDays(DUBLIN, [
      FETCHED,
      UNFETCHED,
      UNDETERMINED,
    ]);

    expect(coverage).toEqual({ status: 'complete', fetched: new Set([FETCHED, UNDETERMINED]) });
    expect(getInputs()).toHaveLength(2);
    expect(getInputs()[1]?.RequestItems?.[TABLE]?.Keys).toEqual([marker(UNDETERMINED)]);
  });

  it('reports every day fetched when every marker comes back', async () => {
    ddbMock.on(BatchGetCommand).resolves({
      Responses: { [TABLE]: [marker(FETCHED), marker(UNFETCHED)] },
    });

    expect(await adapter().listFetchedArchiveDays(DUBLIN, [FETCHED, UNFETCHED])).toEqual({
      status: 'complete',
      fetched: new Set([FETCHED, UNFETCHED]),
    });
  });

  it('de-duplicates repeated days, which BatchGetItem would reject', async () => {
    ddbMock.on(BatchGetCommand).resolves({});

    await adapter().listFetchedArchiveDays(DUBLIN, [FETCHED, FETCHED, UNFETCHED]);

    expect(getInputs()[0]?.RequestItems?.[TABLE]?.Keys).toEqual([
      marker(FETCHED),
      marker(UNFETCHED),
    ]);
  });

  it('chunks more than 100 days into separate BatchGet requests', async () => {
    ddbMock.on(BatchGetCommand).resolves({});
    const days = hourlyFrom('2026-01-01T00:00:00Z', 150 * 24)
      .filter((_unused, index) => index % 24 === 0)
      .map((iso) => iso.slice(0, 10));

    await adapter().listFetchedArchiveDays(DUBLIN, days);

    expect(getInputs().map((input) => input.RequestItems?.[TABLE]?.Keys?.length)).toEqual([
      100, 50,
    ]);
  });

  it('sends nothing when asked about no days', async () => {
    ddbMock.on(BatchGetCommand).resolves({});

    expect(await adapter().listFetchedArchiveDays(DUBLIN, [])).toEqual({
      status: 'complete',
      fetched: new Set(),
    });
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it('rejects a day that is not zero-padded YYYY-MM-DD before sending anything', async () => {
    ddbMock.on(BatchGetCommand).resolves({});

    await expect(adapter().listFetchedArchiveDays(DUBLIN, ['2026-2-10'])).rejects.toThrow(
      /YYYY-MM-DD/,
    );
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it('fails loudly, and not as an outage, on a marker item it did not write', async () => {
    // A marker carries the two key attributes and nothing else; this one has
    // lost its sort key, so it cannot say which day it vouches for.
    ddbMock.on(BatchGetCommand).resolves({
      Responses: { [TABLE]: [{ locationId: DUBLIN_ID, fetchedAt: '2026-02-10T00:00:00Z' }] },
    });

    const failure = await adapter()
      .listFetchedArchiveDays(DUBLIN, [FETCHED])
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(z.ZodError);
    expect(failure).not.toBeInstanceOf(StorageError);
  });

  it('wraps a rejected batch get in a StorageError naming the location', async () => {
    const failure = new Error('ProvisionedThroughputExceededException');
    ddbMock.on(BatchGetCommand).rejects(failure);

    const error = await storageErrorFrom(adapter().listFetchedArchiveDays(DUBLIN, [FETCHED]));

    expect(error.context).toEqual({
      operation: 'listFetchedArchiveDays',
      table: TABLE,
      key: { locationId: DUBLIN_ID },
    });
    expect(error.cause).toBe(failure);
  });
});

describe('queryArchiveRange', () => {
  const FROM = at('2026-02-10T00:00:00Z');
  const TO = at('2026-02-11T00:00:00Z');

  /**
   * The stored item for one hour, captured from what `putArchiveDay` would
   * actually write. Reading fixtures back out of the write path is what makes
   * the round-trip test below a round trip rather than two hand-written shapes
   * that agree with each other and with nothing else.
   */
  async function storedItem(validTime: string): Promise<Item> {
    ddbMock.reset();
    ddbMock.on(TransactWriteCommand).resolves({});
    await adapter().putArchiveDay(validTime.slice(0, 10), [archiveReading(validTime)]);
    const [input] = transactInputs();
    if (input === undefined) {
      throw new Error('expected one TransactWriteCommand');
    }
    const [item] = transactedItems(input);
    if (item === undefined) {
      throw new Error('expected the transaction to carry a reading item');
    }
    ddbMock.reset();
    return item;
  }

  async function storedItems(validTimes: readonly string[]): Promise<Item[]> {
    const items: Item[] = [];
    for (const validTime of validTimes) {
      items.push(await storedItem(validTime));
    }
    return items;
  }

  it('bounds the query on the archive run for one location, eventually consistently', async () => {
    ddbMock.on(QueryCommand).resolves({});

    await adapter().queryArchiveRange(DUBLIN, FROM, TO);

    const [input] = queryInputs();
    expect(input?.KeyConditionExpression).toBe(
      'locationId = :locationId AND sk BETWEEN :from AND :to',
    );
    expect(input?.ExpressionAttributeValues).toEqual({
      ':locationId': DUBLIN_ID,
      ':from': `ARCHIVE#T#${FROM}`,
      ':to': `ARCHIVE#T#${TO}`,
    });
    expect(Object.keys(input ?? {})).not.toContain('ConsistentRead');
  });

  it('asks the same question for 180°E and 180°W', async () => {
    ddbMock.on(QueryCommand).resolves({});

    await adapter().queryArchiveRange({ latitude: -16.5, longitude: 180 }, FROM, TO);
    await adapter().queryArchiveRange({ latitude: -16.5, longitude: -180 }, FROM, TO);

    const [east, west] = queryInputs();
    expect(east).toEqual(west);
    expect(east?.ExpressionAttributeValues?.[':locationId']).toBe('-16.50,-180.00');
  });

  it('round-trips a stored item back into the reading that produced it', async () => {
    const reading = archiveReading('2026-02-10T06:00:00Z');
    const items = await storedItems(['2026-02-10T06:00:00Z']);
    ddbMock.on(QueryCommand).resolves({ Items: items });

    expect(await adapter().queryArchiveRange(DUBLIN, FROM, TO)).toEqual([reading]);
  });

  it('includes the reading at the start of the window and excludes the one at its end', async () => {
    // BETWEEN is closed at both ends, so the endpoint exclusion that makes the
    // window half-open happens after the read.
    const items = await storedItems([FROM, '2026-02-10T12:00:00Z', TO]);
    ddbMock.on(QueryCommand).resolves({ Items: items });

    const readings = await adapter().queryArchiveRange(DUBLIN, FROM, TO);

    expect(readings.map((reading) => reading.validTime)).toEqual([FROM, '2026-02-10T12:00:00Z']);
  });

  it('follows pagination and preserves the order DynamoDB returned', async () => {
    const items = await storedItems(hourlyFrom('2026-02-10T00:00:00Z', 4));
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({
        Items: items.slice(0, 2),
        LastEvaluatedKey: { locationId: DUBLIN_ID, sk: 'x' },
      })
      .resolves({ Items: items.slice(2) });

    const readings = await adapter().queryArchiveRange(DUBLIN, FROM, TO);

    expect(readings.map((reading) => reading.validTime)).toEqual(hourlyFrom(FROM, 4));
    expect(queryInputs()).toHaveLength(2);
    expect(queryInputs()[0]?.ExclusiveStartKey).toBeUndefined();
    expect(queryInputs()[1]?.ExclusiveStartKey).toEqual({ locationId: DUBLIN_ID, sk: 'x' });
  });

  it('refuses a window that ends before it starts, rather than letting DynamoDB reject it', async () => {
    ddbMock.on(QueryCommand).resolves({});

    await expect(adapter().queryArchiveRange(DUBLIN, TO, FROM)).rejects.toThrow(/before it starts/);
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it('fails loudly, and not as an outage, on an item it did not write', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ locationId: DUBLIN_ID, sk: `ARCHIVE#T#${FROM}`, kind: 'archive' }],
    });

    const failure = await adapter()
      .queryArchiveRange(DUBLIN, FROM, TO)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(z.ZodError);
    expect(failure).not.toBeInstanceOf(StorageError);
  });

  it('wraps a rejected query in a StorageError naming the location', async () => {
    const failure = new Error('ResourceNotFoundException');
    ddbMock.on(QueryCommand).rejects(failure);

    const error = await storageErrorFrom(adapter().queryArchiveRange(DUBLIN, FROM, TO));

    expect(error.context).toEqual({
      operation: 'queryArchiveRange',
      table: TABLE,
      key: { locationId: DUBLIN_ID },
    });
    expect(error.cause).toBe(failure);
  });
});
