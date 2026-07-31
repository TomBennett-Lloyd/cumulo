import type { SiteAdapter } from '@cumulo/storage';

import { errorResponse, type ApiResponse } from '../http/response';
import { parseSiteIdParam } from '../sites/site-id-param';

/**
 * The "is there such a site at all" gate both series routes open with.
 *
 * Shared rather than repeated because the two copies would have identical
 * intent: if the shape of a site id changed, or an unknown site stopped being a
 * 404, both routes would be wrong until both changed
 * (`docs/standards/structure.md` rule 7). `GET /v1/sites/{siteId}` deliberately
 * does *not* route through here — it needs the site itself for its body, so
 * "does it exist" and "give me the row" are different questions there, and
 * folding them together would mean this function returned a site every caller
 * but one throws away.
 *
 * The order — parse the path parameter, then read — is the cost order. A
 * segment that is not a uuid is answered before DynamoDB is asked anything, so
 * a scan of nonsense ids costs nothing but CPU.
 *
 * The adapter is passed whole rather than as `sites.getFleetSite`: it carries
 * its client and table on `this`, and a detached method would arrive here
 * already broken (`architecture.md` rule 7).
 */

export type KnownSiteResult =
  | { readonly known: true; readonly siteId: string }
  | { readonly known: false; readonly response: ApiResponse };

export const requireKnownSite = async (
  sites: Pick<SiteAdapter, 'getFleetSite'>,
  params: Record<string, string>,
): Promise<KnownSiteResult> => {
  const param = parseSiteIdParam(params);
  if (!param.valid) {
    return { known: false, response: param.response };
  }

  const result = await sites.getFleetSite(param.siteId);
  if (!result.found) {
    // The same wording `GET /v1/sites/{siteId}` uses. One unknown site, one
    // sentence, whichever route the caller was on.
    return { known: false, response: errorResponse('not_found', 'no site exists with that id') };
  }

  return { known: true, siteId: param.siteId };
};
