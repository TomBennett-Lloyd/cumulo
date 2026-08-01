import {
  createSiteInputSchema,
  fleetSiteSchema,
  MAX_USER_SITES,
  type FleetSite,
  type UtcIsoTimestamp,
} from '@cumulo/shared';
import type { SeriesAdapter, SiteAdapter } from '@cumulo/storage';

import { errorResponse, jsonResponse, zodIssueDetails, type ApiResponse } from '../http/response';
import type { RouteRequest } from '../http/router';

import { cleanUpSiteSeries } from './series-cleanup';

/**
 * `POST /v1/sites` — add a site to the fleet.
 *
 * The three fields a caller does not get to choose are chosen here:
 *
 * - **`id`** is server-assigned. `createSiteInputSchema` strips one a caller
 *   sent, so a client cannot predict, collide with, or overwrite an id it did
 *   not create. The generated id is in the 201 body, which is the only
 *   legitimate way for the caller to learn it.
 * - **`origin: 'user'`** is what places the site in the sparse
 *   `user-sites-by-age` index and so makes it evictable; seed sites carry no
 *   index attribute at all and are therefore *structurally* exempt from
 *   eviction (ADR 0002), not merely filtered out of it. Nothing arriving over
 *   HTTP may claim to be seed data.
 * - **`active: true`** — a site is added in order to be forecast; there is no
 *   route that creates a dormant one.
 *
 * **The cap, and why the route still answers 201 at it.** This write is
 * unauthenticated by design, so it needs a bound: `MAX_USER_SITES` user sites,
 * held by a counter item and a conditional transaction rather than by a
 * read-then-write that two concurrent requests could both pass. A fleet at its
 * cap is not a refusal, though — the demo's entire point is that adding a site
 * works — so the oldest user site is evicted and the new one stored in a single
 * transaction, which leaves the count unchanged and so leaves the counter
 * untouched.
 *
 * Both the clock and the id generator are injected, so the test that proves a
 * fresh uuid is echoed needs neither a real clock nor a mocked global.
 */

/** Emitted when the attempts below ran out without the site being stored. */
export const createSiteEvictionExhaustedEvent = 'api.site.create-eviction-exhausted';

/**
 * How many times a create may look up the oldest user site and try again.
 *
 * Two things below can lose a race with a concurrent create, and each loses it
 * in a way another attempt can win: the cap condition fails when someone else's
 * site took the last slot, and the eviction's `oldest_gone` means someone else
 * evicted the same site first. Retrying re-reads the index and evicts whatever
 * is oldest *now*, so an attempt is never a hot repeat of the same losing bet.
 *
 * Bounded rather than unbounded because a public write path must not be able to
 * spin: three attempts is far beyond what the throttles in front of this route
 * (2 rps per write route) can make contended, and losing three consecutive
 * races is a 500 with a log line — an incident to look at — rather than a
 * request that holds a Lambda slot until the 15-second timeout.
 */
const MAX_EVICTION_ATTEMPTS = 3;

export interface CreateSiteDeps {
  readonly sites: Pick<
    SiteAdapter,
    'createUserSiteWithCap' | 'oldestUserSite' | 'evictAndCreateUserSite'
  >;
  /** Only for cleaning up after an eviction; the API writes no series point. */
  readonly series: Pick<SeriesAdapter, 'deleteSiteSeries'>;
  /** Fixed-width UTC to the second — `utcIsoTimestampSchema`'s only accepted form. */
  readonly now: () => UtcIsoTimestamp;
  readonly newSiteId: () => string;
  /** Structured-logging sink (`docs/standards/error-handling.md` rule 4). */
  readonly log: (entry: Record<string, unknown>) => void;
}

/**
 * How the site came to be stored — which is not a detail: an eviction leaves an
 * ex-site's series points behind, and only this outcome knows whose.
 */
type StoreSiteOutcome =
  | { readonly stored: 'created' }
  | { readonly stored: 'evicted'; readonly evictedSiteId: string }
  | { readonly stored: 'exhausted' };

const storeWithinCap = async (
  sites: CreateSiteDeps['sites'],
  site: FleetSite,
): Promise<StoreSiteOutcome> => {
  for (let attempt = 0; attempt < MAX_EVICTION_ATTEMPTS; attempt += 1) {
    const created = await sites.createUserSiteWithCap(site, MAX_USER_SITES);
    if (created.created) {
      return { stored: 'created' };
    }

    const oldest = await sites.oldestUserSite();
    if (!oldest.found) {
      // The counter says full and the index offers nothing to evict, so the two
      // disagree: either a concurrent delete is mid-flight, or the counter has
      // drifted above the real user population. Neither is something to fix
      // from a request — a bare decrement here would be the corruption, not the
      // cure — so try the create again and let a concurrent delete's decrement
      // make room. Persistent drift exhausts the attempts and is logged.
      continue;
    }

    const evicted = await sites.evictAndCreateUserSite(oldest.siteId, site);
    if (evicted.evicted) {
      return { stored: 'evicted', evictedSiteId: oldest.siteId };
    }
  }

  return { stored: 'exhausted' };
};

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

  const outcome = await storeWithinCap(deps.sites, site);

  if (outcome.stored === 'exhausted') {
    // A 500 rather than a 503: nothing here tells the caller when to come back,
    // and the honest reading is that the fleet's counter and index disagreed
    // more persistently than contention explains. The log line is the only
    // place that says so — the caller gets no detail about the fleet's state.
    deps.log({
      event: createSiteEvictionExhaustedEvent,
      siteId: site.id,
      attempts: MAX_EVICTION_ATTEMPTS,
    });
    return errorResponse('internal', 'the site could not be added');
  }

  if (outcome.stored === 'evicted') {
    await cleanUpSiteSeries(deps, outcome.evictedSiteId);
  }

  return jsonResponse(201, fleetSiteSchema, site);
};
