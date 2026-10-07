import type { ApiResponse } from '../http/response';

/**
 * HTTP caching for the metered reads, scoped to the hourly data cycle (#583).
 *
 * Stored series rows change only when an ingestion cycle and the forecast passes
 * behind it have run, so a body served inside one cycle stays true until the
 * next: the browser may keep it until then, and a revalidation carrying this
 * cycle's ETag is answered 304 before the limiter and before any storage read.
 */

/**
 * The ingestion schedule, mirrored from `infra/ingestion/schedule.tf`
 * (`aws_cloudwatch_event_rule.hourly_cycle`) and held equal to it by
 * `check:infra-mirrors` (`docs/standards/architecture.md` rule 8).
 */
export const INGESTION_SCHEDULE_EXPRESSION = 'cron(7 * * * ? *)';

/**
 * How long after the schedule fires a cycle's rows are taken as written: the
 * ingestion function's full timeout (`infra/ingestion/lambda.tf`) plus the
 * forecast passes it enqueues. A pass landing later is served the previous
 * cycle's body until the next boundary — the residual #583 states.
 */
export const CYCLE_SETTLE_SECONDS = 480;

const SECONDS_PER_HOUR = 3600;

const scheduleMinute = (expression: string): number => {
  const match = /^cron\((\d{1,2}) \* \* \* \? \*\)$/.exec(expression);
  const minute = Number(match?.[1]);
  // A violated invariant (`docs/standards/error-handling.md` rule 1): the
  // boundary arithmetic below assumes an hourly schedule at a fixed minute.
  if (match === null || minute > 59) {
    throw new Error(`cycle-cache: not an hourly cron expression: ${expression}`);
  }
  return minute;
};

/** Seconds past the hour at which one cycle's data is settled and the next cycle begins. */
const CYCLE_OFFSET_SECONDS =
  scheduleMinute(INGESTION_SCHEDULE_EXPRESSION) * 60 + CYCLE_SETTLE_SECONDS;

export interface DataCycle {
  readonly startEpochSeconds: number;
  /** Always in `1..3600`: a body served at the boundary itself lives the whole cycle. */
  readonly secondsToNext: number;
  /** Weak, because the fleet forecast's window opens at the clock (`get-fleet-forecast.ts`). */
  readonly etag: string;
}

export const dataCycleAt = (nowEpochSeconds: number): DataCycle => {
  const sinceFirst = nowEpochSeconds - CYCLE_OFFSET_SECONDS;
  const startEpochSeconds =
    sinceFirst -
    (((sinceFirst % SECONDS_PER_HOUR) + SECONDS_PER_HOUR) % SECONDS_PER_HOUR) +
    CYCLE_OFFSET_SECONDS;
  return {
    startEpochSeconds,
    secondsToNext: startEpochSeconds + SECONDS_PER_HOUR - nowEpochSeconds,
    etag: `W/"cycle-${String(startEpochSeconds)}"`,
  };
};

/** The opaque part of an entity tag, so `W/"x"` and `"x"` compare equal (RFC 9110 §8.8.3.2). */
const opaqueTag = (tag: string): string => tag.trim().replace(/^W\//, '');

/**
 * Whether an `If-None-Match` names this cycle's tag. `*` is not honoured: it
 * would answer 304 for a URL whose resource may not exist.
 */
export const revalidatesCycle = (ifNoneMatch: string | undefined, cycle: DataCycle): boolean =>
  (ifNoneMatch ?? '').split(',').some((tag) => opaqueTag(tag) === opaqueTag(cycle.etag));

const cycleHeaders = (cycle: DataCycle): Record<string, string> => ({
  'cache-control': `public, max-age=${String(cycle.secondsToNext)}`,
  etag: cycle.etag,
});

/** RFC 9110 §15.4.5: a 304 carries the validators and freshness a 200 would have. */
export const notModifiedResponse = (cycle: DataCycle): ApiResponse => ({
  statusCode: 304,
  headers: cycleHeaders(cycle),
});

/**
 * A 200 made cacheable until the next cycle. A non-200, or a response that
 * already set its own `cache-control` ({@link uncacheable}), passes unchanged.
 */
export const cachedForCycle = (response: ApiResponse, cycle: DataCycle): ApiResponse =>
  response.statusCode !== 200 || 'cache-control' in response.headers
    ? response
    : { ...response, headers: { ...response.headers, ...cycleHeaders(cycle) } };

/**
 * An answer that must not be kept: an empty series is what a site whose first
 * forecast is still pending reads, and caching it would hide that forecast for
 * up to a cycle.
 */
export const uncacheable = (response: ApiResponse): ApiResponse => ({
  ...response,
  headers: { ...response.headers, 'cache-control': 'no-store' },
});
