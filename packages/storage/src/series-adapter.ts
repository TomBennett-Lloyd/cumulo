import {
  BatchWriteCommand,
  QueryCommand,
  type BatchWriteCommandInput,
  type DynamoDBDocumentClient,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import {
  forecastSchema,
  generationReadingSchema,
  parseSeriesSortKey,
  seriesSortKey,
  type Forecast,
  type GenerationReading,
  type UtcIsoTimestamp,
} from '@cumulo/shared';

import {
  defaultBatchPolicy,
  drainBatches,
  type BatchPolicy,
  type BatchWriteOutcome,
} from './batch';
import { StorageError } from './errors';
import { SERIES_RETENTION_DAYS, expiresAtEpochSeconds } from './ttl';

/**
 * The `cumulo-series` adapter — per-site time series of forecasts and
 * generation actuals (ADR 0002 "Key design" table 2).
 *
 * One partition per site (`siteId`), sorted by `T#<validTime>#<kind>`. Valid
 * time leads the sort key and kind trails it, which is what makes access
 * pattern A4 — physics forecast, ML forecast and the measured actual,
 * **interleaved by time** — a single Query rather than three. This adapter
 * therefore returns a heterogeneous `SeriesPoint[]` in server order: re-sorting
 * or splitting it here would throw away the property the key design exists to
 * provide.
 *
 * `ConsistentRead` appears nowhere here (ADR 0002 Consequence 3) — see the
 * comment on `createStorageDocumentClient`. The `series` table's 21 RCU were
 * sized against eventually-consistent Query reads, and the dashboard fan-out is
 * the one user-visible path on that capacity.
 */

/** DynamoDB's hard ceiling on the request list of a single `BatchWriteItem`. */
const BATCH_WRITE_MAX_ITEMS = 25;

/**
 * The sort-key prefix that a range bound is built from — the same
 * `TIME_SEGMENT` that `seriesSortKey` writes (`@cumulo/shared/storage-key`).
 *
 * A *bare* `T#<timestamp>` is never a real item's sort key: every stored key
 * carries a `#FC#<model>` or `#GEN` suffix after the timestamp. That gap is
 * exactly what the half-open range below relies on.
 */
const TIME_BOUND_PREFIX = 'T#';

/** The key and TTL attributes a series item carries on top of its domain fields. */
export interface SeriesItemKeys {
  /** The sort key — `seriesSortKey(validTime, kind)`. */
  readonly sk: string;
  /**
   * DynamoDB TTL, in epoch **seconds**. Series data is disposable after the
   * 90-day accuracy window; see `ttl.ts`.
   */
  readonly expiresAt: number;
}

export type ForecastItem = Forecast & SeriesItemKeys;
export type GenerationReadingItem = GenerationReading & SeriesItemKeys;

/**
 * One point on a site's timeline. A forecast and an actual are different
 * things — different schemas, different meanings — so the Query that returns
 * them interleaved returns a discriminated union rather than a bag of optional
 * fields (typing rule 4). The caller switches; nothing has to guess from which
 * fields happen to be present.
 */
export type SeriesPoint =
  | { readonly type: 'forecast'; readonly forecast: Forecast }
  | { readonly type: 'generation'; readonly reading: GenerationReading };

/**
 * The result of a batch write is {@link BatchWriteOutcome}, defined in
 * `batch.ts` alongside the drain that produces it and shared with the weather
 * adapter. `BatchWriteItem` answers HTTP 200 while handing back the items it
 * declined (`UnprocessedItems`), so "the call succeeded" and "the data was
 * written" are different facts, and that union keeps them different all the way
 * out to the caller (ADR 0002 Consequence 4,
 * `docs/standards/error-handling.md` rule 2).
 */

/**
 * One entry of a `BatchWriteItem` request list, as the *document* client types
 * it (native JavaScript values, not `AttributeValue` shapes).
 *
 * Derived from the command input rather than restated, so the type the retry
 * loop carries is the same type the SDK hands back in `UnprocessedItems` —
 * which is what lets unprocessed requests be re-submitted with no assertion
 * anywhere in the loop.
 */
type SeriesWriteRequest = NonNullable<
  NonNullable<NonNullable<BatchWriteCommandInput['RequestItems']>[string]>[number]
>;

/** Attributes that address or expire an item rather than describing it. */
const KEY_ATTRIBUTES: ReadonlySet<string> = new Set(['sk', 'expiresAt']);

/**
 * Domain forecast → stored item.
 *
 * `siteId` is deliberately *not* stripped or renamed: it is a domain field of
 * `forecastSchema` that also serves as the partition key, so unlike the sites
 * table there is no key attribute to invent here. Only `sk` and `expiresAt` are
 * added, and `fromItem` removes exactly those two again.
 *
 * Exported for its tests; it is not part of the package's public surface.
 */
export function toForecastItem(forecast: Forecast): ForecastItem {
  return {
    ...forecast,
    sk: seriesSortKey(forecast.validTime, { kind: 'forecast', model: forecast.model }),
    expiresAt: expiresAtEpochSeconds(forecast.validTime, SERIES_RETENTION_DAYS),
  };
}

/**
 * Domain generation reading → stored item.
 *
 * Exported for its tests; it is not part of the package's public surface.
 */
export function toGenerationReadingItem(reading: GenerationReading): GenerationReadingItem {
  return {
    ...reading,
    sk: seriesSortKey(reading.validTime, { kind: 'generation' }),
    expiresAt: expiresAtEpochSeconds(reading.validTime, SERIES_RETENTION_DAYS),
  };
}

function domainAttributes(item: Record<string, unknown>): Record<string, unknown> {
  const domain: Record<string, unknown> = {};
  for (const [attribute, value] of Object.entries(item)) {
    if (!KEY_ATTRIBUTES.has(attribute)) {
      domain[attribute] = value;
    }
  }
  return domain;
}

/**
 * Stored item → domain point.
 *
 * The sort key is the discriminator: `parseSeriesSortKey` says whether this row
 * is a forecast (and from which model) or an actual, and the matching schema
 * then parses the domain attributes. Two things follow deliberately:
 *
 * - The parse is not ceremony. A table is a boundary, so its contents are
 *   `unknown` until a schema has looked at them (typing rule 3) — and it is the
 *   parse, not the sort key, that restores the branded `UtcIsoTimestamp` on
 *   `validTime` (`parseSeriesSortKey` returns a plain validated string).
 * - Both failure modes throw rather than returning a value: an unreadable sort
 *   key or an item that does not parse means the table holds something this
 *   code did not write — a violated invariant, not an outcome a caller could
 *   handle (`docs/standards/error-handling.md` rule 1). Neither is wrapped in a
 *   `StorageError`, which means "the call to AWS failed" and would send a reader
 *   looking in the wrong place.
 *
 * Exported for its tests; it is not part of the package's public surface.
 */
export function fromItem(item: Record<string, unknown>): SeriesPoint {
  const sortKey = item.sk;
  if (typeof sortKey !== 'string') {
    throw new Error(
      `Series item has no string sort key: ${JSON.stringify(sortKey)} (siteId ${JSON.stringify(item.siteId)})`,
    );
  }

  const { kind } = parseSeriesSortKey(sortKey);
  const domain = domainAttributes(item);

  return kind.kind === 'forecast'
    ? { type: 'forecast', forecast: forecastSchema.parse(domain) }
    : { type: 'generation', reading: generationReadingSchema.parse(domain) };
}

export interface SeriesAdapter {
  /** Writes forecasts from either model (F2/F3). Reports an incomplete drain honestly. */
  putForecasts(forecasts: readonly Forecast[]): Promise<BatchWriteOutcome>;
  putGenerationReadings(readings: readonly GenerationReading[]): Promise<BatchWriteOutcome>;
  /**
   * Every point in the half-open window `[fromInclusive, toExclusive)`, in
   * chronological server order, forecasts and actuals interleaved (A4/A5).
   */
  querySeriesRange(
    siteId: string,
    fromInclusive: UtcIsoTimestamp,
    toExclusive: UtcIsoTimestamp,
  ): Promise<SeriesPoint[]>;
  /** The next `limit` points at or after `fromInclusive`, ascending (A3). */
  querySeriesFrom(
    siteId: string,
    fromInclusive: UtcIsoTimestamp,
    limit: number,
  ): Promise<SeriesPoint[]>;
}

export interface SeriesAdapterDeps {
  readonly client: DynamoDBDocumentClient;
  /** Physical table name — build it with `storageTableName('series', env)`. */
  readonly tableName: string;
  /**
   * How hard to push an unprocessed batch before reporting `partial`. Tests
   * inject a fast one; production leaves it unset and gets
   * {@link defaultBatchPolicy}.
   */
  readonly batchPolicy?: BatchPolicy;
}

export function createSeriesAdapter(deps: SeriesAdapterDeps): SeriesAdapter {
  const { client, tableName } = deps;
  const batchPolicy = deps.batchPolicy ?? defaultBatchPolicy;

  /**
   * Runs SDK calls and converts a rejection into a `StorageError` carrying what
   * was being attempted and on what (`error-handling.md` rules 2b and 4).
   *
   * Only the sends are inside the `try`. Schema parsing happens on the way out,
   * so a drifted item keeps its own error instead of being disguised as an AWS
   * failure.
   */
  async function sending<TResult>(
    operation: string,
    key: Record<string, string> | undefined,
    call: () => Promise<TResult>,
  ): Promise<TResult> {
    try {
      return await call();
    } catch (cause) {
      throw new StorageError(
        { operation, table: tableName, ...(key === undefined ? {} : { key }) },
        { cause },
      );
    }
  }

  /**
   * Writes every item, re-submitting whatever DynamoDB declines, and reports
   * the leftovers as a count rather than as silence.
   */
  async function putSeriesItems(
    operation: string,
    items: readonly (ForecastItem | GenerationReadingItem)[],
  ): Promise<BatchWriteOutcome> {
    const requests: SeriesWriteRequest[] = items.map((item) => ({ PutRequest: { Item: item } }));

    const outcome = await sending(operation, undefined, () =>
      drainBatches(
        async (batch) => {
          const output = await client.send(
            new BatchWriteCommand({ RequestItems: { [tableName]: batch } }),
          );
          return output.UnprocessedItems?.[tableName] ?? [];
        },
        requests,
        BATCH_WRITE_MAX_ITEMS,
        batchPolicy,
      ),
    );

    return outcome.status === 'complete'
      ? { status: 'complete' }
      : { status: 'partial', unprocessedCount: outcome.unprocessed.length };
  }

  /**
   * Runs a Query to exhaustion, or until `maxItems` points have been collected.
   *
   * DynamoDB pages at 1 MB regardless of how few items that is in domain terms,
   * and it may return a short page with a `LastEvaluatedKey` even when more
   * matching items exist. A caller that ignored that would silently receive a
   * prefix of the answer — a chart quietly missing its afternoon, which is the
   * kind of half-truth this codebase treats as a failure rather than an
   * optimisation. `Limit` is likewise re-computed per page so that "the next
   * ten points" means ten points, not "up to ten, if they all happened to sit
   * in one page".
   */
  async function queryPoints(
    operation: string,
    siteId: string,
    input: QueryCommandInput,
    maxItems?: number,
  ): Promise<SeriesPoint[]> {
    const items = await sending(operation, { siteId }, async () => {
      const collected: Record<string, unknown>[] = [];
      let exclusiveStartKey: Record<string, unknown> | undefined;

      do {
        const remaining = maxItems === undefined ? undefined : maxItems - collected.length;
        const page = await client.send(
          new QueryCommand({
            ...input,
            ...(remaining === undefined ? {} : { Limit: remaining }),
            ...(exclusiveStartKey === undefined ? {} : { ExclusiveStartKey: exclusiveStartKey }),
          }),
        );
        collected.push(...(page.Items ?? []));
        exclusiveStartKey = page.LastEvaluatedKey;
      } while (
        exclusiveStartKey !== undefined &&
        (maxItems === undefined || collected.length < maxItems)
      );

      return collected;
    });

    return items.map(fromItem);
  }

  return {
    async putForecasts(forecasts) {
      return putSeriesItems('putForecasts', forecasts.map(toForecastItem));
    },

    async putGenerationReadings(readings) {
      return putSeriesItems('putGenerationReadings', readings.map(toGenerationReadingItem));
    },

    async querySeriesRange(siteId, fromInclusive, toExclusive) {
      // The half-open window `[from, to)`, expressed as a BETWEEN.
      //
      // DynamoDB permits exactly one comparator on the sort key, so the natural
      // `sk >= :from AND sk < :to` is not expressible — BETWEEN is the only
      // range operator, and BETWEEN is inclusive at both ends. The upper bound
      // is therefore the *bare* prefix `T#<to>`, with no kind suffix. Every real
      // item at `to` has a sort key of `T#<to>#FC#<model>` or `T#<to>#GEN`,
      // which is `T#<to>` plus more characters and so sorts strictly after it:
      // the bare bound excludes them. At the lower end `T#<from>` sorts at or
      // before every item at `from`, so those are included. Half-open falls out
      // of string order and needs no sentinel character.
      //
      // This holds only because timestamps are fixed-width (`timestamp.ts`);
      // `storage-key.test.ts` pins the two order properties as plain string
      // comparisons, and this query is their consumer.
      return queryPoints('querySeriesRange', siteId, {
        TableName: tableName,
        KeyConditionExpression: 'siteId = :siteId AND sk BETWEEN :from AND :to',
        ExpressionAttributeValues: {
          ':siteId': siteId,
          ':from': `${TIME_BOUND_PREFIX}${fromInclusive}`,
          ':to': `${TIME_BOUND_PREFIX}${toExclusive}`,
        },
        // Ascending is the SDK default, but it is stated because the order is
        // the contract: A4 plots these points on a time axis with the two
        // models and the actual interleaved.
        ScanIndexForward: true,
      });
    },

    async querySeriesFrom(siteId, fromInclusive, limit) {
      if (!Number.isInteger(limit) || limit < 1) {
        throw new Error(`querySeriesFrom: limit must be a positive integer, got ${String(limit)}`);
      }

      return queryPoints(
        'querySeriesFrom',
        siteId,
        {
          TableName: tableName,
          KeyConditionExpression: 'siteId = :siteId AND sk >= :from',
          ExpressionAttributeValues: {
            ':siteId': siteId,
            ':from': `${TIME_BOUND_PREFIX}${fromInclusive}`,
          },
          // Here the direction decides *which* items come back, not merely
          // their order: with a `Limit`, descending would return the points
          // before the window instead of the upcoming ones A3 asks for.
          ScanIndexForward: true,
        },
        limit,
      );
    },
  };
}
