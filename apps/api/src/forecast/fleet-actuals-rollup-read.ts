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
import type { FleetRollupRow, QueryPaginationBound } from '@cumulo/storage';

import type { RequestDeadline } from '../http/request-deadline';
import type { ApiResponse } from '../http/response';
import { hasBudgetForStorageCommands } from '../request-budget';

import { readFleetSeries } from './fleet-series-read';
import {
  expectedLocations,
  fallbackReason,
  type FallbackReason,
  type FleetRollupReadDeps,
} from './fleet-rollup-read';
import { actualsIn } from './series-split';
import { hoursAfter, hoursBefore } from './series-window';

/**
 * `GET /v1/fleet/actuals`'s read: one Query of the `#FLEET` partition's `GEN` slices, falling back
 * to the per-site fan-out — `fleet-rollup-read.ts`'s shape, with the completeness rule ADR 0009's
 * #506 amendment states for actuals.
 *
 * A look-back is written by many cycles, so there is no vintage check, and membership is checked
 * only on the hours the producer still rewrites; older hours are summed as written. One check the
 * forecast read does not need: a location older than the window must hold its first hour, or a
 * history the producer has not yet written reads as a whole one.
 */

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

/**
 * Read the fleet's summed actuals over `from`…`to`: the roll-up if it can answer, the fan-out if
 * not.
 */
export const readFleetActualsAggregate = async (
  deps: FleetRollupReadDeps,
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
  const rollup = await deps.series.queryFleetRollup(FLEET_ROLLUP_ACTUALS_KIND, from, to, bound);
  const expected = expectedLocations(sites);
  const stale = staleLocations(rollup.rows, expected, hoursBefore(to, TRAILING_ACTUALS_HOURS));
  const uncovered = uncoveredLocations(rollup.rows, sites, from);
  const base = fallbackReason(rollup, expected, stale);
  const reason: FallbackReason | undefined =
    base === undefined && uncovered.size > 0 ? 'incomplete' : base;

  if (reason === undefined) {
    const rows = rollup.rows.filter((row) => expected.has(row.locationId));
    return {
      complete: true,
      points: sumFleetActualsRollupPartials(rows.map((row) => row.partial)),
      readingTimesByGroup: [...expected.keys()].map((location) =>
        rows.filter((row) => row.locationId === location).map((row) => row.partial.validTime),
      ),
    };
  }

  deps.log({
    event: fleetActualsRollupFallbackEvent,
    reason,
    expectedLocations: expected.size,
    presentLocations: new Set(rollup.rows.map((row) => row.locationId)).size,
    staleLocations: stale.size,
    uncoveredLocations: uncovered.size,
    hours: new Set(rollup.rows.map((row) => row.partial.validTime)).size,
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
