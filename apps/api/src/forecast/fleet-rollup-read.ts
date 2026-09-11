import {
  FLEET_ROLLUP_FORECAST_KIND,
  fleetForecastAggregate,
  locationId,
  sumFleetRollupPartials,
  type FleetForecastAggregatePoint,
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
 * location: a `#FLEET` partition that is empty would otherwise be a blank chart for up to an hour,
 * and a 500 would be worse.
 *
 * **Incomplete counts as absent, deliberately.** A partition holding eleven of twelve locations
 * sums to a fleet total that looks exactly like a plausible number from a quieter fleet — there is
 * no gap to see, because the missing site does not read as missing, it reads as less generation.
 * That is the half-truth `fleet-series-read.ts` refuses for the fan-out, applied to the roll-up.
 * Completeness is mechanical rather than a guess: the route already lists the fleet and every site
 * carries coordinates, so the expected location set is exactly `sites.map(locationId)` — the same
 * function ingestion keys its messages on, so the two sets are the same partition of the fleet by
 * construction rather than by agreement.
 *
 * **One release, then gone.** Every fallback logs {@link fleetRollupFallbackEvent} with the counts
 * that explain it, so "has a full cycle written every location yet?" is one log query. When the
 * event has been absent for 24 hours after the first post-deploy cycle, the fallback and this
 * module's second arm come out (the removal issue ADR 0009 names).
 */

/**
 * The one event a fallback emits — exported so a test asserts on the name an operator greps for
 * rather than on a copy of it, and so the removal ticket has something to search for.
 *
 * One event with a `reason` rather than two events, because an operator watching a deployment wants
 * a single line to count: the question is "is the roll-up being used yet", and `absent` versus
 * `incomplete` is the detail that says how far through the first cycle the answer is.
 */
export const fleetRollupFallbackEvent = 'api.fleet-forecast.rollup-fallback';

/** Why the roll-up could not answer. `absent`: nothing written at all. `incomplete`: some of it. */
type FallbackReason = 'absent' | 'incomplete';

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
 * {@link FleetSeriesRead}'s shape and its reasoning: a discriminated union rather than points plus
 * an optional error (`docs/standards/typing.md` rule 4), with the failure arm carrying a built
 * {@link ApiResponse} because the only refusal reachable here is the fan-out's deadline and its
 * status, code and message are already that module's to decide.
 */
export type FleetForecastAggregateRead =
  | { readonly complete: true; readonly points: readonly FleetForecastAggregatePoint[] }
  | { readonly complete: false; readonly response: ApiResponse };

/**
 * Which locations the fleet expects a partial from — one per distinct weather bucket its sites sit
 * in.
 *
 * A `Set` because two sites in one bucket are one expected partial: `locationId` is what the
 * producer's messages are keyed by (ADR 0004), so twelve cluster locations holding sixty sites
 * expect twelve partials and not sixty.
 */
const expectedLocations = (sites: readonly FleetSite[]): ReadonlySet<string> =>
  new Set(sites.map((site) => locationId(site)));

/**
 * Whether a roll-up read can answer for this fleet, and if not, why.
 *
 * An empty fleet expects nothing, so an empty partition answers it completely — which is the right
 * answer and not a lucky one: a fleet with no sites has a fleet total of nothing, and falling back
 * to a fan-out over zero sites to discover that would be the same empty answer at the cost of a
 * round trip.
 */
const fallbackReason = (
  read: FleetRollupRangeResult,
  expected: ReadonlySet<string>,
): FallbackReason | undefined => {
  const present = new Set(read.rows.map((row) => row.locationId));
  if (expected.size === 0) {
    return undefined;
  }
  if (present.size === 0) {
    return 'absent';
  }
  // `complete: false` is a truncated page walk, which is a partition read short rather than a
  // partition written short — different causes, same consequence for the answer, so the same arm.
  return read.complete && [...expected].every((location) => present.has(location))
    ? undefined
    : 'incomplete';
};

/**
 * The fan-out, aggregated server-side — what the browser used to do with the rows this route used
 * to send.
 *
 * `forecastsIn` then `fleetForecastAggregate`, filtered to the rolled-up model so that this arm and
 * the roll-up arm answer the same question. Without the filter a fleet whose sites had both a
 * physics and an ML row for an hour would read as twice the fleet here and as the fleet there, and
 * the discrepancy would appear exactly when the fallback fired — the worst possible time for the
 * two paths to disagree.
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

  const forecasts = read.perSite
    .flatMap((points) => forecastsIn(points))
    .filter((forecast) => forecast.model === FLEET_ROLLUP_FORECAST_KIND.model);

  return { complete: true, points: fleetForecastAggregate(forecasts, sites) };
};

const summed = (rows: readonly FleetRollupRow[]): readonly FleetForecastAggregatePoint[] =>
  sumFleetRollupPartials(rows.map((row) => row.partial));

/**
 * Read the fleet's summed forecast over `from`…`to`: the roll-up if it can answer, the fan-out if
 * it cannot.
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
  // A fleet with no sites is answered without touching the table at all. Not an optimisation: the
  // fleet total of nothing is nothing, there is no partition state that could make it otherwise,
  // and the route's "an empty fleet is a 200 with an empty array" promise should not be one billed
  // read away from being a 500.
  if (sites.length === 0) {
    return { complete: true, points: [] };
  }

  const bound: QueryPaginationBound = {
    hasBudgetForNextPage: () => hasBudgetForStorageCommands(deadline.remainingMs(), 1),
  };

  const rollup = await deps.series.queryFleetRollup(FLEET_ROLLUP_FORECAST_KIND, from, to, bound);
  const expected = expectedLocations(sites);
  const reason = fallbackReason(rollup, expected);

  if (reason === undefined) {
    return { complete: true, points: summed(rollup.rows) };
  }

  deps.log({
    event: fleetRollupFallbackEvent,
    reason,
    expectedLocations: expected.size,
    presentLocations: new Set(rollup.rows.map((row) => row.locationId)).size,
    hours: new Set(rollup.rows.map((row) => row.partial.validTime)).size,
  });

  return aggregateFromFanOut(deps, deadline, sites, from, to, deadlineEvent);
};
