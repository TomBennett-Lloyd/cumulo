import {
  activeFleetSites,
  FLEET_ROLLUP_FORECAST_KIND,
  fleetForecastAggregate,
  fleetRollupMembers,
  locationId,
  sumFleetRollupPartials,
  type FleetForecastAggregatePoint,
  type FleetRollupMembers,
  type FleetSite,
  type UtcIsoTimestamp,
} from '@cumulo/shared';
import type {
  FleetRollupRangeResult,
  FleetRollupRow,
  QueryPaginationBound,
  SeriesAdapter,
} from '@cumulo/storage';

import type { RequestDeadline } from '../http/request-deadline';
import type { ApiResponse } from '../http/response';
import { hasBudgetForStorageCommands } from '../request-budget';

import { readFleetSeries, type FleetSeriesReadDeps } from './fleet-series-read';
import { forecastsIn } from './series-split';

/**
 * `GET /v1/fleet/forecast`'s read: one Query of the pre-summed `#FLEET` partition, with the old
 * fan-out kept for one release as the fallback (ADR 0009, #494).
 *
 * **What this replaces.** The route used to read every site's partition — eight batched round trips
 * for a 61-site fleet, 1,753.9 ms p50 and 2,998.9 ms p95 warm — and hand the browser every row to
 * add up. The forecast producer now writes each location's contribution as it produces it, so the
 * same answer is one Query of about twelve small items per hour, summed in process by the same
 * `@cumulo/shared` functions the browser used to call.
 *
 * **The fallback is a second path, not a second owner of the numbers.** Both arms end in
 * `@cumulo/shared` — `sumFleetRollupPartials` over stored partials, `fleetForecastAggregate` over
 * raw rows — and `fleet-rollup-additivity.test.ts` is the proof those two agree. What the fallback
 * exists for is the window between deploying this and the first full ingestion cycle writing every
 * location.
 *
 * **Incomplete counts as absent, deliberately.** A partition holding eleven of twelve locations
 * sums to a fleet total that looks exactly like a plausible number from a quieter fleet — there is
 * no gap to see, because the missing site does not read as missing, it reads as less generation.
 * That is the half-truth `fleet-series-read.ts` refuses for the fan-out, applied to the roll-up.
 * Completeness is checked per **location**, and mechanically: the route already lists the fleet and
 * every site carries coordinates, so the expected set is the active sites' `locationId`s — the same
 * `locationId` ingestion keys its messages on, over the same `activeFleetSites` predicate
 * `activeFetchLocations` takes, so neither set can drift from the other on activity. A cycle that
 * deferred a location for budget is a different dimension and is what `incomplete` is for. The
 * check is **not** per hour, which is a decision rather than an omission: ADR 0009's
 * `## Amendments` entry for 2026-10-05 (#531) states it and what makes the residual honest rather
 * than silent. A location that has written is also checked for **membership and vintage** (#602,
 * the 2026-10-07 entry): its slices must carry the digest of the sites active there now, and one
 * `issuedAt` between them.
 *
 * **One release, then gone.** Every fallback logs {@link fleetRollupFallbackEvent} with the counts
 * that explain it, so "has a full cycle written every location yet?" is one log query. When the
 * event has been absent for 24 hours after the first post-deploy cycle, the fallback and this
 * module's second arm come out — #507, which states the condition in the form a log query can answer.
 */

/**
 * The one event a fallback emits.
 *
 * One event with a `reason` rather than two events, because an operator watching a deployment wants
 * a single line to count: the question is "is the roll-up being used yet", and `absent` versus
 * `incomplete` is the detail that says how far through the first cycle the answer is.
 */
export const fleetRollupFallbackEvent = 'api.fleet-forecast.rollup-fallback';

/**
 * Why the roll-up could not answer. `absent`: nothing written at all. `incomplete`: some of it.
 * `stale`: every location wrote, but at least one location's slices were summed from a different
 * site set than the one active there now, or from more than one forecast run.
 */
type FallbackReason = 'absent' | 'incomplete' | 'stale';

export interface FleetRollupReadDeps extends FleetSeriesReadDeps {
  /**
   * Reads only, and now two methods: the roll-up partition, plus the per-site fan-out the fallback
   * still needs (`typing.md` rule 6, ADR 0002 least privilege). The second disappears with the
   * fallback.
   */
  readonly series: Pick<SeriesAdapter, 'querySeriesRange' | 'queryFleetRollup'>;
}

