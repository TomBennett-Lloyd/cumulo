import {
  compareUtcIsoTimestamps,
  FLEET_ROLLUP_ACTUALS_KIND,
  fleetActualsAggregate,
  locationId,
  sumFleetActualsRollupPartials,
  TRAILING_ACTUALS_HOURS,
  type FleetActualsAggregatePoint,
  type FleetRollupMembers,
  type FleetSite,
  type UtcIsoTimestamp,
} from '@cumulo/shared';
import type { FleetRollupRow, QueryPaginationBound, SeriesAdapter } from '@cumulo/storage';

import type { RequestDeadline } from '../http/request-deadline';
import type { ApiResponse } from '../http/response';
import { hasBudgetForStorageCommands } from '../request-budget';

import { readDeadlineReached, readFleetSeries } from './fleet-series-read';
import {
  expectedLocations,
  fallbackReason,
  type FallbackReason,
  type FleetRollupReadDeps,
} from './fleet-rollup-read';
import { actualsIn } from './series-split';
import { hoursAfter, hoursBefore } from './series-window';

/**
 * `GET /v1/fleet/actuals`'s read: the `#FLEET` partition's `GEN` totals over the window, then the
 * slices from the hour after the last total, falling back to the per-site fan-out —
 * `fleet-rollup-read.ts`'s shape, with the completeness rule ADR 0009's #506 amendment states for
 * actuals and its #615 entry extends.
 *
 * A look-back is written by many cycles, so there is no vintage check, and membership is checked
 * only on the hours the producer still rewrites; older hours are summed as written, and a settled
 * hour's total satisfies the first-hour check a location older than the window must meet, or a
 * history the producer has not yet written reads as a whole one.
 */

export interface FleetActualsRollupReadDeps extends FleetRollupReadDeps {
  readonly series: Pick<
    SeriesAdapter,
    'querySeriesRange' | 'queryFleetRollup' | 'queryFleetActualsTotals'
  >;
}

/** The one event a fallback emits — this route's own, for `fleetRollupFallbackEvent`'s reason. */
export const fleetActualsRollupFallbackEvent = 'api.fleet-actuals.rollup-fallback';

/**
 * The summed actuals, and the hours behind them grouped by what wrote them — one group per
 * location's slices, or per site on the fallback — which is what dates the response (#608).
 */
export type FleetActualsAggregateRead =
  | {
      readonly complete: true;
      readonly points: readonly FleetActualsAggregatePoint[];
      readonly readingTimesByGroup: readonly (readonly UtcIsoTimestamp[])[];
    }
  | { readonly complete: false; readonly response: ApiResponse };

/** Locations with a slice in the rewritten hours whose digest is not the live one. */
const staleLocations = (
  rows: readonly FleetRollupRow[],
  expected: ReadonlyMap<string, FleetRollupMembers>,
  rewrittenFrom: UtcIsoTimestamp,
): ReadonlySet<string> =>
  new Set(
    rows
      .filter((row) => {
        const members = expected.get(row.locationId);
        return (
          members !== undefined &&
          compareUtcIsoTimestamps(row.partial.validTime, rewrittenFrom) >= 0 &&
          row.provenance?.members !== members
        );
      })
      .map((row) => row.locationId),
  );

/**
 * Locations whose oldest site predates the window by the trailing hours yet hold no slice for
 * its first hour. Such a site has a reading there unless the pipeline was idle, and either way the
 * fan-out is the answer that knows.
 */
const uncoveredLocations = (
  rows: readonly FleetRollupRow[],
  sites: readonly FleetSite[],
  from: UtcIsoTimestamp,
): ReadonlySet<string> => {
  const firstHourEnd = hoursAfter(from, 1);
  const covered = new Set(
    rows
      .filter((row) => compareUtcIsoTimestamps(row.partial.validTime, firstHourEnd) < 0)
      .map((row) => row.locationId),
  );
  const settledBefore = hoursBefore(from, TRAILING_ACTUALS_HOURS);
  return new Set(
    sites
      .filter((site) => compareUtcIsoTimestamps(site.createdAt, settledBefore) <= 0)
      .map((site) => locationId(site))
      .filter((location) => !covered.has(location)),
  );
};

