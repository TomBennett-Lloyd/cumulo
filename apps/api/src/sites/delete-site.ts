import type { SeriesAdapter, SiteAdapter } from '@cumulo/storage';

import { errorResponse, type ApiResponse } from '../http/response';
import type { RouteRequest } from '../http/router';

import { cleanUpSiteSeries } from './series-cleanup';
import { parseSiteIdParam } from './site-id-param';

/**
 * `DELETE /v1/sites/{siteId}` — remove a site from the fleet.
 *
 * 204 when something was deleted, 404 when there was nothing to delete. The
 * adapters can tell the difference, and reporting it costs nothing: a delete
 * that answered 204 unconditionally would tell a client that mistyped an id
 * that it had succeeded.
 *
 * **The site is read before it is deleted**, which the previous single-shot
 * delete did not need to do. `origin` decides which delete is correct: a user
 * site is one half of the cap's arithmetic, so it leaves through
 * `deleteUserSiteWithCount` and takes a counter decrement with it in the same
 * transaction; a seed site was never counted, so decrementing for it would
 * quietly raise the effective cap by one per seed site deleted. There is no way
 * to pick between them without knowing what kind of site this is.
 *
 * **The site's series points go too** (access pattern X3): `cleanUpSiteSeries`
 * range-deletes them, best-effort, with the 90-day TTL of ADR 0002 as the
 * backstop rather than the plan. It runs after the row is gone, in that order
 * on purpose — every series route looks the site up first and 404s, so from the
 * moment the row goes the points are unreachable, and a cleanup that ran first
 * would be deleting the points of a site that a lost race might leave in place.
 */

export interface DeleteSiteDeps {
  readonly sites: Pick<SiteAdapter, 'getFleetSite' | 'deleteFleetSite' | 'deleteUserSiteWithCount'>;
  readonly series: Pick<SeriesAdapter, 'deleteSiteSeries'>;
  /** Structured-logging sink (`docs/standards/error-handling.md` rule 4). */
  readonly log: (entry: Record<string, unknown>) => void;
}

const noSuchSite = (): ApiResponse => errorResponse('not_found', 'no site exists with that id');

export const deleteSite = async (
  deps: DeleteSiteDeps,
  request: RouteRequest,
): Promise<ApiResponse> => {
  const param = parseSiteIdParam(request.params);
  if (!param.valid) {
    return param.response;
  }

  const found = await deps.sites.getFleetSite(param.siteId);
  if (!found.found) {
    return noSuchSite();
  }

  const { deleted } =
    found.site.origin === 'user'
      ? await deps.sites.deleteUserSiteWithCount(param.siteId)
      : await deps.sites.deleteFleetSite(param.siteId);

  if (!deleted) {
    // The read said the site was there and the delete's condition said it was
    // not, so a concurrent delete won between the two. That request answered
    // 204 and this one is a delete of nothing — the same 404 a mistyped id
    // gets, and emphatically not a decrement, which the transaction has
    // already declined to make.
    return noSuchSite();
  }

  await cleanUpSiteSeries(deps, param.siteId);

  // No body and no content-type: 204 is the one response on this API that has
  // nothing to say, and an empty JSON object would be a lie about that.
  return { statusCode: 204, headers: {} };
};
