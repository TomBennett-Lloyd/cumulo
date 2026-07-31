import {
  BatchGetCommand,
  BatchWriteCommand,
  QueryCommand,
  TransactWriteCommand,
  type BatchWriteCommandInput,
  type DynamoDBDocumentClient,
  type NativeAttributeValue,
} from '@aws-sdk/lib-dynamodb';
import {
  archiveDayMarkerSortKey,
  locationId,
  weatherReadingSchema,
  weatherSortKey,
  type UtcIsoTimestamp,
  type WeatherReading,
} from '@cumulo/shared';
import { z } from 'zod';

import {
  defaultBatchPolicy,
  drainBatches,
  type BatchPolicy,
  type BatchWriteOutcome,
} from './batch';
import { StorageError } from './errors';
import { SERIES_RETENTION_DAYS, expiresAtEpochSeconds } from './ttl';

/**
 * The `cumulo-weather-<env>` adapter (ADR 0002, "Key design" §3).
 *
 * PK `locationId` — computed from each reading's own coordinates by
 * `@cumulo/shared`'s `locationId`, which is *also* ingestion (#11)'s
 * de-duplication key, so the two cannot drift. SK `<source>#T#<validTime>`
 * (`weatherSortKey`), plus one marker item per fetched archive day at
 * `ARCHIVE#DAY#<YYYY-MM-DD>`.
 *
 * One table holds two lifetimes: forecast weather expires by TTL, archive
 * weather is kept forever (TTL is per item, so `expiresAt` is simply absent on
 * archive items and on markers).
 *
 * `ConsistentRead` is set nowhere here — ADR 0002 Consequence 3 sized the read
 * capacity against Query's default eventually-consistent reads, and this
 * table's readers are all offline paths. `client.ts` states the rule; the tests
 * assert no command input carries the flag.
 */

/** Where a weather reading is: the two schema fields `locationId` is built from. */
export type WeatherLocation = Pick<WeatherReading, 'latitude' | 'longitude'>;

/**
 * The two halves of `weatherReadingSchema`'s `kind` axis, narrowed at the type
 * level. The adapter never inspects `kind` at runtime: `putForecastWeather` and
 * `putArchiveDay` write different sort-key prefixes and different TTLs, so
 * handing one the other's readings has to be a compile error rather than a
 * runtime check nobody exercises.
 */
export type ForecastWeatherReading = WeatherReading & { readonly kind: 'forecast' };
export type ArchiveWeatherReading = WeatherReading & { readonly kind: 'archive' };

/**
 * The outcome of a batched write is {@link BatchWriteOutcome}, defined in
 * `batch.ts` and shared with the series adapter. `BatchWriteItem` answers
 * HTTP 200 while handing back the items it declined (`UnprocessedItems`), so
 * "complete" is a claim this adapter only makes when the batch genuinely
 * drained (ADR 0002 Consequence 4).
 */

/**
 * Three-way answer to "which of these location-days has the archive fetch
 * already covered?" (access pattern H2).
 *
 * A day is **fetched** if its marker came back, **unfetched** if it is absent
 * from `fetched` and from `undeterminedDays`, and **undetermined** if DynamoDB
 * never answered for it. Undetermined is deliberately its own outcome rather
 * than being folded into either neighbour: calling it unfetched spends
 * Open-Meteo quota this project is built to respect, and calling it fetched
 * skips data that then never arrives. The caller decides (retry later, or fetch
 * and pay), which it can only do if we tell it the truth.
 */
export type ArchiveDayCoverage =
  | { readonly status: 'complete'; readonly fetched: Set<string> }
  | {
      readonly status: 'incomplete';
      readonly fetched: Set<string>;
      readonly undeterminedDays: string[];
    };

