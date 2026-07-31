import type { SiteAdapter } from '@cumulo/storage';

import { errorResponse, type ApiResponse } from '../http/response';
import type { RouteRequest } from '../http/router';

import { parseSiteIdParam } from './site-id-param';

/**
 * `DELETE /v1/sites/{siteId}` — remove a site from the fleet.
 *
 * 204 when something was deleted, 404 when there was nothing to delete. The
 * adapter can tell the difference (`ReturnValues: 'ALL_OLD'`), and reporting it
 * costs nothing: a delete that answered 204 unconditionally would tell a client
 * that mistyped an id that it had succeeded.
 *
 * **The site's series rows are not deleted here.** `cumulo-series` items carry
 * the 90-day TTL of ADR 0002, so a deleted site's forecasts and actuals expire
 * on their own; nothing reads them meanwhile, because every series route looks
 * the site up first and 404s. An explicit range-delete of the orphans (access
 * pattern X3) belongs with #29's eviction machinery, which is where the same
 * cleanup is needed for evicted sites.
 */

export interface DeleteSiteDeps {
  readonly sites: Pick<SiteAdapter, 'deleteFleetSite'>;
}

export const deleteSite = async (
  deps: DeleteSiteDeps,
  request: RouteRequest,
): Promise<ApiResponse> => {
  const param = parseSiteIdParam(request.params);
  if (!param.valid) {
    return param.response;
  }

  const { deleted } = await deps.sites.deleteFleetSite(param.siteId);
  if (!deleted) {
    return errorResponse('not_found', 'no site exists with that id');
  }

  // No body and no content-type: 204 is the one response on this API that has
  // nothing to say, and an empty JSON object would be a lie about that.
  return { statusCode: 204, headers: {} };
};
