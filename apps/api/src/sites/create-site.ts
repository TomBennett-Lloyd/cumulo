import {
  createSiteInputSchema,
  fleetSiteSchema,
  type FleetSite,
  type UtcIsoTimestamp,
} from '@cumulo/shared';
import type { SiteAdapter } from '@cumulo/storage';

import { errorResponse, jsonResponse, zodIssueDetails, type ApiResponse } from '../http/response';
import type { RouteRequest } from '../http/router';

/**
 * `POST /v1/sites` — add a site to the fleet.
 *
 * The three fields a caller does not get to choose are chosen here:
 *
 * - **`id`** is server-assigned. `createSiteInputSchema` strips one a caller
 *   sent, so a client cannot predict, collide with, or overwrite an id it did
 *   not create. The generated id is in the 201 body, which is the only
 *   legitimate way for the caller to learn it.
 * - **`origin: 'user'`** is what makes the site visible to #29's eviction index
 *   and invisible to the seed fleet's exemption (ADR 0002). Nothing arriving
 *   over HTTP may claim to be seed data.
 * - **`active: true`** — a site is added in order to be forecast; there is no
 *   route that creates a dormant one.
 *
 * Both the clock and the id generator are injected, so the test that proves a
 * fresh uuid is echoed needs neither a real clock nor a mocked global.
 */

export interface CreateSiteDeps {
  readonly sites: Pick<SiteAdapter, 'putFleetSite'>;
  /** Fixed-width UTC to the second — `utcIsoTimestampSchema`'s only accepted form. */
  readonly now: () => UtcIsoTimestamp;
  readonly newSiteId: () => string;
}

export const createSite = async (
  deps: CreateSiteDeps,
  request: RouteRequest,
): Promise<ApiResponse> => {
  const parsed = createSiteInputSchema.safeParse(request.body);
  if (!parsed.success) {
    return errorResponse(
      'validation_failed',
      'the request body is not a valid site',
      zodIssueDetails(parsed.error),
    );
  }

  const site: FleetSite = {
    ...parsed.data,
    id: deps.newSiteId(),
    origin: 'user',
    createdAt: deps.now(),
    active: true,
  };

  await deps.sites.putFleetSite(site);

  return jsonResponse(201, fleetSiteSchema, site);
};