export interface WeatherAdapter {
  /** Appends forecast weather for a horizon (access pattern I2). */
  putForecastWeather(readings: readonly ForecastWeatherReading[]): Promise<BatchWriteOutcome>;
  /** Writes one location-day of archive weather and its marker (H3). */
  putArchiveDay(day: string, readings: readonly ArchiveWeatherReading[]): Promise<void>;
  /** Reports archive-fetch coverage for the given days at one location (H2). */
  listFetchedArchiveDays(
    coords: WeatherLocation,
    days: readonly string[],
  ): Promise<ArchiveDayCoverage>;
  /** Reads archive weather over the half-open window `[from, to)` (H1). */
  queryArchiveRange(
    coords: WeatherLocation,
    fromInclusive: UtcIsoTimestamp,
    toExclusive: UtcIsoTimestamp,
  ): Promise<WeatherReading[]>;
}

export interface WeatherAdapterDeps {
  readonly client: DynamoDBDocumentClient;
  readonly tableName: string;
  /** Overridden only by tests that need the retry loop to cost no wall-clock time. */
  readonly batchPolicy?: BatchPolicy;
}

/**
 * Forecast weather is kept exactly as long as the series it explains
 * (`SERIES_RETENTION_DAYS`). Tying the two is deliberate: a stored forecast
 * whose input weather had already expired would be unexplainable, and #16's
 * hindcast replays over *archive* weather, which never expires at all.
 */
export const FORECAST_WEATHER_RETENTION_DAYS = SERIES_RETENTION_DAYS;

/** An archive day is hourly, so at most 24 readings — 25 transaction items with the marker. */
const MAX_ARCHIVE_DAY_READINGS = 24;

/** DynamoDB's hard per-request limits for the two batch APIs. */
const BATCH_WRITE_SIZE = 25;
const BATCH_GET_SIZE = 100;

type WeatherItem = Record<string, NativeAttributeValue>;

/**
 * The document client's own write-request type, reached through the command
 * input so it cannot drift from the SDK's.
 */
type WriteRequestBatch = NonNullable<NonNullable<BatchWriteCommandInput['RequestItems']>[string]>;
type WriteRequestItem = WriteRequestBatch[number];

/** A marker key, and the shape of a marker item — it has no other attributes. */
const markerKeySchema = z.object({ locationId: z.string(), sk: z.string() });
type MarkerKey = z.infer<typeof markerKeySchema>;

function toForecastItem(reading: ForecastWeatherReading): WeatherItem {
  return {
    ...reading,
    locationId: locationId(reading),
    sk: weatherSortKey('forecast', reading.validTime),
    expiresAt: expiresAtEpochSeconds(reading.validTime, FORECAST_WEATHER_RETENTION_DAYS),
  };
}

function toArchiveItem(reading: ArchiveWeatherReading): WeatherItem {
  // No `expiresAt`: archive weather is the hindcast's permanent input (ADR 0002
  // §3 — "`expiresAt` on `FORECAST` items only").
  return {
    ...reading,
    locationId: locationId(reading),
    sk: weatherSortKey('archive', reading.validTime),
  };
}

/**
 * The attributes this adapter owns rather than the domain: the two key
 * attributes and the TTL. Everything else in an item is a weather-reading
 * field.
 */
const STORAGE_ATTRIBUTES = new Set(['locationId', 'sk', 'expiresAt']);

/**
 * Storage-owned attributes are removed before parsing, rather than left for
 * zod to strip, so the boundary is stated here: an item that carries anything
 * else this code did not write fails loudly on the domain fields.
 */
function fromItem(item: WeatherItem): WeatherReading {
  const domainFields = Object.fromEntries(
    Object.entries(item).filter(([attribute]) => !STORAGE_ATTRIBUTES.has(attribute)),
  );
  return weatherReadingSchema.parse(domainFields);
}

