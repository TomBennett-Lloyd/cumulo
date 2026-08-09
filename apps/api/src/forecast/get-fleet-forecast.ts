import {
  fleetForecastResponseSchema,
  openMeteoAttribution,
  type UtcIsoTimestamp,
} from '@cumulo/shared';
import type { SeriesAdapter, SiteAdapter } from '@cumulo/storage';
import { z } from 'zod';

import { errorResponse, jsonResponse, zodIssueDetails, type ApiResponse } from '../http/response';
import type { RouteRequest } from '../http/router';

import { readFleetSeries } from './fleet-series-read';
import { DEFAULT_FORECAST_HORIZON_HOURS, FORECAST_HORIZON_HOURS } from './get-site-forecast';
import { forecastsIn } from './series-split';
import { hoursAfter } from './series-window';

/**
 * `GET /v1/fleet/forecast` — every fleet site's forecast over one forward
 * horizon, in one request.
 *
 * **The mirror of `get-fleet-actuals.ts`, and it exists for the same arithmetic.**
 * The web app plots the fleet forecast beside the fleet's actual output, so it
 * needs every site's points on every load. Assembled in the browser that is one
 * `GET …/forecast` per site; server-side it is one request whose DynamoDB
 * Queries are spent against a budget the *invocation* owns. That route's
 * docblock has the full argument — this one points at it rather than restating
 * it (`docs/standards/architecture.md` rule 9).
 *
 * **Forward-looking by definition.** The window opens at the clock and runs
 * `hours` ahead, which is what makes this route the actuals route read
 * backwards; points already in the past belong to `GET …/series` and its
 * explicit bounds.
 *
 * **Frugality holds here as everywhere in this folder**: stored rows only, zero
 * Open-Meteo calls, and the payload-level attribution the CC BY 4.0 licence
 * obliges every consumer of this data to display.
 *
 * **An empty fleet, or a fleet whose sites hold no points yet, is a 200 with
 * `forecasts: []`.** A fleet with nothing forecast for it yet is an answer about
 * the schedule rather than about whether the fleet exists — the distinction
 * `get-site-forecast.ts` draws for a site created moments ago, and the one #17's
 * first-forecast poll reads.
 */

/**
 * The horizons this route offers, and the one it assumes — `get-site-forecast.ts`'s
 * both times, imported rather than declared again.
 *
 * The per-site forecast route owns both values, and this route wants exactly
 * them: same direction, same menu (`RangeHours` in
 * `apps/web/src/data/fleet-data-source.ts` requires every source to serve every
 * member), same assumption when the picker has not been touched. So there is
 * nothing here for a second declaration to say — `docs/standards/architecture.md`
 * rule 9 gives the fact one owner and this file names it.
 *
 * `get-fleet-actuals.ts` declares its own default for the opposite reason: `24`
 * is the window a dashboard shows *behind* a forecast, so its default is
 * genuinely its own value and not this one seen from another route.
 */
const fleetForecastHoursSchema = z
  .enum(FORECAST_HORIZON_HOURS)
  .default(DEFAULT_FORECAST_HORIZON_HOURS)
  .transform((hours) => Number.parseInt(hours, 10));

/**
 * Emitted when this route stopped reading because the invocation was running
 * out of time. Its own event rather than one shared with the fleet-actuals
 * fan-out or the per-site routes: both fleet routes' cost grows with the fleet,
 * so "which of them is outgrowing a 15-second function?" is a question only
 * distinct event names can answer in a log query.
 */
export const fleetForecastReadDeadlineEvent = 'api.fleet-forecast.read-deadline-reached';

/**
 * The same four collaborators as `GetFleetActualsDeps`, named separately rather
 * than shared.
 *
 * `docs/standards/structure.md` rule 7's test — would one be wrong if the other
 * changed? — answers no: these are the dependencies of *this* route, and the
 * two are free to diverge (a fleet forecast that later admitted a model
 * selector, say, would take something the actuals route has no use for). One
 * shared name would couple them on a resemblance that is currently exact and
 * not structural.
 */
export interface GetFleetForecastDeps {
  /** Only the listing: this route never writes a site (`typing.md` rule 6, ADR 0002 least privilege). */
  readonly sites: Pick<SiteAdapter, 'listFleetSites'>;
  /** Reads only: forecast rows are written by the forecast service, not here. */
  readonly series: Pick<SeriesAdapter, 'querySeriesRange'>;
  /** Injected, so the window a test asserts on is a window the test chose. */
  readonly now: () => UtcIsoTimestamp;
  /** Structured-logging sink (`docs/standards/error-handling.md` rule 4). */
  readonly log: (entry: Record<string, unknown>) => void;
}

export const getFleetForecast = async (
  deps: GetFleetForecastDeps,
  request: RouteRequest,
): Promise<ApiResponse> => {
  // Validated before anything is listed: an unusable `hours` is a 400 whatever
  // the fleet looks like, and answering it here means a malformed request never
  // becomes a billed read.
  const hours = fleetForecastHoursSchema.safeParse(request.query.hours);
  if (!hours.success) {
    return errorResponse(
      'validation_failed',
      'hours must be one of 24, 48 or 168',
      // The value was parsed on its own, so zod's own path is empty; the detail
      // names the parameter the caller sent instead.
      zodIssueDetails(hours.error).map((detail) => ({ path: 'hours', message: detail.message })),
    );
  }

  const sites = await deps.sites.listFleetSites();

  // One window for the whole fleet, taken from one reading of the clock: a
  // per-site `now()` would give the last site a window a few milliseconds later
  // than the first, and the consumer buckets these points by valid time.
  const from = deps.now();
  const to = hoursAfter(from, hours.data);

  // The sequential, deadline-gated fan-out, and its refusal: shared with
  // `GET /v1/fleet/actuals`, which reads the same sites over the same kind of
  // window in the opposite direction (`fleet-series-read.ts` argues the split).
  // `deps` goes in whole — `GetFleetForecastDeps` is a superset of what the read
  // needs, and the `Pick` in `FleetSeriesReadDeps` is what narrows it.
  const read = await readFleetSeries(
    deps,
    request.deadline,
    sites,
    from,
    to,
    fleetForecastReadDeadlineEvent,
  );

  if (!read.complete) {
    return read.response;
  }

  // Split per site and flattened once, rather than a split of one concatenated
  // list: the wire order is site by site, chronological within each.
  return jsonResponse(200, fleetForecastResponseSchema, {
    forecasts: read.perSite.flatMap((points) => forecastsIn(points)),
    attribution: openMeteoAttribution,
  });
};