/** Where the slices Query opens: the hour after the last total, or `undefined` if none is left to read. */
const tailStart = (
  totals: readonly FleetActualsAggregatePoint[],
  from: UtcIsoTimestamp,
  to: UtcIsoTimestamp,
): UtcIsoTimestamp | undefined => {
  const last = totals.at(-1);
  if (last === undefined) {
    return from;
  }
  const start = hoursAfter(last.validTime, 1);
  return compareUtcIsoTimestamps(start, to) < 0 ? start : undefined;
};

/** Whether a total already covers the window's first hour, by `uncoveredLocations`'s arithmetic. */
const firstHourCovered = (
  totals: readonly FleetActualsAggregatePoint[],
  from: UtcIsoTimestamp,
): boolean =>
  totals.some((point) => compareUtcIsoTimestamps(point.validTime, hoursAfter(from, 1)) < 0);

/**
 * Read the fleet's summed actuals over `from`…`to`: the roll-up if it can answer, the fan-out if
 * not.
 */
export const readFleetActualsAggregate = async (
  deps: FleetActualsRollupReadDeps,
  deadline: RequestDeadline,
  sites: readonly FleetSite[],
  from: UtcIsoTimestamp,
  to: UtcIsoTimestamp,
  deadlineEvent: string,
): Promise<FleetActualsAggregateRead> => {
  if (sites.length === 0) {
    return { complete: true, points: [], readingTimesByGroup: [] };
  }

  const bound: QueryPaginationBound = {
    hasBudgetForNextPage: () => hasBudgetForStorageCommands(deadline.remainingMs(), 1),
  };
  const totals = await deps.series.queryFleetActualsTotals(from, to, bound);
  const start = tailStart(totals.rows, from, to);
  // The slices Query is admitted through the gate: the totals Query's first page is the route's
  // ungated one, so the prefix stays where `apps/api/src/request-budget.ts` counts it.
  if (start !== undefined && !hasBudgetForStorageCommands(deadline.remainingMs(), 1)) {
    return {
      complete: false,
      response: readDeadlineReached(deps.log, deadlineEvent, { totalsRead: totals.rows.length }),
    };
  }
  const slices =
    start === undefined
      ? { rows: [], complete: true }
      : await deps.series.queryFleetRollup(FLEET_ROLLUP_ACTUALS_KIND, start, to, bound);
  const expected = expectedLocations(sites);
  const stale = staleLocations(slices.rows, expected, hoursBefore(to, TRAILING_ACTUALS_HOURS));
  const uncovered = firstHourCovered(totals.rows, from)
    ? new Set<string>()
    : uncoveredLocations(slices.rows, sites, from);
  const base = fallbackReason(
    { rows: slices.rows, complete: totals.complete && slices.complete },
    expected,
    stale,
  );
  // An uncovered first hour is part of the window unwritten, so it ranks as `incomplete` does.
  const reason: FallbackReason | undefined =
    base !== 'absent' && uncovered.size > 0 ? 'incomplete' : base;

  if (reason === undefined) {
    const rows = slices.rows.filter((row) => expected.has(row.locationId));
    return {
      complete: true,
      // Totals are never filtered by location: a settled hour is summed as written. They do not
      // date the response either, being older than every slice by construction.
      points: [
        ...totals.rows,
        ...sumFleetActualsRollupPartials(rows.map((row) => row.partial)),
      ].sort((a, b) => compareUtcIsoTimestamps(a.validTime, b.validTime)),
      readingTimesByGroup: [...expected.keys()].map((location) =>
        rows.filter((row) => row.locationId === location).map((row) => row.partial.validTime),
      ),
    };
  }

  deps.log({
    event: fleetActualsRollupFallbackEvent,
    reason,
    expectedLocations: expected.size,
    presentLocations: new Set(slices.rows.map((row) => row.locationId)).size,
    staleLocations: stale.size,
    uncoveredLocations: uncovered.size,
    hours: new Set([
      ...totals.rows.map((point) => point.validTime),
      ...slices.rows.map((row) => row.partial.validTime),
    ]).size,
  });

  const read = await readFleetSeries(deps, deadline, sites, from, to, deadlineEvent);
  if (!read.complete) {
    return read;
  }
  const perSite = read.perSite.map((points) => actualsIn(points));
  return {
    complete: true,
    points: fleetActualsAggregate(perSite.flat(), sites),
    readingTimesByGroup: perSite.map((readings) => readings.map((reading) => reading.validTime)),
  };
};
