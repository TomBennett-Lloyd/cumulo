import {
  compareUtcIsoTimestamps,
  FLEET_ROLLUP_FORECAST_KIND,
  fleetRollupMembers,
  locationId,
  sumFleetRollupPartials,
  type FleetForecastAggregatePoint,
  type FleetRollupMembers,
  type FleetSite,
  type UtcIsoTimestamp,
} from '@cumulo/shared';
import type { FleetRollupRow, QueryPaginationBound, SeriesAdapter } from '@cumulo/storage';

import type { RequestDeadline } from '../http/request-deadline';
import { errorResponse, type ApiResponse } from '../http/response';
import { hasBudgetForStorageCommands } from '../request-budget';

/**
 * `GET /v1/fleet/forecast`'s read: one Query of the pre-summed `#FLEET` partition (ADR 0009, #494).
 *
 * **What this replaces.** The route used to read every site's partition — eight batched round trips
 * for a 61-site fleet, 1,753.9 ms p50 and 2,998.9 ms p95 warm — and hand the browser every row to
 * add up. The forecast producer now writes each location's contribution as it produces it, so the
 * same answer is one Query of about twelve small items per hour, summed in process by the same
 * `@cumulo/shared` functions the browser used to call.
 *
 * **A short partition is served short, and says so.** A location that has not written, or whose
 * slices cannot be summed as they stand, is left out of the sum and not refused: the contract has
 * the label (`contributingSiteCount` on every point), so a refusal is not the honest answer
 * (`docs/standards/error-handling.md` rule 5), and one {@link fleetRollupShortEvent} line says why.
 * The check is per **location**, not per hour (ADR 0009, 2026-10-05, #531), and only a Query cut
 * short by the deadline is refused, because a window missing its tail is labelled by no count.
 * ADR 0009's 2026-10-21 (#507) entry decides all of it.
 */

/**
 * The one event a short response emits: it was served short of what it names.
 *
 * One event with a `reason` rather than one event per reason, so an operator counts a single line.
 */
export const fleetRollupShortEvent = 'api.fleet-forecast.rollup-short';

/**
 * Why a response was short. `absent`: nothing written at all. `incomplete`: some locations not
 * written. `stale`: every location wrote, but some location's slices fail the provenance rule.
 */
export type RollupShortReason = 'absent' | 'incomplete' | 'stale';

export interface FleetRollupReadDeps {
  /** Reads only (`typing.md` rule 6, ADR 0002 least privilege). */
  readonly series: Pick<SeriesAdapter, 'queryFleetRollup'>;
  /** Structured-logging sink (`docs/standards/error-handling.md` rule 4). */
  readonly log: (entry: Record<string, unknown>) => void;
}

/**
 * The fleet's summed forecast, or the response that says why it is not coming.
 *
 * `issuedAtsByGroup` is what dates the response (#614): the runs behind the sum, one group per
 * location summed.
 */
export type FleetForecastAggregateRead =
  | {
      readonly complete: true;
      readonly points: readonly FleetForecastAggregatePoint[];
      readonly issuedAtsByGroup: readonly (readonly UtcIsoTimestamp[])[];
    }
  | { readonly complete: false; readonly response: ApiResponse };

/**
 * The fleet's sites grouped by the location they are expected to have written a partial for, in the
 * order each location first appears.
 *
 * Keyed by bucket because two sites in one bucket are one expected partial: `locationId` is what
 * the producer's messages are keyed by (ADR 0004).
 */
export const expectedSites = (
  sites: readonly FleetSite[],
): ReadonlyMap<string, readonly FleetSite[]> => {
  const sitesByLocation = new Map<string, FleetSite[]>();
  for (const site of sites) {
    const location = locationId(site);
    sitesByLocation.set(location, [...(sitesByLocation.get(location) ?? []), site]);
  }
  return sitesByLocation;
};

/**
 * The digest of the sites a run issued at `issuedAt` could have summed: those that existed then.
 *
 * A site added since has no forecast in the slice (#286), so the slice is exactly right for every
 * site that has one and an add alone is not stale. The producer lists its sites before it reads its
 * clock, so a site it summed was created at or before `issuedAt`; skew between the two hosts can
 * only make a slice read stale, never fresh.
 */
export const membersAsOf = (
  sites: readonly FleetSite[],
  issuedAt: UtcIsoTimestamp,
): FleetRollupMembers =>
  fleetRollupMembers(
    sites.filter((site) => compareUtcIsoTimestamps(site.createdAt, issuedAt) <= 0),
  );

/**
 * The expected locations whose slices cannot be summed as they stand: a membership digest that is
 * not the one the sites then existing give, or a location whose slices carry more than one
 * `issuedAt` — part of its horizon was written by another run.
 *
 * Vintage is compared within a location and never across them: ingestion visits locations on
 * their own schedule and with no end-of-run event (ADR 0009), so locations legitimately differ.
 */
const staleLocations = (
  rows: readonly FleetRollupRow[],
  expected: ReadonlyMap<string, readonly FleetSite[]>,
): ReadonlySet<string> => {
  const stale = new Set<string>();
  const runs = new Map<string, { issuedAt: UtcIsoTimestamp; members: FleetRollupMembers }>();
  for (const row of rows) {
    const sitesHere = expected.get(row.locationId);
    if (sitesHere === undefined) {
      continue;
    }
    const run = runs.get(row.locationId) ?? {
      issuedAt: row.provenance.issuedAt,
      members: membersAsOf(sitesHere, row.provenance.issuedAt),
    };
    runs.set(row.locationId, run);
    if (row.provenance.members !== run.members || row.provenance.issuedAt !== run.issuedAt) {
      stale.add(row.locationId);
    }
  }
  return stale;
};