export function createWeatherAdapter(deps: WeatherAdapterDeps): WeatherAdapter {
  const { client, tableName } = deps;
  const batchPolicy = deps.batchPolicy ?? defaultBatchPolicy;

  const sendWriteBatch = async (batch: WriteRequestItem[]): Promise<WriteRequestItem[]> => {
    const response = await client.send(
      new BatchWriteCommand({ RequestItems: { [tableName]: batch } }),
    );
    return response.UnprocessedItems?.[tableName] ?? [];
  };

  return {
    async putForecastWeather(readings) {
      const requests = readings.map((reading) => ({
        PutRequest: { Item: toForecastItem(reading) },
      }));

      let outcome;
      try {
        outcome = await drainBatches(sendWriteBatch, requests, BATCH_WRITE_SIZE, batchPolicy);
      } catch (cause) {
        // Rule 2b: the SDK's rejection is unexpected, so it gains context and
        // propagates. A batch that merely failed to drain is not this branch —
        // that is a value, returned below.
        throw new StorageError({ operation: 'putForecastWeather', table: tableName }, { cause });
      }

      return outcome.status === 'complete'
        ? { status: 'complete' }
        : { status: 'partial', unprocessedCount: outcome.unprocessed.length };
    },

    async putArchiveDay(day, readings) {
      // Preconditions first, and all of them before anything is sent. These are
      // violated invariants, not domain outcomes (error-handling rule 1), and
      // they are the *only* guard on which day a marker can claim:
      // `archiveDayMarkerSortKey` checks the shape `YYYY-MM-DD` and nothing
      // more, so '2026-02-31' produces a perfectly well-formed sort key. What
      // makes an impossible day unwritable is the day-prefix check below —
      // `utcIsoTimestampSchema` rejects impossible calendar dates, so no
      // reading can carry a validTime starting '2026-02-31T', and a non-empty
      // readings list is required.
      const markerSortKey = archiveDayMarkerSortKey(day);

      const [first, ...others] = readings;
      if (first === undefined) {
        throw new Error(`putArchiveDay: refusing to write a marker for ${day} with no readings`);
      }
      if (readings.length > MAX_ARCHIVE_DAY_READINGS) {
        throw new Error(
          `putArchiveDay: ${day} has ${String(readings.length)} readings, more than the ${String(MAX_ARCHIVE_DAY_READINGS)} hours in a day`,
        );
      }

      const dayPrefix = `${day}T`;
      const misdated = readings.find((reading) => !reading.validTime.startsWith(dayPrefix));
      if (misdated !== undefined) {
        throw new Error(
          `putArchiveDay: ${day} was given a reading valid at ${misdated.validTime}, which is a different day`,
        );
      }

      const partitionKey = locationId(first);
      const foreign = others.find((reading) => locationId(reading) !== partitionKey);
      if (foreign !== undefined) {
        throw new Error(
          `putArchiveDay: readings span two locations, ${partitionKey} and ${locationId(foreign)}`,
        );
      }

      // One transaction, so the marker and the readings it vouches for land
      // together or not at all: a partial fetch can never leave a marker
      // claiming coverage it does not have (ADR 0002 §3 / #16). Splitting this
      // into a batch write plus a marker put would reintroduce exactly the
      // window that costs Open-Meteo quota to discover.
      const transactItems = [
        ...readings.map((reading) => ({
          Put: { TableName: tableName, Item: toArchiveItem(reading) },
        })),
        { Put: { TableName: tableName, Item: { locationId: partitionKey, sk: markerSortKey } } },
      ];

      try {
        await client.send(new TransactWriteCommand({ TransactItems: transactItems }));
      } catch (cause) {
        throw new StorageError(
          {
            operation: 'putArchiveDay',
            table: tableName,
            key: { locationId: partitionKey, sk: markerSortKey },
          },
          { cause },
        );
      }
    },

    async listFetchedArchiveDays(coords, days) {
      const partitionKey = locationId(coords);

      // Keyed by sort key, which de-duplicates the request: BatchGetItem
      // rejects a request containing the same key twice, and "have these days
      // been fetched?" is a set question anyway.
      const daysBySortKey = new Map<string, string>(
        days.map((day) => [archiveDayMarkerSortKey(day), day]),
      );
      const dayOf = (sortKey: string): string => {
        const day = daysBySortKey.get(sortKey);
        if (day === undefined) {
          throw new Error(
            `listFetchedArchiveDays: DynamoDB answered for an unrequested key ${sortKey}`,
          );
        }
        return day;
      };

      const keys: MarkerKey[] = [...daysBySortKey.keys()].map((sortKey) => ({
        locationId: partitionKey,
        sk: sortKey,
      }));

      // Answered markers accumulate exactly as DynamoDB returned them. Nothing
      // is parsed or mapped inside `sendGetBatch`, because that runs inside the
      // transport `try` below: a marker item that drifted, or an answer for a
      // key we never asked about, is a violated invariant and must not be
      // dressed up as a `StorageError`, which means an outage. Same rule as
      // `queryArchiveRange` — see the comment there.
      const answeredMarkers: WeatherItem[] = [];

      const sendGetBatch = async (batch: WeatherItem[]): Promise<WeatherItem[]> => {
        const response = await client.send(
          new BatchGetCommand({ RequestItems: { [tableName]: { Keys: batch } } }),
        );
        answeredMarkers.push(...(response.Responses?.[tableName] ?? []));
        // Whatever DynamoDB declined stays pending; `drainBatches` retries it
        // and hands back only what never got an answer.
        return response.UnprocessedKeys?.[tableName]?.Keys ?? [];
      };

      let outcome;
      try {
        outcome = await drainBatches(sendGetBatch, keys, BATCH_GET_SIZE, batchPolicy);
      } catch (cause) {
        throw new StorageError(
          {
            operation: 'listFetchedArchiveDays',
            table: tableName,
            key: { locationId: partitionKey },
          },
          { cause },
        );
      }

      const dayOfItem = (item: WeatherItem): string => dayOf(markerKeySchema.parse(item).sk);
      const fetched = new Set(answeredMarkers.map(dayOfItem));

      return outcome.status === 'complete'
        ? { status: 'complete', fetched }
        : {
            status: 'incomplete',
            fetched,
            undeterminedDays: outcome.unprocessed.map(dayOfItem),
          };
    },

    async queryArchiveRange(coords, fromInclusive, toExclusive) {
      if (toExclusive < fromInclusive) {
        throw new Error(
          `queryArchiveRange: window ends at ${toExclusive}, before it starts at ${fromInclusive}`,
        );
      }

      const partitionKey = locationId(coords);
      // BETWEEN is the only way to bound a sort key on both sides — DynamoDB
      // permits one comparator per key condition — and it is closed at both
      // ends. Two exclusions are therefore structural and one is not:
      //
      // - day markers (`ARCHIVE#DAY#…`) sort below every reading
      //   (`ARCHIVE#T#…`) because 'D' < 'T', so the lower bound excludes them;
      // - forecast weather (`FORECAST#…`) sorts above every archive key
      //   because 'A' < 'F', so the upper bound excludes it;
      // - the reading *at* `toExclusive` does not: unlike a `cumulo-series` key,
      //   which carries a `#<kind>` suffix that the bare `T#<to>` bound sorts
      //   below, a weather sort key ends at the timestamp itself, so there is
      //   nothing left to sort past. Trimming a character off the bound would
      //   work byte-wise but would hard-code the key format outside
      //   `@cumulo/shared`, so the endpoint is dropped after the read instead —
      //   at most one extra item, against a table sized at 3 RCU for offline
      //   readers.
      const lowerBound = weatherSortKey('archive', fromInclusive);
      const upperBound = weatherSortKey('archive', toExclusive);

      const items: WeatherItem[] = [];
      let cursor: Record<string, NativeAttributeValue> | undefined;

      // Only the transport is inside the `try`. Parsing happens after it, so a
      // stored item that is not a weather reading — a violated invariant —
      // cannot be dressed up as a `StorageError`, which means an outage.
      try {
        do {
          const response = await client.send(
            new QueryCommand({
              TableName: tableName,
              KeyConditionExpression: 'locationId = :locationId AND sk BETWEEN :from AND :to',
              ExpressionAttributeValues: {
                ':locationId': partitionKey,
                ':from': lowerBound,
                ':to': upperBound,
              },
              ...(cursor === undefined ? {} : { ExclusiveStartKey: cursor }),
            }),
          );

          items.push(...(response.Items ?? []));
          cursor = response.LastEvaluatedKey;
        } while (cursor !== undefined);
      } catch (cause) {
        throw new StorageError(
          { operation: 'queryArchiveRange', table: tableName, key: { locationId: partitionKey } },
          { cause },
        );
      }

      return items.map(fromItem).filter((reading) => reading.validTime !== toExclusive);
    },
  };
}