/**
 * The fleet's summed forecast, or the response that says why it is not coming.
 *
 * {@link FleetSeriesRead}'s shape and its reasoning.
 */
export type FleetForecastAggregateRead =
  | { readonly complete: true; readonly points: readonly FleetForecastAggregatePoint[] }
  | { readonly complete: false; readonly response: ApiResponse };

/**
 * Which locations the fleet expects a partial from — one per distinct weather bucket its sites sit
 * in — each with the membership digest its slices must carry.
 *
 * Keyed by bucket because two sites in one bucket are one expected partial: `locationId` is what
 * the producer's messages are keyed by (ADR 0004). The digest is over the same sites the producer
 * lists for that bucket, so a slice summed before a delete, an add or a physics edit there misses.
 *
 * The sites are already the active ones — {@link readFleetForecastAggregate} narrows once, for both
 * arms — which is the half that makes this set the set the producer writes rather than merely a
 * similar one: ingestion publishes only for locations holding an active site, so a location whose
 * every site has been deactivated can never be written again, and counting it here would pin the
 * route on `incomplete` for ever while logging a line that means the opposite of what it says.
 */
const expectedLocations = (
  sites: readonly FleetSite[],
): ReadonlyMap<string, FleetRollupMembers> => {
  const sitesByLocation = new Map<string, FleetSite[]>();
  for (const site of sites) {
    const location = locationId(site);
    sitesByLocation.set(location, [...(sitesByLocation.get(location) ?? []), site]);
  }
  return new Map(
    [...sitesByLocation].map(([location, members]) => [location, fleetRollupMembers(members)]),
  );
};

/**
 * The expected locations whose slices cannot be summed as they stand: a slice with no provenance
 * (written before #602), a membership digest that is not the live one, or a location whose slices
 * carry more than one `issuedAt` — a `store-partial` drain or a replay left part of its horizon on
 * an older run, which the per-site rows do not share.
 *
 * Vintage is compared within a location and never across them: ingestion visits locations on
 * their own schedule and with no end-of-run event (ADR 0009), so locations legitimately differ.
 */
const staleLocations = (
  rows: readonly FleetRollupRow[],
  expected: ReadonlyMap<string, FleetRollupMembers>,
): ReadonlySet<string> => {
  const stale = new Set<string>();
  const vintages = new Map<string, UtcIsoTimestamp>();
  for (const row of rows) {
    const members = expected.get(row.locationId);
    if (members === undefined) {
      continue;
    }
    const vintage = vintages.get(row.locationId) ?? row.provenance?.issuedAt;
    if (row.provenance?.members !== members || row.provenance.issuedAt !== vintage) {
      stale.add(row.locationId);
    }
    if (vintage !== undefined) {
      vintages.set(row.locationId, vintage);
    }
  }
  return stale;
};

/**
 * Whether a roll-up read can answer for this fleet, and if not, why.
 *
 * `expected` is never empty: {@link readFleetForecastAggregate} answers a fleet with no active
 * sites before reaching here, and a site always has a `locationId`.
 */
const fallbackReason = (
  read: FleetRollupRangeResult,
  expected: ReadonlyMap<string, FleetRollupMembers>,
  stale: ReadonlySet<string>,
): FallbackReason | undefined => {
  const present = new Set(read.rows.map((row) => row.locationId));
  if (present.size === 0) {
    return 'absent';
  }
  // `complete: false` is a truncated page walk, which is a partition read short rather than a
  // partition written short — different causes, same consequence for the answer, so the same arm.
  if (!read.complete || ![...expected.keys()].every((location) => present.has(location))) {
    return 'incomplete';
  }
  return stale.size === 0 ? undefined : 'stale';
};

/**
 * The fan-out, aggregated server-side — what the browser used to do with the rows this route used
 * to send.
 *
 * `forecastsIn` then `fleetForecastAggregate` over the rolled-up kind, so that this arm and the
 * roll-up arm answer the same question. The filter is the shared function's rather than this file's
 * (#531): a fleet whose sites had both a physics and an ML row for an hour would otherwise read
 * here as whichever model the Query returned last, and the discrepancy would appear exactly when
 * the fallback fired — the worst possible time for the two paths to disagree.
 */
