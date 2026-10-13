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
 * forecast passes it enqueues.
 */
export const CYCLE_SETTLE_SECONDS = 480;

/** The max-age of a body older than its cycle (#583). */
export const STALE_RETRY_SECONDS = 300;

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

const SCHEDULE_OFFSET_SECONDS = scheduleMinute(INGESTION_SCHEDULE_EXPRESSION) * 60;

/** Seconds past the hour at which one cycle's data is settled and the next cycle begins. */
const CYCLE_OFFSET_SECONDS = SCHEDULE_OFFSET_SECONDS + CYCLE_SETTLE_SECONDS;

/** The latest instant at or before `epochSeconds` that lies `offsetSeconds` past an hour. */
const hourlyAtOrBefore = (epochSeconds: number, offsetSeconds: number): number => {
  const since = epochSeconds - offsetSeconds;
  return (
    since - (((since % SECONDS_PER_HOUR) + SECONDS_PER_HOUR) % SECONDS_PER_HOUR) + offsetSeconds
  );
};

const cycleEtag = (startEpochSeconds: number): string => `W/"cycle-${String(startEpochSeconds)}"`;

export interface DataCycle {
  readonly startEpochSeconds: number;
  /** Always in `1..3600`: a body served at the boundary itself lives the whole cycle. */
  readonly secondsToNext: number;
  /** Weak, because the fleet forecast's window opens at the clock (`get-fleet-forecast.ts`). */
  readonly etag: string;
}

/** The cycle the clock says should be served. */
export const dataCycleAt = (nowEpochSeconds: number): DataCycle => {
  const startEpochSeconds = hourlyAtOrBefore(nowEpochSeconds, CYCLE_OFFSET_SECONDS);
  return {
    startEpochSeconds,
    secondsToNext: startEpochSeconds + SECONDS_PER_HOUR - nowEpochSeconds,
    etag: cycleEtag(startEpochSeconds),
  };
};

/**
 * The start of the cycle a forecast settles into: that of the run fired at or
 * before its `issuedAt`, which is the forecast consumer's clock rather than the
 * schedule's (`apps/forecast/src/consume-message.ts`), so a late pass still
 * dates to its own run.
 */
export const cycleOfIssue = (issuedAt: string): number =>
  hourlyAtOrBefore(Date.parse(issuedAt) / 1000, SCHEDULE_OFFSET_SECONDS) + CYCLE_SETTLE_SECONDS;

/**
 * The start of the cycle a simulated reading settles into, by the earliest run
 * that can write its hour (`planSimulatedActuals` in
 * `apps/forecast/src/simulate-actuals.ts`).
 */
export const cycleOfReading = (validTime: string): number =>
  hourlyAtOrBefore(
    Date.parse(validTime) / 1000 + SCHEDULE_OFFSET_SECONDS,
    SCHEDULE_OFFSET_SECONDS,
  ) + CYCLE_SETTLE_SECONDS;

/**
 * A metered read's answer, and the cycle `datedByData` dates it to — absent
 * when the read has nothing to date it by. Stripped before the response leaves.
 */
export interface MeteredResponse extends ApiResponse {
  readonly dataCycleStart?: number;
}

/** One group's data in a body: its forecasts' vintages and its readings' hours. */
export interface DatedGroup {
  readonly issuedAts: readonly string[];
  readonly readingTimes: readonly string[];
}

/**
 * `response` dated by its laggard: each group dates to its newest cycle and the
 * body to the oldest of those, so one location's late pass is not hidden by
 * another's on-time one.
 */
export const datedByData = (
  response: ApiResponse,
  groups: readonly DatedGroup[],
): MeteredResponse => {
  const newestPerGroup = groups.flatMap(({ issuedAts, readingTimes }) => {
    const cycles = [...issuedAts.map(cycleOfIssue), ...readingTimes.map(cycleOfReading)];
    return cycles.length === 0 ? [] : [cycles.reduce((a, b) => Math.max(a, b))];
  });
  return newestPerGroup.length === 0
    ? response
    : { ...response, dataCycleStart: newestPerGroup.reduce((a, b) => Math.min(a, b)) };
};

/** The opaque part of an entity tag, so `W/"x"` and `"x"` compare equal (RFC 9110 §8.8.3.2). */
const opaqueTag = (tag: string): string => tag.trim().replace(/^W\//, '');

/**
 * Whether an `If-None-Match` names this cycle's tag. `*` is not honoured: it
 * would answer 304 for a URL whose resource may not exist.
 */
export const revalidatesCycle = (ifNoneMatch: string | undefined, cycle: DataCycle): boolean =>
  (ifNoneMatch ?? '').split(',').some((tag) => opaqueTag(tag) === opaqueTag(cycle.etag));

/** `vary: origin` because the gateway's CORS headers depend on the request's `Origin`. */
const cycleHeaders = (cycle: DataCycle): Record<string, string> => ({
  'cache-control': `public, max-age=${String(cycle.secondsToNext)}`,
  etag: cycle.etag,
  vary: 'origin',
});

/** RFC 9110 §15.4.5: a 304 carries the validators and freshness a 200 would have. */
export const notModifiedResponse = (cycle: DataCycle): ApiResponse => ({
  statusCode: 304,
  headers: cycleHeaders(cycle),
});

/**
 * A 200 made cacheable: to the next boundary when its data is the cycle's, or
 * for {@link STALE_RETRY_SECONDS} under its data's own tag when older, so a
 * revalidation misses the 304 and reads again. A non-200, or a response that
 * already set its own `cache-control` ({@link uncacheable}), passes unchanged.
 */
export const cachedForCycle = (read: MeteredResponse, cycle: DataCycle): ApiResponse => {
  const { dataCycleStart, ...response } = read;
  if (response.statusCode !== 200 || 'cache-control' in response.headers) {
    return response;
  }
  const headers =
    dataCycleStart !== undefined && dataCycleStart < cycle.startEpochSeconds
      ? {
          'cache-control': `public, max-age=${String(STALE_RETRY_SECONDS)}`,
          etag: cycleEtag(dataCycleStart),
          vary: 'origin',
        }
      : cycleHeaders(cycle);
  return { ...response, headers: { ...response.headers, ...headers } };
};

/**
 * An answer that must not be kept: an empty series is what a site whose first
 * forecast is still pending reads, and caching it would hide that forecast for
 * up to a cycle.
 */
export const uncacheable = (response: MeteredResponse): MeteredResponse => ({
  ...response,
  headers: { ...response.headers, 'cache-control': 'no-store' },
});
