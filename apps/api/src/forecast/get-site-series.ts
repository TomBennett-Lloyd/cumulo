import {
  openMeteoAttribution,
  siteSeriesResponseSchema,
  utcIsoTimestampSchema,
} from '@cumulo/shared';
import type { QueryPaginationBound, SeriesAdapter, SiteAdapter } from '@cumulo/storage';
import { z } from 'zod';

import { errorResponse, jsonResponse, zodIssueDetails, type ApiResponse } from '../http/response';
import type { RouteRequest } from '../http/router';
import { hasBudgetForStorageCommands } from '../request-budget';

import { requireKnownSite } from './known-site';
import { actualsIn, forecastsIn } from './series-split';
import { spanHours } from './series-window';

/**
 * `GET /v1/sites/{siteId}/series` — forecasts and actuals over an explicit
 * window, for the accuracy views that plot the two against each other.
 *
 * The frugality property `get-site-forecast.ts` states holds here too: stored
 * rows only, zero Open-Meteo calls, attribution carried in the payload beside
 * the provenance already stored on each forecast.
 *
 * The two arrays come out of a single Query. ADR 0002's sort key interleaves a
 * site's forecasts and its actuals by valid time precisely so that "the
 * forecast and what actually happened" is one read rather than two, and the
 * response splits that list only because two named arrays are a friendlier wire
 * contract than one tagged union.
 *
 * Like the forecast route, an empty window is a 200 with empty arrays: a site
 * with no data over a range the caller chose is an answer, not a missing
 * resource. Only an unknown site id is a 404.
 */

/**
 * The widest window a single request may read: fourteen days.
 *
 * This is a cost bound, not a product limit. Each request is a Query against
 * the `series` table's provisioned capacity, and an unbounded `from`/`to` lets
 * one unauthenticated caller ask for every row a site has ever had — 90 days
 * of three points an hour under the retention TTL. Fourteen days comfortably
 * covers the longest range the web app offers (168 hours) with room for the
 * accuracy views to widen, and turns "read the whole partition" into a 400.
 */
export const MAX_SERIES_SPAN_HOURS = 336;

/**
 * The window a caller asks for, with both bounds required.
 *
 * No defaults on purpose: the forecast route is the one with an implied window
 * ("from now, forward"), and a `to` that quietly defaulted to the clock would
 * make an omitted parameter mean something different on every request.
 *
 * `from < to` is a *string* comparison, which is exactly right rather than
 * merely convenient — `utcIsoTimestampSchema` is fixed-width UTC, so
 * lexicographic order is chronological order (the same property ADR 0002's
 * range queries stand on). The bound is strict: an empty half-open window
 * `[t, t)` can only ever return nothing, so accepting it would spend a read to
 * prove it.
 */
const seriesRangeSchema = z
  .object({
    from: utcIsoTimestampSchema,
    to: utcIsoTimestampSchema,
  })
  .refine((range) => range.from < range.to, {
    message: 'from must be strictly before to',
    path: ['from'],
  })
  .refine((range) => spanHours(range.from, range.to) <= MAX_SERIES_SPAN_HOURS, {
    message: `the window must not exceed ${String(MAX_SERIES_SPAN_HOURS)} hours`,
    path: ['to'],
  });

/**
 * Emitted when this route stopped paginating because the invocation was running
 * out of time. Its own event rather than a shared one: the operator question it
 * answers — "is the fourteen-day window too wide for a 15 s function?" — is
 * about this route, and a name shared with the forecast route could not
 * distinguish them in a log query.
 */
export const seriesReadDeadlineEvent = 'api.series.read-deadline-reached';

export interface GetSiteSeriesDeps {
  readonly sites: Pick<SiteAdapter, 'getFleetSite'>;
  readonly series: Pick<SeriesAdapter, 'querySeriesRange'>;
  /** Structured-logging sink (`docs/standards/error-handling.md` rule 4). */
  readonly log: (entry: Record<string, unknown>) => void;
}

export const getSiteSeries = async (
  deps: GetSiteSeriesDeps,
  request: RouteRequest,
): Promise<ApiResponse> => {
  // Bounds first, site second: a window this API refuses to read is a 400
  // before anything is billed, and the caller learns which bound was wrong
  // rather than which lookup happened to run first.
  const range = seriesRangeSchema.safeParse({
    from: request.query.from,
    to: request.query.to,
  });
  if (!range.success) {
    return errorResponse(
      'validation_failed',
      'from and to must be UTC timestamps naming a window this API will read',
      zodIssueDetails(range.error),
    );
  }

  const site = await requireKnownSite(deps.sites, request.params);
  if (!site.known) {
    return site.response;
  }

  // One page of a fourteen-day window is a round trip this request has to be
  // able to afford, so pagination asks before each *further* page whether one
  // more command still fits in what is left of the invocation
  // (`request-budget.ts`). The first page is always issued — the bound is asked
  // between pages — which is why this route's ungated prefix counts it.
  const bound: QueryPaginationBound = {
    hasBudgetForNextPage: () => hasBudgetForStorageCommands(request.deadline.remainingMs(), 1),
  };

  const { points, complete } = await deps.series.querySeriesRange(
    site.siteId,
    range.data.from,
    range.data.to,
    bound,
  );

  // A truncated window is a 500, not a short 200. The points are real, but a
  // series silently missing its afternoon is exactly the half-truth
  // `SeriesRangeResult.complete` exists to prevent — and this route feeds the
  // accuracy views, where a gap read as "the sun did not shine" corrupts the
  // metric the product is about (`docs/standards/error-handling.md` rule 5).
  // Labelling the partial in the body and serving a 200 is the honest richer
  // answer, but it is a wire-contract change — a new field, the OpenAPI
  // document, and the web app's handling of it — deliberately not made here
  // (#165 out of scope). Until then the caller is told the request failed,
  // which is true, rather than handed data that is not.
  if (!complete) {
    deps.log({ event: seriesReadDeadlineEvent, siteId: site.siteId });
    return errorResponse('internal', 'the request could not be completed in time');
  }

  return jsonResponse(200, siteSeriesResponseSchema, {
    forecasts: forecastsIn(points),
    actuals: actualsIn(points),
    attribution: openMeteoAttribution,
  });
};