const aggregateFromFanOut = async (
  deps: FleetRollupReadDeps,
  deadline: RequestDeadline,
  sites: readonly FleetSite[],
  from: UtcIsoTimestamp,
  to: UtcIsoTimestamp,
  deadlineEvent: string,
): Promise<FleetForecastAggregateRead> => {
  const read = await readFleetSeries(deps, deadline, sites, from, to, deadlineEvent);
  if (!read.complete) {
    return read;
  }

  const forecasts = read.perSite.flatMap((points) => forecastsIn(points));

  return {
    complete: true,
    points: fleetForecastAggregate(forecasts, sites, FLEET_ROLLUP_FORECAST_KIND),
  };
};

/**
 * Sum the partials of the locations this fleet actually has active sites at, and no others.
 *
 * The filter is not defensive tidiness; without it a decommissioned location keeps generating. Its
 * partials are written under keys nothing rewrites once ingestion stops publishing for it, and they
 * outlive the last site there by the whole forecast horizon — so a fleet that lost a location would
 * carry a ghost's kilowatts, its site count and its nameplate capacity. The fan-out arm cannot do
 * that, because it iterates the site list. A ghost *site* at a surviving location is
 * {@link staleLocations}' job, which has already refused the read by the time this runs.
 *
 * TTL reaps those items, which is far too slow to be the answer here, and a producer that deleted
 * them would need an end-of-run event this design does not have (ADR 0009). Filtering at read costs
 * one `Set` lookup per row and needs neither.
 */
const summed = (
  rows: readonly FleetRollupRow[],
  expected: ReadonlyMap<string, FleetRollupMembers>,
): readonly FleetForecastAggregatePoint[] =>
  sumFleetRollupPartials(
    rows.filter((row) => expected.has(row.locationId)).map((row) => row.partial),
  );

/**
 * Read the fleet's summed forecast over `from`…`to`: the roll-up if it can answer, the fan-out if
 * it cannot.
 *
 * **`activeFleetSites` is applied once, here, which is what makes both arms answer for one fleet**
 * (#531). The narrowed list is simultaneously the expected-partial set, the fan-out's site list and
 * the nameplate divisor `fleetForecastAggregate` divides by, so there is no arrangement of this
 * module in which one of the three counts a site the others do not. Applied here rather than at the
 * route boundary because this function is also called directly by `fleet-rollup-read.test.ts`: a
 * predicate living one layer up would leave the module able to be handed an inactive site and
 * expect a partial for it.
 *
 * The roll-up Query is page-bounded on the same deadline the fan-out uses, so a request that is
 * running out of time cannot spend it all here and then discover it has to fall back too. A
 * `StorageError` from either arm travels to the route boundary as it always did — no `catch` here
 * would have anything to add (`docs/standards/error-handling.md` rule 2), and in particular a
 * roll-up read that *throws* is not a reason to fall back: the fan-out reads the same table, so it
 * would only fail again more slowly.
 */
export const readFleetForecastAggregate = async (
  deps: FleetRollupReadDeps,
  deadline: RequestDeadline,
  sites: readonly FleetSite[],
  from: UtcIsoTimestamp,
  to: UtcIsoTimestamp,
  deadlineEvent: string,
): Promise<FleetForecastAggregateRead> => {
  const active = activeFleetSites(sites);

  // A fleet with no *active* sites is answered without touching the table at all. Not an
  // optimisation: the fleet total of nothing is nothing, there is no partition state that could make
  // it otherwise, and the route's "an empty fleet is a 200 with an empty array" promise should not
  // be one billed read away from being a 500.
  if (active.length === 0) {
    return { complete: true, points: [] };
  }

  const bound: QueryPaginationBound = {
    hasBudgetForNextPage: () => hasBudgetForStorageCommands(deadline.remainingMs(), 1),
  };

  const rollup = await deps.series.queryFleetRollup(FLEET_ROLLUP_FORECAST_KIND, from, to, bound);
  const expected = expectedLocations(active);
  const stale = staleLocations(rollup.rows, expected);
  const reason = fallbackReason(rollup, expected, stale);

  if (reason === undefined) {
    return { complete: true, points: summed(rollup.rows, expected) };
  }

  deps.log({
    event: fleetRollupFallbackEvent,
    reason,
    expectedLocations: expected.size,
    presentLocations: new Set(rollup.rows.map((row) => row.locationId)).size,
    staleLocations: stale.size,
    hours: new Set(rollup.rows.map((row) => row.partial.validTime)).size,
  });

  return aggregateFromFanOut(deps, deadline, active, from, to, deadlineEvent);
};
