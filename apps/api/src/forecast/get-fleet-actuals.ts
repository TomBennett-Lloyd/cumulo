import {
  fleetActualsResponseSchema,
  openMeteoAttribution,
  type GenerationReading,
  type UtcIsoTimestamp,
} from '@cumulo/shared';
import type { QueryPaginationBound, SeriesAdapter, SiteAdapter } from '@cumulo/storage';
import { z } from 'zod';

import { errorResponse, jsonResponse, zodIssueDetails, type ApiResponse } from '../http/response';
import type { RouteRequest } from '../http/router';
import { hasBudgetForStorageCommands } from '../request-budget';

import { FORECAST_HORIZON_HOURS } from './get-site-forecast';
import { actualsIn } from './series-split';
import { hoursBefore } from './series-window';

/**
 * `GET /v1/fleet/actuals` — every fleet site's actuals over one look-back
 * window, in one request.
 *
 * **Why the fleet gets its own route.** The web app plots the fleet's actual
 * output beside the fleet forecast, which means it needs every site's readings
 * on every load. Assembled in the browser that is one `GET …/series` per site,
 * and that read is rate-limited at 30 requests per 60-second window per address
 * (ADR 0006): a fleet larger than a handful of sites would refuse itself on the
 * first page view, and the refusal would arrive as a partly-drawn chart. One
 * request that fans out server-side spends the same DynamoDB Queries against a
 * budget the *invocation* owns rather than against a limiter meant to price a
 * caller's appetite.
 *
 * **The readings are simulated.** The demo fleet has no inverters and no
 * telemetry; the producer synthesizes each reading from the stored physics
 * forecast (#264). That is a claim about provenance rather than about shape —
 * `generationReadingSchema` is the same object a real meter would fill — so it
 * is stated in the OpenAPI description and in the UI's own copy rather than
 * carried as a field on every point.
 *
 * **Frugality holds here as everywhere in this folder**: stored rows only, zero
 * Open-Meteo calls, and the payload-level attribution the CC BY 4.0 licence
 * obliges every consumer of this data to display.
 *
 * **An empty fleet, or a fleet whose sites have no readings yet, is a 200 with
 * `actuals: []`.** A fleet with no readings behind it yet is an answer about the
 * schedule, not about whether the fleet exists — the same distinction
 * `get-site-forecast.ts` draws for a site created moments ago.
 */

/**
 * The look-back windows this route offers, and the one it assumes.
 *
 * The set is `get-site-forecast.ts`'s rather than a second list beside it: both
 * are the ranges the web app's picker offers (`RangeHours` in
 * `apps/web/src/data/fleet-data-source.ts`, which requires every source to serve
 * every member), so a range added there has to appear on both routes or the
 * picker gets an option one of them refuses. Imported rather than copied for
 * exactly that reason (`docs/standards/structure.md` rule 7) — the direction
 * differs, the menu does not.
 *
 * The default is this route's own. `48` is the horizon a forecast is most often
 * asked for; `24` is the window a dashboard shows behind it, and it is what the
 * web app requests when its picker has not been touched.
 */
export const DEFAULT_FLEET_LOOKBACK_HOURS = '24';

const fleetLookbackHoursSchema = z
  .enum(FORECAST_HORIZON_HOURS)
  .default(DEFAULT_FLEET_LOOKBACK_HOURS)
  .transform((hours) => Number.parseInt(hours, 10));

/**
 * Emitted when this route stopped reading because the invocation was running
 * out of time. Its own event rather than one shared with the per-site routes:
 * this is the only route whose cost grows with the fleet, so "is the fleet
 * outgrowing a 15-second function?" is a question only these entries can answer,
 * and a name shared with `api.series.read-deadline-reached` could not separate
 * them in a log query.
 */
export const fleetActualsReadDeadlineEvent = 'api.fleet-actuals.read-deadline-reached';

export interface GetFleetActualsDeps {
  /** Only the listing: this route never writes a site (`typing.md` rule 6, ADR 0002 least privilege). */
  readonly sites: Pick<SiteAdapter, 'listFleetSites'>;
  /** Reads only: the simulated readings are written by the forecast service, not here. */
  readonly series: Pick<SeriesAdapter, 'querySeriesRange'>;
  /** Injected, so the window a test asserts on is a window the test chose. */
  readonly now: () => UtcIsoTimestamp;
  /** Structured-logging sink (`docs/standards/error-handling.md` rule 4). */
  readonly log: (entry: Record<string, unknown>) => void;
}

/**
 * The one 500 this route answers, with the log line that says where it stopped.
 *
 * Two call sites — the fan-out stopped between sites, and one site's window
 * stopped mid-page — and deliberately one message and one event: a caller can do
 * nothing different with the two, while an operator reads the difference off the
 * fields in `detail`. One function rather than the message written twice, so the
 * two cannot drift into two contracts (`docs/standards/structure.md` rule 7).
 */
const readDeadlineReached = (
  log: GetFleetActualsDeps['log'],
  detail: Record<string, unknown>,
): ApiResponse => {
  log({ event: fleetActualsReadDeadlineEvent, ...detail });
  return errorResponse('internal', 'the request could not be completed in time');
};

export const getFleetActuals = async (
  deps: GetFleetActualsDeps,
  request: RouteRequest,
): Promise<ApiResponse> => {
  // Validated before anything is listed: an unusable `hours` is a 400 whatever
  // the fleet looks like, and answering it here means a malformed request never
  // becomes a billed read.
  const hours = fleetLookbackHoursSchema.safeParse(request.query.hours);
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
  // than the first, and the consumer buckets these readings by valid time.
  const to = deps.now();
  const from = hoursBefore(to, hours.data);

  // Asked between pages of one site's Query, never mid-page (`request-budget.ts`).
  const bound: QueryPaginationBound = {
    hasBudgetForNextPage: () => hasBudgetForStorageCommands(request.deadline.remainingMs(), 1),
  };

  // One array per site, flattened once at the end rather than spread-pushed per
  // site: the wire order is site by site, chronological within each, which is
  // the order the demo source produces too and the order the fleet chart's
  // hour-by-hour aggregation is indifferent to.
  const perSite: GenerationReading[][] = [];

  for (const [index, site] of sites.entries()) {
    // Sequential, and gated before every site *after* the first — the first
    // Query is this route's ungated prefix, as it is on every read here. A
    // parallel fan-out would spend the fleet's worth of Queries with nothing
    // between them to stop, which is the shape the deadline exists to refuse.
    if (index > 0 && !hasBudgetForStorageCommands(request.deadline.remainingMs(), 1)) {
      return readDeadlineReached(deps.log, { sitesRead: index, fleetSize: sites.length });
    }

    const { points, complete } = await deps.series.querySeriesRange(site.id, from, to, bound);

    // A fleet short of one site's afternoon is the half-truth `get-site-series.ts`
    // refuses at length, and it is worse here: these readings are summed hour by
    // hour, so a missing site does not read as missing — it reads as a fleet
    // that generated less. Serving the whole thing or nothing is the only
    // honest option this wire contract offers
    // (`docs/standards/error-handling.md` rule 5); labelling the response
    // partial is the richer answer and is the same contract change #165 holds
    // for the per-site routes.
    if (!complete) {
      return readDeadlineReached(deps.log, { siteId: site.id });
    }

    perSite.push(actualsIn(points));
  }

  return jsonResponse(200, fleetActualsResponseSchema, {
    actuals: perSite.flat(),
    attribution: openMeteoAttribution,
  });
};
