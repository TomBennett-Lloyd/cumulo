import { fleetSiteSchema } from '@cumulo/shared';
import type { SiteAdapter } from '@cumulo/storage';

import { errorResponse, jsonResponse, type ApiResponse } from '../http/response';
import type { RouteRequest } from '../http/router';

import { parseSiteIdParam } from './site-id-param';

/**
 * `GET /v1/sites/{siteId}` — one site by id.
 *
 * A site that does not exist is a value out of the adapter (`GetFleetSiteResult`)
 * and a 404 here, never a throw: "no such site" is a domain outcome of a
 * lookup, and the boundary's 500 is reserved for things nobody predicted
 * (`docs/standards/error-handling.md` rule 1).
 */

export interface GetSiteDeps {
  readonly sites: Pick<SiteAdapter, 'getFleetSite'>;
}

export const getSite = async (deps: GetSiteDeps, request: RouteRequest): Promise<ApiResponse> => {
  const param = parseSiteIdParam(request.params);
  if (!param.valid) {
    return param.response;
  }

  const result = await deps.sites.getFleetSite(param.siteId);
  if (!result.found) {
    return errorResponse('not_found', 'no site exists with that id');
  }

  return jsonResponse(200, fleetSiteSchema, result.site);
};