/**
 * Why a complete read is short of the fleet, or `undefined` when it is not. No `complete` flag:
 * a truncated read is refused before this runs.
 */
export const shortReason = (
  rows: readonly FleetRollupRow[],
  expected: ReadonlyMap<string, readonly FleetSite[]>,
  stale: ReadonlySet<string>,
): RollupShortReason | undefined => {
  if (rows.length === 0) {
    return 'absent';
  }
  const present = new Set(rows.map((row) => row.locationId));
  if (![...expected.keys()].every((location) => present.has(location))) {
    return 'incomplete';
  }
  return stale.size === 0 ? undefined : 'stale';
};

/**
 * The one 500 the fleet reads answer, with the log line that says where it stopped.
 *
 * Two callers: the roll-up Queries' truncation, and the actuals read's slices gate. Deliberately
 * one message each: a caller can do nothing different with them, while an operator reads the
 * difference off the fields in `detail`.
 */
export const readDeadlineReached = (
  log: FleetRollupReadDeps['log'],
  deadlineEvent: string,
  detail: Record<string, unknown>,
): ApiResponse => {
  log({ event: deadlineEvent, ...detail });
  return errorResponse('internal', 'the request could not be completed in time');
};

/**
 * Sum the partials of the locations this fleet has sites at and whose slices are fresh, and no
 * others.
 *
 * The expected-set filter is not defensive tidiness; without it a decommissioned location keeps
 * generating. Its partials are written under keys nothing rewrites once ingestion stops publishing
 * for it, and they outlive the last site there by the whole forecast horizon — a ghost's kilowatts,
 * site count and nameplate capacity. A ghost *site* at a surviving location is
 * {@link staleLocations}' job, which has already left that location out by the time this runs.
 */
const summed = (
  rows: readonly FleetRollupRow[],
  expected: ReadonlyMap<string, readonly FleetSite[]>,
  stale: ReadonlySet<string>,
): readonly FleetForecastAggregatePoint[] =>
  sumFleetRollupPartials(
    rows
      .filter((row) => expected.has(row.locationId) && !stale.has(row.locationId))
      .map((row) => row.partial),
  );

/**
 * Each summed location's run, as a group of its own for dating the response (#614). One value
 * suffices because {@link staleLocations} has already left out a location with two. A location
 * outside the sum has no run behind it, so it has no group.
 */
const issuedAtsByLocation = (
  rows: readonly FleetRollupRow[],
  expected: ReadonlyMap<string, readonly FleetSite[]>,
  stale: ReadonlySet<string>,
): readonly (readonly UtcIsoTimestamp[])[] =>
  [...expected.keys()]
    .filter((location) => !stale.has(location))
    .flatMap((location) => {
      const issuedAt = rows.find((row) => row.locationId === location)?.provenance.issuedAt;
      return issuedAt === undefined ? [] : [[issuedAt]];
    });

/**
 * Read the fleet's summed forecast over `from`…`to`.
 *
 * The Query is page-bounded on the request's deadline, and a walk the deadline cut short is the one
 * 500 here. A `StorageError` travels to the route boundary as it always did — no `catch` here would
 * have anything to add (`docs/standards/error-handling.md` rule 2).
 */
export const readFleetForecastAggregate = async (
  deps: FleetRollupReadDeps,
  deadline: RequestDeadline,
  sites: readonly FleetSite[],
  from: UtcIsoTimestamp,
  to: UtcIsoTimestamp,
  deadlineEvent: string,
): Promise<FleetForecastAggregateRead> => {
  // An empty fleet is answered without touching the table at all. Not an optimisation: the fleet
  // total of nothing is nothing, there is no partition state that could make it otherwise, and
  // the route's "an empty fleet is a 200 with an empty array" promise should not be one billed
  // read away from being a 500.
  if (sites.length === 0) {
    return { complete: true, points: [], issuedAtsByGroup: [] };
  }

  const bound: QueryPaginationBound = {
    hasBudgetForNextPage: () => hasBudgetForStorageCommands(deadline.remainingMs(), 1),
  };

  const rollup = await deps.series.queryFleetRollup(FLEET_ROLLUP_FORECAST_KIND, from, to, bound);
  if (!rollup.complete) {
    return {
      complete: false,
      response: readDeadlineReached(deps.log, deadlineEvent, { rowsRead: rollup.rows.length }),
    };
  }

  const expected = expectedSites(sites);
  const stale = staleLocations(rollup.rows, expected);
  const reason = shortReason(rollup.rows, expected, stale);

  if (reason !== undefined) {
    deps.log({
      event: fleetRollupShortEvent,
      reason,
      expectedLocations: expected.size,
      presentLocations: new Set(rollup.rows.map((row) => row.locationId)).size,
      staleLocations: stale.size,
      hours: new Set(rollup.rows.map((row) => row.partial.validTime)).size,
    });
  }

  return {
    complete: true,
    points: summed(rollup.rows, expected, stale),
    issuedAtsByGroup: issuedAtsByLocation(rollup.rows, expected, stale),
  };
};
