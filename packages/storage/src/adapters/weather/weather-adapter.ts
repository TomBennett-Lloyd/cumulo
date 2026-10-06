import {
  BatchGetCommand,
  BatchWriteCommand,
  TransactWriteCommand,
  type BatchWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import {
  archiveDayMarkerSortKey,
  locationId,
  weatherSortKey,
  type ArchiveWeatherReading,
  type ForecastWeatherReading,
  type UtcIsoTimestamp,
  type WeatherReading,
} from '@cumulo/shared';

import {
  DYNAMODB_BATCH_WRITE_SIZE,
  MAX_BACKOFF_DELAY_MS,
  defaultBatchPolicy,
  drainBatches,
  fullJitterDelayMs,
  realSleep,
  requireUsablePolicy,
  type BatchPolicy,
  type BatchWriteOutcome,
} from '../../batch';
import { requireUniqueKeys } from '../../write-preconditions';
import { StorageAdapterBase, type BatchingAdapterDeps } from '../storage-adapter-base';
import { capacityCancelled } from '../transaction-cancellation';

import {
  fromItem,
  markerKeySchema,
  toArchiveItem,
  toForecastItem,
  type MarkerKey,
  type WeatherItem,
  type WeatherLocation,
} from './weather-item';

/**
 * The `cumulo-weather-<env>` adapter (ADR 0002, "Key design" §3).
 *
 * PK `locationId` — computed from each reading's own coordinates by
 * `@cumulo/shared`'s `locationId`, which is *also* ingestion (#11)'s
 * de-duplication key, so the two cannot drift. SK `<source>#T#<validTime>`
 * (`weatherSortKey`), plus one marker item per fetched archive day at
 * `ARCHIVE#DAY#<YYYY-MM-DD>`. `weather-item.ts` holds that wire format.
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

/**
 * Three-way answer to "which of these location-days has the archive fetch
 * already covered?" (access pattern H2).
 *
 * A day is **fetched** if its marker came back, **unfetched** if it is absent
 * from `fetched` and from `undeterminedDays`, and **undetermined** if DynamoDB
 * never answered for it. Undetermined is deliberately its own outcome rather
 * than being folded into either neighbour: calling it unfetched spends
 * Open-Meteo quota this project is built to respect, and calling it fetched
 * skips data that then never arrives.
 */
export type ArchiveDayCoverage =
  | { readonly status: 'complete'; readonly fetched: Set<string> }
  | {
      readonly status: 'incomplete';
      readonly fetched: Set<string>;
      readonly undeterminedDays: string[];
    };

/** An archive day is hourly, so at most 24 readings — 25 transaction items with the marker. */
const MAX_ARCHIVE_DAY_READINGS = 24;

/** DynamoDB's hard per-request limit for `BatchGetItem`; the write-side twin
 * lives in `batch.ts`, which both batching adapters share. */
const BATCH_GET_SIZE = 100;

/**
 * The document client's own write-request type, reached through the command
 * input so it cannot drift from the SDK's.
 */
type WriteRequestBatch = NonNullable<NonNullable<BatchWriteCommandInput['RequestItems']>[string]>;
type WriteRequestItem = WriteRequestBatch[number];

export class WeatherAdapter extends StorageAdapterBase {
  private readonly batchPolicy: BatchPolicy;

  constructor(deps: BatchingAdapterDeps) {
    super(deps);
    this.batchPolicy = deps.batchPolicy ?? defaultBatchPolicy;
  }

  /** Appends forecast weather for a horizon (access pattern I2). */
  async putForecastWeather(
    readings: readonly ForecastWeatherReading[],
  ): Promise<BatchWriteOutcome> {
    // The items exactly as they will be stored, built once. The precondition
    // below then reads its key off them — `locationId|sk`, the pair DynamoDB
    // actually addresses — instead of re-deriving it from the reading, so the
    // key that is checked cannot drift from the key that is written.
    const items = readings.map((reading) => toForecastItem(reading));

    // Two readings for one location-hour are refused rather than de-duplicated
    // last-wins (see `requireUniqueKeys`): a provider response repeating an hour
    // is a fault this cycle should name, not quietly halve.
    //
    // Before `sending`, like every check below it: inside the wrap, a caller's
    // bad input would surface as a `StorageError` blaming the table (#166).
    requireUniqueKeys(
      'putForecastWeather',
      items.map((item) => `${item.locationId}|${item.sk}`),
    );
    requireUsablePolicy('putForecastWeather', this.batchPolicy);

    const requests = items.map((item) => ({
      PutRequest: { Item: item },
    }));

    const sendWriteBatch = async (batch: WriteRequestItem[]): Promise<WriteRequestItem[]> => {
      const response = await this.client.send(
        new BatchWriteCommand({ RequestItems: { [this.tableName]: batch } }),
      );
      return response.UnprocessedItems?.[this.tableName] ?? [];
    };

    const outcome = await this.sending('putForecastWeather', undefined, () =>
      drainBatches(sendWriteBatch, requests, DYNAMODB_BATCH_WRITE_SIZE, this.batchPolicy),
    );

    return outcome.status === 'complete'
      ? { status: 'complete' }
      : { status: 'partial', unprocessedCount: outcome.unprocessed.length };
  }

  /**
   * Writes one location-day of archive weather and its marker (H3).
   *
   * This is the package's largest single write: 25 items ≈ 50 WCU in one
   * instant. `cumulo-weather` is on-demand now (#156): on-demand still enforces
   * per-partition instantaneous limits, and every item in this transaction
   * shares one `locationId` partition by construction, so a burst of
   * location-days can still be cancelled for capacity (`STORAGE_MAX_ATTEMPTS`
   * shape 3).
   *
   * Worst case: `STORAGE_BATCH_PAGE_WORST_MS`.
   */
  async putArchiveDay(day: string, readings: readonly ArchiveWeatherReading[]): Promise<void> {
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

    // With one location and one day already enforced above, a duplicate item is
    // a repeated hour — so `validTime` is the whole key here. Refused, not
    // de-duplicated (see `requireUniqueKeys`): `TransactWriteItems` rejects a
    // transaction carrying a key twice, so the choice is only between a
    // caller-blaming refusal here and a `ValidationException` dressed as a
    // `StorageError` there.
    requireUniqueKeys(
      'putArchiveDay',
      readings.map((reading) => reading.validTime),
    );

    // One transaction, so the marker and the readings it vouches for land
    // together or not at all: a partial fetch can never leave a marker
    // claiming coverage it does not have (ADR 0002 §3 / #16).
    const transactItems = [
      ...readings.map((reading) => ({
        Put: { TableName: this.tableName, Item: toArchiveItem(reading) },
      })),
      { Put: { TableName: this.tableName, Item: { locationId: partitionKey, sk: markerSortKey } } },
    ];

    // Re-issuing the *same* items is safe: a cancelled transaction is atomic in
    // failure, so nothing was written, and every item here is a plain Put with
    // no condition — a second send either lands the whole day or is cancelled
    // again.
    // The loop below is bounded by `maxAttempts`, so a policy below 1 would
    // run no iterations at all and resolve — a day reported written that was
    // never sent.
    // Outside `sending` deliberately: a policy this broken is a programming
    // error, not a storage outage, and dressing it as a `StorageError` would
    // tell an operator DynamoDB was down (error-handling rule 1).
    requireUsablePolicy('putArchiveDay', this.batchPolicy);

    const sleep = this.batchPolicy.sleep ?? realSleep;

    // One `sending` around the whole loop, so the `StorageError` is still
    // constructed in exactly one place with one context (base-class rule): what
    // surfaces is the *last* cancellation, not the first.
    await this.sending(
      'putArchiveDay',
      { locationId: partitionKey, sk: markerSortKey },
      async () => {
        for (let attempt = 1; attempt <= this.batchPolicy.maxAttempts; attempt += 1) {
          try {
            await this.client.send(new TransactWriteCommand({ TransactItems: transactItems }));
            return;
          } catch (cause) {
            if (!capacityCancelled(cause) || attempt === this.batchPolicy.maxAttempts) {
              throw cause;
            }
            await sleep(
              fullJitterDelayMs(attempt, {
                baseDelayMs: this.batchPolicy.baseDelayMs,
                maxDelayMs: MAX_BACKOFF_DELAY_MS,
              }),
            );
          }
        }
      },
    );
  }

  /** Reports archive-fetch coverage for the given days at one location (H2). */
  async listFetchedArchiveDays(
    coords: WeatherLocation,
    days: readonly string[],
  ): Promise<ArchiveDayCoverage> {
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
    // transport wrap below: a marker item that drifted, or an answer for a
    // key we never asked about, is a violated invariant and must not be
    // dressed up as a `StorageError`, which means an outage. Same rule as
    // `queryArchiveRange` — see the comment there.
    const answeredMarkers: WeatherItem[] = [];

    const sendGetBatch = async (batch: WeatherItem[]): Promise<WeatherItem[]> => {
      const response = await this.client.send(
        new BatchGetCommand({ RequestItems: { [this.tableName]: { Keys: batch } } }),
      );
      answeredMarkers.push(...(response.Responses?.[this.tableName] ?? []));
      // Whatever DynamoDB declined stays pending; `drainBatches` retries it
      // and hands back only what never got an answer.
      return response.UnprocessedKeys?.[this.tableName]?.Keys ?? [];
    };

    requireUsablePolicy('listFetchedArchiveDays', this.batchPolicy);

    const outcome = await this.sending('listFetchedArchiveDays', { locationId: partitionKey }, () =>
      drainBatches(sendGetBatch, keys, BATCH_GET_SIZE, this.batchPolicy),
    );

    const dayOfItem = (item: WeatherItem): string => dayOf(markerKeySchema.parse(item).sk);
    const fetched = new Set(answeredMarkers.map(dayOfItem));

    return outcome.status === 'complete'
      ? { status: 'complete', fetched }
      : {
          status: 'incomplete',
          fetched,
          undeterminedDays: outcome.unprocessed.map(dayOfItem),
        };
  }

  /** Reads archive weather over the half-open window `[from, to)` (H1). */
  async queryArchiveRange(
    coords: WeatherLocation,
    fromInclusive: UtcIsoTimestamp,
    toExclusive: UtcIsoTimestamp,
  ): Promise<WeatherReading[]> {
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
    //   `@cumulo/shared`, so the endpoint is dropped after the read instead.
    const lowerBound = weatherSortKey('archive', fromInclusive);
    const upperBound = weatherSortKey('archive', toExclusive);

    // Only the transport is wrapped. Parsing happens after it, so a stored item
    // that is not a weather reading — a violated invariant — cannot be dressed
    // up as a `StorageError`, which means an outage.
    const { items } = await this.queryAllPages(
      'queryArchiveRange',
      { locationId: partitionKey },
      {
        TableName: this.tableName,
        KeyConditionExpression: 'locationId = :locationId AND sk BETWEEN :from AND :to',
        ExpressionAttributeValues: {
          ':locationId': partitionKey,
          ':from': lowerBound,
          ':to': upperBound,
        },
      },
    );

    return items.map(fromItem).filter((reading) => reading.validTime !== toExclusive);
  }
}
