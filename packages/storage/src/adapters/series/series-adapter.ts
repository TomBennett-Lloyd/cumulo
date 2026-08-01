import {
  BatchWriteCommand,
  QueryCommand,
  type BatchWriteCommandInput,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import type { Forecast, GenerationReading, UtcIsoTimestamp } from '@cumulo/shared';
import { z } from 'zod';

import {
  DYNAMODB_BATCH_WRITE_SIZE,
  defaultBatchPolicy,
  drainBatches,
  type BatchPolicy,
  type BatchWriteOutcome,
} from '../../batch';
import { StorageAdapterBase, type BatchingAdapterDeps } from '../storage-adapter-base';

import {
  TIME_BOUND_PREFIX,
  fromItem,
  toForecastItem,
  toGenerationReadingItem,
  type ForecastItem,
  type GenerationReadingItem,
  type SeriesPoint,
} from './series-item';

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

/**
 * The key of a stored series item, as {@link SeriesAdapter.deleteSiteSeries}
 * reads it back off a projected Query.
 *
 * A parse rather than a cast: a Query response is a boundary like any other
 * (typing rule 3), and a key attribute missing from it would otherwise become a
 * `DeleteRequest` addressed at `undefined` — which DynamoDB would reject for
 * the whole batch, taking the deletable items down with it.
 */
const seriesKeySchema = z.object({ siteId: z.string().min(1), sk: z.string().min(1) });

export class SeriesAdapter extends StorageAdapterBase {
  private readonly batchPolicy: BatchPolicy;

  constructor(deps: BatchingAdapterDeps) {
    super(deps);
    this.batchPolicy = deps.batchPolicy ?? defaultBatchPolicy;
  }

  /** Writes forecasts from either model (F2/F3). Reports an incomplete drain honestly. */
  async putForecasts(forecasts: readonly Forecast[]): Promise<BatchWriteOutcome> {
    return this.putSeriesItems('putForecasts', forecasts.map(toForecastItem));
  }

  async putGenerationReadings(readings: readonly GenerationReading[]): Promise<BatchWriteOutcome> {
    return this.putSeriesItems('putGenerationReadings', readings.map(toGenerationReadingItem));
  }

  /**
   * Every point in the half-open window `[fromInclusive, toExclusive)`, in
   * chronological server order, forecasts and actuals interleaved (A4/A5).
   */
  async querySeriesRange(
    siteId: string,
    fromInclusive: UtcIsoTimestamp,
    toExclusive: UtcIsoTimestamp,
  ): Promise<SeriesPoint[]> {
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
    const items = await this.queryAllPages(
      'querySeriesRange',
      { siteId },
      {
        TableName: this.tableName,
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
      },
    );

    return items.map(fromItem);
  }

  /** The next `limit` points at or after `fromInclusive`, ascending (A3). */
  async querySeriesFrom(
    siteId: string,
    fromInclusive: UtcIsoTimestamp,
    limit: number,
  ): Promise<SeriesPoint[]> {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`querySeriesFrom: limit must be a positive integer, got ${String(limit)}`);
    }

    return this.queryBoundedPoints('querySeriesFrom', siteId, limit, {
      TableName: this.tableName,
      KeyConditionExpression: 'siteId = :siteId AND sk >= :from',
      ExpressionAttributeValues: {
        ':siteId': siteId,
        ':from': `${TIME_BOUND_PREFIX}${fromInclusive}`,
      },
      // Here the direction decides *which* items come back, not merely
      // their order: with a `Limit`, descending would return the points
      // before the window instead of the upcoming ones A3 asks for.
      ScanIndexForward: true,
    });
  }

  /**
   * Deletes every series point of one site (X3) — the cleanup that follows an
   * evicted site, so the fleet cap bounds stored rows and not merely site rows.
   *
   * Read-then-delete rather than a range delete, because DynamoDB has no range
   * delete: the keys have to be enumerated first. The Query projects the two
   * key attributes alone, which keeps the read charge to the smallest item size
   * DynamoDB bills and means an evicted site's ~97 points cost a fraction of an
   * RCU to list.
   *
   * The deletes then draw on the `series` table's provisioned 14 WCU, shared
   * with the hourly ingestion cycle. A full ~97-item partition is ~97 write
   * units — under 7 seconds at 14 WCU with no burst assumed, and normally
   * instant against the burst reserve. That is fine for a fire-and-report
   * cleanup running behind a user's create: the outcome is returned rather than
   * awaited-and-ignored, so a partial drain is a fact the caller can log rather
   * than an orphan nobody hears about (the 90-day TTL is the backstop, not the
   * plan).
   */
  async deleteSiteSeries(siteId: string): Promise<BatchWriteOutcome> {
    const items = await this.queryAllPages(
      'deleteSiteSeries',
      { siteId },
      {
        TableName: this.tableName,
        KeyConditionExpression: 'siteId = :siteId',
        ExpressionAttributeValues: { ':siteId': siteId },
        ProjectionExpression: 'siteId, sk',
      },
    );

    return this.drainWriteRequests(
      'deleteSiteSeries',
      items.map((item) => ({ DeleteRequest: { Key: seriesKeySchema.parse(item) } })),
    );
  }

  /**
   * Writes every item, re-submitting whatever DynamoDB declines, and reports
   * the leftovers as a count rather than as silence.
   */
  private async putSeriesItems(
    operation: string,
    items: readonly (ForecastItem | GenerationReadingItem)[],
  ): Promise<BatchWriteOutcome> {
    return this.drainWriteRequests(
      operation,
      items.map((item) => ({ PutRequest: { Item: item } })),
    );
  }

  /**
   * Drains a list of write requests — puts or deletes alike — through the batch
   * machinery, reporting what never landed.
   *
   * Shared by the write paths and by {@link deleteSiteSeries} because the
   * mechanism is one thing: `BatchWriteItem` answers 200 while handing back
   * what it declined, and every caller of it has to re-submit and then report
   * honestly. A change to that loop would otherwise have to be made twice
   * (`docs/standards/structure.md` rule 7). Only the request list differs, and
   * that is a parameter rather than a mode flag.
   */
  private async drainWriteRequests(
    operation: string,
    requests: readonly SeriesWriteRequest[],
  ): Promise<BatchWriteOutcome> {
    const outcome = await this.sending(operation, undefined, () =>
      drainBatches(
        async (batch) => {
          const output = await this.client.send(
            new BatchWriteCommand({ RequestItems: { [this.tableName]: batch } }),
          );
          return output.UnprocessedItems?.[this.tableName] ?? [];
        },
        requests,
        DYNAMODB_BATCH_WRITE_SIZE,
        this.batchPolicy,
      ),
    );

    return outcome.status === 'complete'
      ? { status: 'complete' }
      : { status: 'partial', unprocessedCount: outcome.unprocessed.length };
  }

  /**
   * Collects exactly `maxItems` points, or every point there is, whichever runs
   * out first.
   *
   * Deliberately *not* `StorageAdapterBase.queryAllPages`, which the unbounded
   * reads above use. Both walk `LastEvaluatedKey` for the same reason —
   * DynamoDB pages at 1 MB regardless of how few items that is, and may hand
   * back a short page while more matching items exist — but this one also
   * re-computes `Limit` on every page, so that "the next ten points" means ten
   * points rather than "up to ten, if they all happened to sit in one page",
   * and stops as soon as the budget is filled. Folding the two together would
   * take an optional bound and three conditionals reading it: the mode flag
   * `docs/standards/structure.md` rule 7 names as the tell that two intents
   * were forced into one function.
   */
  private async queryBoundedPoints(
    operation: string,
    siteId: string,
    maxItems: number,
    input: QueryCommandInput,
  ): Promise<SeriesPoint[]> {
    const items = await this.sending(operation, { siteId }, async () => {
      const collected: Record<string, unknown>[] = [];
      let exclusiveStartKey: Record<string, unknown> | undefined;

      do {
        const page = await this.client.send(
          new QueryCommand({
            ...input,
            Limit: maxItems - collected.length,
            ...(exclusiveStartKey === undefined ? {} : { ExclusiveStartKey: exclusiveStartKey }),
          }),
        );
        collected.push(...(page.Items ?? []));
        exclusiveStartKey = page.LastEvaluatedKey;
      } while (exclusiveStartKey !== undefined && collected.length < maxItems);

      return collected;
    });

    return items.map(fromItem);
  }
}
