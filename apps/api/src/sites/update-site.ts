import { createSiteInputSchema, fleetSiteSchema, type FleetSite } from '@cumulo/shared';
import type { SiteAdapter } from '@cumulo/storage';

import { errorResponse, jsonResponse, zodIssueDetails, type ApiResponse } from '../http/response';
import type { RouteRequest } from '../http/router';

import { parseSiteIdParam } from './site-id-param';

/**
 * `PUT /v1/sites/{siteId}` — replace a site's caller-owned fields.
 *
 * PUT rather than PATCH, and a full replacement of exactly the fields
 * `createSiteInputSchema` describes: the same body shape validates a create and
 * an update, so a client has one site representation rather than two, and a
 * field omitted from the body is unambiguously "set it to nothing" rather than
 * "leave it alone".
 *
 * The four fields the server owns — `id`, `origin`, `createdAt`, `active` — are
 * read back from the stored site and written through unchanged. That is why this
 * is a read-modify-write rather than a blind `putFleetSite`: the adapter writes
 * whole items, so a put built only from the request body would silently
 * re-origin a seed site as a user one and reset its eviction age.
 *
 * **Last write wins.** There is no conditional expression on a version, so two
 * concurrent updates to one site resolve to whichever put lands second. For a
 * demo fleet whose sites are edited by the visitor who just added them, the
 * conflict window is theoretical and the alternative (a version attribute on
 * every item, and a 409 clients must handle) is not free. Stated rather than
 * assumed, so the day it stops being true there is something to point at.
 */

export interface UpdateSiteDeps {
  readonly sites: Pick<SiteAdapter, 'getFleetSite' | 'putFleetSite'>;
}

export const updateSite = async (
  deps: UpdateSiteDeps,
  request: RouteRequest,
): Promise<ApiResponse> => {
  const param = parseSiteIdParam(request.params);
  if (!param.valid) {
    return param.response;
  }

  const parsed = createSiteInputSchema.safeParse(request.body);
  if (!parsed.success) {
    return errorResponse(
      'validation_failed',
      'the request body is not a valid site',
      zodIssueDetails(parsed.error),
    );
  }

  const existing = await deps.sites.getFleetSite(param.siteId);
  if (!existing.found) {
    return errorResponse('not_found', 'no site exists with that id');
  }

  const updated: FleetSite = {
    ...parsed.data,
    id: existing.site.id,
    origin: existing.site.origin,
    createdAt: existing.site.createdAt,
    active: existing.site.active,
  };

  await deps.sites.putFleetSite(updated);

  return jsonResponse(200, fleetSiteSchema, updated);
};
