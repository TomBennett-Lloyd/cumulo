import {
  openMeteoAttribution,
  siteForecastResponseSchema,
  type UtcIsoTimestamp,
} from '@cumulo/shared';
import type { QueryPaginationBound, SeriesAdapter, SiteAdapter } from '@cumulo/storage';
import { z } from 'zod';

import { errorResponse, jsonResponse, zodIssueDetails, type ApiResponse } from '../http/response';
import type { RouteRequest } from '../http/router';
import { hasBudgetForStorageCommands } from '../request-budget';

import { requireKnownSite } from './known-site';
import { forecastsIn } from './series-split';
import { hoursAfter } from './series-window';

/**
 * `GET /v1/sites/{siteId}/forecast` — the next N hours of forecast for one site.
 *
 * **Frugality by construction.** This handler — and every handler in this
 * folder — makes zero Open-Meteo calls. It reads rows the ingestion and
 * forecast services already stored, which is what decouples the read load on a
 * public, unauthenticated API from the free-tier call budget CLAUDE.md commits
 * to: a dashboard refreshed a thousand times costs a thousand DynamoDB queries
 * and not one upstream request. Attribution consequently travels two ways and
 * neither of them is a fetch — `forecastSchema.weatherSource` carries the
 * provenance stored alongside each point, and the payload-level `attribution`
 * object carries the exact credit the UI is obliged to render (CC BY 4.0).
 *
 * **An empty `forecasts` array is a 200, not a 404.** A site created a moment
 * ago has no points until the next forecast cycle writes them, and that is a
 * fact about the fleet's schedule rather than about whether the site exists.
 * #17's "first forecast" poll keys on exactly this distinction: a 404 means the
 * id is wrong and polling should stop, `[]` means keep waiting.
 */

/**
 * The horizons this route offers, as the strings they arrive as.
 *
 * A closed enum rather than a bounded integer, because every value here is a
 * read whose cost is known in advance and a free-form `hours=8760` is not. The
 * three match the ranges the web app's picker offers (`RangeHours`), so a
 * request the UI can make is a request this route can answer.
 *
 * Both are exported because the OpenAPI document states this parameter's enum
 * and its default: generated from these constants, the published contract and
 * the parser cannot drift; restated in the document, they could.
 *
 * The default is applied to the *string* before the mapping, so a missing
 * parameter and an explicit `hours=48` take the identical path — a default
 * expressed as a number afterwards would be a second place the value 48 lived.
 */
export const FORECAST_HORIZON_HOURS = ['24', '48', '168'] as const;

export const DEFAULT_FORECAST_HORIZON_HOURS = '48';

const forecastHoursSchema = z
  .enum(FORECAST_HORIZON_HOURS)
  .default(DEFAULT_FORECAST_HORIZON_HOURS)
  .transform((hours) => Number.parseInt(hours, 10));

/**
 * Emitted when this route stopped paginating because the invocation was running
 * out of time. Named for this route rather than shared with `…/series`: the two
 * read different windows for different reasons, and an operator asking which of
 * them is outgrowing the function timeout needs to be able to tell them apart.
 */
export const forecastReadDeadlineEvent = 'api.forecast.read-deadline-reached';

export interface GetSiteForecastDeps {
  readonly sites: Pick<SiteAdapter, 'getFleetSite'>;
  /** Reads only: this route never writes a point (`typing.md` rule 6, ADR 0002 least privilege). */
  readonly series: Pick<SeriesAdapter, 'querySeriesRange'>;
  /** Injected, so the window a test asserts on is a window the test chose. */
  readonly now: () => UtcIsoTimestamp;
  /** Structured-logging sink (`docs/standards/error-handling.md` rule 4). */
  readonly log: (entry: Record<string, unknown>) => void;
}

export const getSiteForecast = async (
  deps: GetSiteForecastDeps,
  request: RouteRequest,
): Promise<ApiResponse> => {
  // The query is validated before the site is looked up: an unusable `hours` is
  // a 400 whether or not the site exists, and answering it here means a
  // malformed request never becomes a billed read.
  const hours = forecastHoursSchema.safeParse(request.query.hours);
  if (!hours.success) {
    return errorResponse(
      'validation_failed',
      'hours must be one of 24, 48 or 168',
      // The value was parsed on its own, so zod's own path is empty; the detail
      // names the parameter the caller sent instead.
      zodIssueDetails(hours.error).map((detail) => ({ path: 'hours', message: detail.message })),
    );
  }

  const site = await requireKnownSite(deps.sites, request.params);
  if (!site.known) {
    return site.response;
  }

  // Forward-looking by definition: the window opens at the clock, so points
  // already in the past belong to `GET …/series` and its explicit bounds.
  const from = deps.now();
  // Asked between pages, never mid-page: one more Query round trip is only
  // started while its worst case still fits in what is left of the invocation
  // (`request-budget.ts`). The 168-hour horizon is the one that can page.
  const bound: QueryPaginationBound = {
    hasBudgetForNextPage: () => hasBudgetForStorageCommands(request.deadline.remainingMs(), 1),
  };

  const { points, complete } = await deps.series.querySeriesRange(
    site.siteId,
    from,
    hoursAfter(from, hours.data),
    bound,
  );

  // A truncated horizon is a 500 rather than a short 200, for the reason
  // `get-site-series.ts` states at length: a forecast quietly missing its
  // afternoon is indistinguishable from a forecast of darkness, and #17's
  // first-forecast poll reads `[]` as "keep waiting" — so a truncation served
  // as a 200 would be misread twice over. The richer answer, a 200 labelled
  // partial, is a wire-contract change deliberately not made here (#165 out of
  // scope); until it exists, saying the request failed is the honest option.
  if (!complete) {
    deps.log({ event: forecastReadDeadlineEvent, siteId: site.siteId });
    return errorResponse('internal', 'the request could not be completed in time');
  }

  return jsonResponse(200, siteForecastResponseSchema, {
    forecasts: forecastsIn(points),
    attribution: openMeteoAttribution,
  });
};
