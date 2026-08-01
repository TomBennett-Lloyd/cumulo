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

import { conflictRetryDelayMs } from './conflict-retry';
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
export const createSiteStoreExhaustedEvent = 'api.site.create-store-exhausted';

/**
 * How many times this route may try to store the site before giving up: **12**.
 *
 * An attempt is consumed by any *loss*, and there are three kinds, each losable
 * in a way another attempt can win:
 *
 * - **`conflict`** — DynamoDB cancelled the transaction because a concurrent one
 *   was writing the same row (the counter, in practice). It says nothing about
 *   the cap, so the next attempt simply re-issues the create.
 * - **`cap` then `oldest_gone`** — the last free slot went to someone else's
 *   site, and by the time this request tried to evict the oldest one, another
 *   request had evicted it first. Retrying re-reads the index and evicts
 *   whatever is oldest *now*, so an attempt is never a hot repeat of the same
 *   losing bet.
 * - **`counter_index_drift`** — the counter says full and the `user-sites-by-age`
 *   index offers nothing to evict.
 *
 * **Where 12 comes from.** It is a derivation, not an assertion, and it shares
 * its one premise with `./conflict-retry.ts`: at most 10 transactions can be
 * writing the fleet counter at once — the two counter-writing route keys admit
 * 4 + 2 each per second under `infra/api/gateway.tf`'s `route_settings`
 * (`throttling_rate_limit = 2`, `throttling_burst_limit = 4`), and the account's
 * Lambda concurrency limit of 10 (measured in #29) binds below that combined 12,
 * because requests past it are refused at Lambda before they reach DynamoDB.
 * Each round of contention has a winner, so a request loses at most 9 rounds
 * before its turn: 9 losses + the attempt that wins = 10. The remaining **2** is
 * slack for the one loss that is not adversarial — the `user-sites-by-age` index
 * is eventually consistent and can re-serve a site an earlier attempt already
 * evicted, which costs an attempt without anyone having lost a race.
 *
 * **Why this is not still 3.** #29's E2 attempt-2 fired 11 rounds of 6 parallel
 * creates and got 8 × 500 back, one of them `"the site could not be added"` —
 * the old 3-attempt budget exhausting under exactly the contention it claimed
 * was implausible. That 500 is the regression this number exists to prevent,
 * and the reason the derivation above counts contenders instead of asserting
 * that the throttle makes contention rare.
 *
 * Bounded rather than unbounded all the same, and for the reason it always was:
 * a public, unauthenticated write path that can spin holds one of ten Lambda
 * slots until the 15-second timeout. Exhausting 12 attempts is a 500 with a log
 * line — an incident to look at — because contention no longer explains it.
 */
const MAX_STORE_ATTEMPTS = 12;

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
  /**
   * The backoff between attempts. Injected rather than a `setTimeout` inside the
   * loop so the route's tests observe the delays it actually slept instead of
   * waiting them out (`main.ts` supplies the real timer).
   */
  readonly sleep: (ms: number) => Promise<void>;
  /** The jitter source, injected for the same reason. Production is `Math.random`. */
  readonly random: () => number;
}

/** Why one attempt failed to store the site — and so what the next one retries. */
type StoreSiteLoss = 'conflict' | 'oldest_gone' | 'counter_index_drift';

/**
 * How the site came to be stored — which is not a detail: an eviction leaves an
 * ex-site's series points behind, and only this outcome knows whose. Exhaustion
 * carries the last loss because it is the one thing that distinguishes "the
 * fleet is busy" from "the counter and the index have genuinely diverged", and
 * the log line is where an operator reads it.
 */
type StoreSiteOutcome =
  | { readonly stored: 'created' }
  | { readonly stored: 'evicted'; readonly evictedSiteId: string }
  | { readonly stored: 'exhausted'; readonly lastOutcome: StoreSiteLoss };

/** One pass at storing the site: a create, and the eviction it may need. */
type StoreSiteAttempt =
  | { readonly stored: 'created' }
  | { readonly stored: 'evicted'; readonly evictedSiteId: string }
  | { readonly stored: 'lost'; readonly loss: StoreSiteLoss };

const attemptStore = async (
  sites: CreateSiteDeps['sites'],
  site: FleetSite,
): Promise<StoreSiteAttempt> => {
  const created = await sites.createUserSiteWithCap(site, MAX_USER_SITES);
  if (created.created) {
    return { stored: 'created' };
  }
  if (created.reason === 'conflict') {
    // A cancelled transaction says nothing about the cap — the fleet may be
    // nowhere near it — so there is nothing to evict and nothing to look up.
    // The next attempt re-issues exactly this create.
    return { stored: 'lost', loss: 'conflict' };
  }

  const oldest = await sites.oldestUserSite();
  if (!oldest.found) {
    // The counter says full and the index offers nothing to evict, so the two
    // disagree: either a concurrent delete is mid-flight, or the counter has
    // drifted above the real user population. Neither is something to fix from
    // a request — a bare decrement here would be the corruption, not the cure —
    // so try the create again and let a concurrent delete's decrement make
    // room. Persistent drift exhausts the attempts and is logged.
    return { stored: 'lost', loss: 'counter_index_drift' };
  }

  const evicted = await sites.evictAndCreateUserSite(oldest.siteId, site);
  return evicted.evicted
    ? { stored: 'evicted', evictedSiteId: oldest.siteId }
    : { stored: 'lost', loss: evicted.reason };
};

/**
 * Attempt {@link attemptStore} until it stores the site or the budget runs out,
 * sleeping the jittered backoff before every retry.
 *
 * The sleep is what makes a retry worth making: re-issuing a conflicted
 * transaction immediately contends with the same winner still committing, and
 * correlated retries from every loser are what turn contention into a herd
 * (`./conflict-retry.ts` carries the curve and the reasoning).
 */
const storeWithinCap = async (deps: CreateSiteDeps, site: FleetSite): Promise<StoreSiteOutcome> => {
  let attempt = await attemptStore(deps.sites, site);

  for (let retry = 1; retry < MAX_STORE_ATTEMPTS && attempt.stored === 'lost'; retry += 1) {
    await deps.sleep(conflictRetryDelayMs(retry, deps.random));
    attempt = await attemptStore(deps.sites, site);
  }

  return attempt.stored === 'lost' ? { stored: 'exhausted', lastOutcome: attempt.loss } : attempt;
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

  const outcome = await storeWithinCap(deps, site);

  if (outcome.stored === 'exhausted') {
    // A 500 rather than a 503: nothing here tells the caller when to come back,
    // and the honest reading is that the fleet lost more races than the number
    // of things that can be racing explains. The log line is the only place
    // that says so — it names the budget that ran out and the loss that kept
    // recurring, which is the pair that separates real contention from a
    // counter and an index that have diverged. The caller gets neither.
    deps.log({
      event: createSiteStoreExhaustedEvent,
      siteId: site.id,
      attempts: MAX_STORE_ATTEMPTS,
      lastOutcome: outcome.lastOutcome,
    });
    return errorResponse('internal', 'the site could not be added');
  }

  if (outcome.stored === 'evicted') {
    await cleanUpSiteSeries(deps, outcome.evictedSiteId);
  }

  return jsonResponse(201, fleetSiteSchema, site);
};
