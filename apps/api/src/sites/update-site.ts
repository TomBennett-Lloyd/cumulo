import {
  createSiteInputSchema,
  fleetSiteSchema,
  type CreateSiteInput,
  type FleetSite,
} from '@cumulo/shared';
import type { SiteAdapter } from '@cumulo/storage';

import {
  errorResponse,
  jsonResponse,
  zodIssueDetails,
  type ApiErrorDetails,
  type ApiResponse,
} from '../http/response';
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
 * **A site's location is immutable** (#629). A body whose `latitude` or `longitude`
 * differs from the stored site's is refused with `validation_failed`, because a
 * move is a delete and an add: the fleet roll-ups treat a departed location and
 * an arrival as separate histories, and a site that kept its `createdAt` while
 * changing place would owe the new place history it cannot hold. The comparison
 * is exact on the stored numbers: a PUT that repeats them is an edit.
 *
 * The three fields the server owns — `id`, `origin`, `createdAt` — are read back
 * from the stored site and written through unchanged, which is why this is a
 * read-modify-write rather than a blind `putFleetSite` (`update-site.test.ts`).
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

const movedCoordinates = (stored: FleetSite, requested: CreateSiteInput): ApiErrorDetails =>
  (['latitude', 'longitude'] as const)
    .filter((field) => stored[field] !== requested[field])
    .map((field) => ({
      path: field,
      message: `a site's location cannot be changed; delete the site and add it again (stored ${String(stored[field])}, requested ${String(requested[field])})`,
    }));

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

  const moved = movedCoordinates(existing.site, parsed.data);
  if (moved.length > 0) {
    return errorResponse(
      'validation_failed',
      "a site's location cannot be changed; delete the site and add it again at the new location",
      moved,
    );
  }

  const updated: FleetSite = {
    ...parsed.data,
    id: existing.site.id,
    origin: existing.site.origin,
    createdAt: existing.site.createdAt,
  };

  await deps.sites.putFleetSite(updated);

  return jsonResponse(200, fleetSiteSchema, updated);
};
