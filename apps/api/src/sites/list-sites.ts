import { fleetSiteSchema } from '@cumulo/shared';
import type { SiteAdapter } from '@cumulo/storage';
import { z } from 'zod';

import { jsonResponse, type ApiResponse } from '../http/response';

/**
 * `GET /v1/sites` — the whole fleet, seed and user, active and inactive.
 *
 * Unpaginated on purpose: ADR 0002 holds the fleet in a single partition and
 * #29 caps how many user sites can exist, so "the whole fleet" is a bounded
 * answer by design rather than by luck. If that cap ever leaves, this is the
 * endpoint that needs a cursor.
 */

export interface ListSitesDeps {
  /** Only the listing: this route never writes (`typing.md` rule 6, ADR 0002 least privilege). */
  readonly sites: Pick<SiteAdapter, 'listFleetSites'>;
}

/**
 * An object rather than a bare array. A top-level JSON array cannot grow a
 * sibling field — a cursor, a count, a partial-results flag — without breaking
 * every client, and this API expects at least one of those eventually.
 */
export const listSitesResponseSchema = z.object({
  sites: z.array(fleetSiteSchema),
});

export const listSites = async (deps: ListSitesDeps): Promise<ApiResponse> => {
  const sites = await deps.sites.listFleetSites();

  return jsonResponse(200, listSitesResponseSchema, { sites });
};
