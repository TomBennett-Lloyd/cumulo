import {
  BatchWriteCommand,
  QueryCommand,
  type BatchWriteCommandInput,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import type { Forecast, GenerationReading, UtcIsoTimestamp } from '@cumulo/shared';

import {
  DYNAMODB_BATCH_WRITE_SIZE,
  defaultBatchPolicy,
  drainBatches,
  type BatchPolicy,
  type BatchWriteOutcome,
} from '../../batch';
import {
  StorageAdapterBase,
  type BatchingAdapterDeps,
  type QueryPaginationBound,
} from '../storage-adapter-base';

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
 * A window of series points, and whether the window was read to its end.
 *
 * The two facts travel together because separating them is precisely the bug:
 * `points` alone cannot say whether a short list is a quiet Saturday or a drain
 * that stopped at a caller's page budget with rows still to come. Only a caller
 * that passed a {@link QueryPaginationBound} can ever see `complete: false`, so
 * an unbounded read reads exactly as it always did — with one field it may
 * ignore, rather than one it may not.
 *
 * A flat record rather than a discriminated union (`docs/standards/typing.md`
 * rule 4): a truncated read is not a different *mode* of answer, it is the same
 * answer carrying an honest caveat, and the points of a truncated window are
 * real points the caller may legitimately log, count or discard.
 */
export interface SeriesRangeResult {
  readonly points: SeriesPoint[];
  /** False when a bound stopped pagination with more of the window unread. */
  readonly complete: boolean;
}

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
   *
   * The optional `bound` prices the drain in round trips for a caller that has
   * a deadline — the API's read routes, whose invocation is capped well below
   * the worst case of an unbounded page walk. A caller that passes one must act
   * on {@link SeriesRangeResult.complete}: a truncated series returned as if it
   * were whole is the "quietly missing its afternoon" half-truth
   * `queryAllPages` exists to prevent.
   */
  async querySeriesRange(
    siteId: string,
    fromInclusive: UtcIsoTimestamp,
    toExclusive: UtcIsoTimestamp,
    bound?: QueryPaginationBound,
  ): Promise<SeriesRangeResult> {
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
    const { items, complete } = await this.queryAllPages(
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
      bound,
    );

    return { points: items.map(fromItem), complete };
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
      this.batchPolicy,
    );
  }

  /**
   * Drains a list of write requests through the batch machinery, reporting what
   * never landed.
   *
   * Honesty is why the write paths come through here rather than sending a
   * `BatchWriteCommand` themselves: `BatchWriteItem` answers 200 while handing
   * back what it declined, so a caller reading the HTTP status alone would
   * report an ingestion cycle written when part of it was refused. The count
   * that comes back out is that refusal made visible
   * (`docs/standards/error-handling.md` rule 2).
   */
  private async drainWriteRequests(
    operation: string,
    requests: readonly SeriesWriteRequest[],
    policy: BatchPolicy,
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
        policy,
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
