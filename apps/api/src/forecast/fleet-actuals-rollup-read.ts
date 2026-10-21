import {
  compareUtcIsoTimestamps,
  FLEET_ROLLUP_ACTUALS_KIND,
  sumFleetActualsRollupPartials,
  TRAILING_ACTUALS_HOURS,
  type FleetActualsAggregatePoint,
  type FleetSite,
  type UtcIsoTimestamp,
} from '@cumulo/shared';
import type { FleetRollupRow, QueryPaginationBound, SeriesAdapter } from '@cumulo/storage';

import type { RequestDeadline } from '../http/request-deadline';
import type { ApiResponse } from '../http/response';
import { hasBudgetForStorageCommands } from '../request-budget';

import {
  expectedSites,
  membersAsOf,
  readDeadlineReached,
  shortReason,
  type FleetRollupReadDeps,
} from './fleet-rollup-read';
import { hoursAfter, hoursBefore } from './series-window';

/**
 * `GET /v1/fleet/actuals`'s read: the `#FLEET` partition's `GEN` totals over the window, then the
 * slices from the hour after the last total — `fleet-rollup-read.ts`'s shape, with the completeness
 * rule ADR 0009's #506 amendment states for actuals and its #615 entry extends.
 *
 * A look-back is written by many cycles, so there is no vintage check, and membership is checked
 * only on the hours the producer still rewrites, as of the slice's own `issuedAt`; older hours are
 * summed as written. A location that has not written, or whose rewritten hours fail that check, is
 * left out and named in {@link fleetActualsRollupShortEvent}; ADR 0009's 2026-10-21 (#507) entry
 * decides it, and only a Query the deadline cut short is refused.
 */

export interface FleetActualsRollupReadDeps extends FleetRollupReadDeps {
  readonly series: Pick<SeriesAdapter, 'queryFleetRollup' | 'queryFleetActualsTotals'>;
}

/** The one event a short response emits — this route's own, for `fleetRollupShortEvent`'s reason. */
export const fleetActualsRollupShortEvent = 'api.fleet-actuals.rollup-short';

/**
 * The summed actuals, and the hours behind them grouped by what wrote them — one group per
 * location's slices — which is what dates the response (#608).
 */
export type FleetActualsAggregateRead =
  | {
      readonly complete: true;
      readonly points: readonly FleetActualsAggregatePoint[];
      readonly readingTimesByGroup: readonly (readonly UtcIsoTimestamp[])[];
    }
  | { readonly complete: false; readonly response: ApiResponse };

/** Locations with a slice in the rewritten hours whose digest is not that of the sites then existing. */
const staleLocations = (
  rows: readonly FleetRollupRow[],
  expected: ReadonlyMap<string, readonly FleetSite[]>,
  rewrittenFrom: UtcIsoTimestamp,
): ReadonlySet<string> =>
  new Set(
    rows
      .filter((row) => {
        const sitesHere = expected.get(row.locationId);
        return (
          sitesHere !== undefined &&
          compareUtcIsoTimestamps(row.partial.validTime, rewrittenFrom) >= 0 &&
          row.provenance.members !== membersAsOf(sitesHere, row.provenance.issuedAt)
        );
      })
      .map((row) => row.locationId),
  );

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

/** Read the fleet's summed actuals over `from`…`to`, short of any location that cannot be summed. */
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
  if (!totals.complete || !slices.complete) {
    return {
      complete: false,
      response: readDeadlineReached(deps.log, deadlineEvent, {
        totalsRead: totals.rows.length,
        slicesRead: slices.rows.length,
      }),
    };
  }

  const expected = expectedSites(sites);
  const stale = staleLocations(slices.rows, expected, hoursBefore(to, TRAILING_ACTUALS_HOURS));
  // A window the totals cover to its end has nothing to be short of.
  const reason = start === undefined ? undefined : shortReason(slices.rows, expected, stale);

  if (reason !== undefined) {
    deps.log({
      event: fleetActualsRollupShortEvent,
      reason,
      expectedLocations: expected.size,
      presentLocations: new Set(slices.rows.map((row) => row.locationId)).size,
      staleLocations: stale.size,
      hours: new Set([
        ...totals.rows.map((point) => point.validTime),
        ...slices.rows.map((row) => row.partial.validTime),
      ]).size,
    });
  }

  const rows = slices.rows.filter(
    (row) => expected.has(row.locationId) && !stale.has(row.locationId),
  );
  return {
    complete: true,
    // Totals are never filtered by location: a settled hour is summed as written. They do not
    // date the response either, being older than every slice by construction.
    points: [...totals.rows, ...sumFleetActualsRollupPartials(rows.map((row) => row.partial))].sort(
      (a, b) => compareUtcIsoTimestamps(a.validTime, b.validTime),
    ),
    readingTimesByGroup: [...expected.keys()].flatMap((location) => {
      const times = rows
        .filter((row) => row.locationId === location)
        .map((row) => row.partial.validTime);
      return times.length === 0 ? [] : [times];
    }),
  };
};
