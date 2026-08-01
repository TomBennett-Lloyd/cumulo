import { listSitesResponseSchema } from '@cumulo/shared';
import type { SiteAdapter } from '@cumulo/storage';

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

export const listSites = async (deps: ListSitesDeps): Promise<ApiResponse> => {
  const sites = await deps.sites.listFleetSites();

  return jsonResponse(200, listSitesResponseSchema, { sites });
};
