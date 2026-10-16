import {
  FLEET_ROLLUP_ACTUALS_KIND,
  TRAILING_ACTUALS_HOURS,
  compareUtcIsoTimestamps,
  describeThrown,
  sumFleetActualsRollupPartials,
  type FleetActualsAggregatePoint,
  type UtcIsoTimestamp,
  type UtcWindow,
} from '@cumulo/shared';
import {
  SERIES_RETENTION_DAYS,
  type BatchWriteOutcome,
  type FleetRollupRangeResult,
  type SeriesAdapter,
} from '@cumulo/storage';

import { utcHoursBefore } from './simulate-actuals';

/**
 * Compaction of settled fleet-actuals hours into one `GEN` total per hour (ADR 0009's 2026-10-14
 * (#615) entry), written after a location's own slices.
 *
 * The slice window `[issuedAt - TRAILING_ACTUALS_HOURS, issuedAt)` and the compaction window
 * (everything before `issuedAt - TRAILING_ACTUALS_HOURS`) are disjoint within one invocation, so a
 * later invocation does not rewrite what a total sums: an idempotent Put (the exception is ADR
 * 0009's residual 1).
 * Failures become a logged outcome, never a rejection, for `fleet-rollup-write.ts`'s reason.
 */

export const fleetActualsCompactionEvent = 'forecast.fleet-actuals-compaction.outcome';

export type FleetActualsCompactionOutcome =
  | { readonly status: 'written'; readonly hourCount: number }
  | { readonly status: 'nothing-to-compact' }
  | { readonly status: 'store-partial'; readonly unprocessedCount: number }
  | { readonly status: 'failed'; readonly detail: string };

export interface FleetActualsCompactionDeps {
  readonly series: Pick<
    SeriesAdapter,
    'queryLatestFleetActualsTotals' | 'queryFleetRollup' | 'putFleetActualsTotals'
  >;
  readonly log: (entry: Record<string, unknown>) => void;
}

type CompactionOperation =
  | 'queryLatestFleetActualsTotals'
  | 'queryFleetRollup'
  | 'sumFleetActualsRollupPartials'
  | 'putFleetActualsTotals';

const failedOutcome = (
  operation: CompactionOperation,
  error: unknown,
): FleetActualsCompactionOutcome => ({
  status: 'failed',
  detail: `${operation} threw — ${describeThrown(error)}`,
});

/**
 * The slices to sum: from `reach` when no total exists, otherwise from the earlier of the hour
 * after the latest total and the last `TRAILING_ACTUALS_HOURS` settled hours, which are always
 * re-checked so a partial drain inside them is repaired next cycle.
 */
export const compactionWindow = (
  settledEnd: UtcIsoTimestamp,
  reach: UtcIsoTimestamp,
  latestTotal: UtcIsoTimestamp | undefined,
): UtcWindow => {
  if (latestTotal === undefined) {
    return { startInclusive: reach, endExclusive: settledEnd };
  }
  const afterLatest = utcHoursBefore(latestTotal, -1);
  const recheck = utcHoursBefore(settledEnd, TRAILING_ACTUALS_HOURS);
  return {
    startInclusive: compareUtcIsoTimestamps(afterLatest, recheck) < 0 ? afterLatest : recheck,
    endExclusive: settledEnd,
  };
};

/** The points whose hour no `existing` total carries. */
export const missingTotals = (
  points: readonly FleetActualsAggregatePoint[],
  existing: readonly FleetActualsAggregatePoint[],
): FleetActualsAggregatePoint[] => {
  const have = new Set(existing.map((total) => total.validTime));
  return points.filter((point) => !have.has(point.validTime));
};

/**
 * Sum every settled hour that lacks a total and write it. Every slice row is summed with no
 * `locationId` filter: a settled hour is history and keeps every location that wrote it.
 */
export const compactFleetActuals = async (
  deps: FleetActualsCompactionDeps,
  issuedAt: UtcIsoTimestamp,
): Promise<FleetActualsCompactionOutcome> => {
  const settledEnd = utcHoursBefore(issuedAt, TRAILING_ACTUALS_HOURS);
  const reach = utcHoursBefore(settledEnd, SERIES_RETENTION_DAYS * 24);

  let recent: FleetActualsAggregatePoint[];
  try {
    recent = await deps.series.queryLatestFleetActualsTotals(
      reach,
      settledEnd,
      TRAILING_ACTUALS_HOURS,
    );
  } catch (error: unknown) {
    return failedOutcome('queryLatestFleetActualsTotals', error);
  }

  const window = compactionWindow(settledEnd, reach, recent[0]?.validTime);

  let slices: FleetRollupRangeResult;
  try {
    slices = await deps.series.queryFleetRollup(
      FLEET_ROLLUP_ACTUALS_KIND,
      window.startInclusive,
      window.endExclusive,
    );
  } catch (error: unknown) {
    return failedOutcome('queryFleetRollup', error);
  }

  let points: readonly FleetActualsAggregatePoint[];
  try {
    points = sumFleetActualsRollupPartials(slices.rows.map((row) => row.partial));
  } catch (error: unknown) {
    return failedOutcome('sumFleetActualsRollupPartials', error);
  }

  const missing = missingTotals(points, recent);
  if (missing.length === 0) {
    return { status: 'nothing-to-compact' };
  }

  let stored: BatchWriteOutcome;
  try {
    stored = await deps.series.putFleetActualsTotals(missing);
  } catch (error: unknown) {
    return failedOutcome('putFleetActualsTotals', error);
  }

  return stored.status === 'partial'
    ? { status: 'store-partial', unprocessedCount: stored.unprocessedCount }
    : { status: 'written', hourCount: missing.length };
};

/** The compaction as `consume-message.ts` calls it: run it, say what happened, return nothing. */
export const reportFleetActualsCompaction = async (
  deps: FleetActualsCompactionDeps,
  issuedAt: UtcIsoTimestamp,
): Promise<void> => {
  deps.log({ event: fleetActualsCompactionEvent, ...(await compactFleetActuals(deps, issuedAt)) });
};
