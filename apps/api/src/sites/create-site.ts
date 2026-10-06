import {
  createSiteInputSchema,
  fleetSiteSchema,
  MAX_USER_SITES,
  type FleetSite,
  type UtcIsoTimestamp,
} from '@cumulo/shared';
import type { SiteAdapter } from '@cumulo/storage';

import type { RequestDeadline } from '../http/request-deadline';
import { errorResponse, jsonResponse, zodIssueDetails, type ApiResponse } from '../http/response';
import type { RouteRequest } from '../http/router';
import { hasBudgetForStorageCommands } from '../request-budget';

import { MAX_CONFLICT_RETRIES, conflictRetryDelayMs } from './conflict-retry';

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
 */

/** Emitted when the attempts below ran out without the site being stored. */
export const createSiteStoreExhaustedEvent = 'api.site.create-store-exhausted';

/**
 * Emitted when the invocation ran out of time before a command could be started.
 *
 * Distinct from {@link createSiteStoreExhaustedEvent} because the two call for
 * opposite readings: exhaustion says the fleet lost more races than contention
 * explains, and this says the request never got that far — nothing was
 * contended, there was simply no budget left to start the next command in.
 */
export const createSiteDeadlineEvent = 'api.site.create-deadline-reached';

/**
 * The attempts set aside for the one loss that is nobody's lost race: **2**.
 *
 * The `user-sites-by-age` index is eventually consistent, so it can re-serve a
 * site an earlier attempt has already evicted — the eviction is then cancelled
 * by `attribute_exists(siteId)` and an attempt is spent without any request
 * having contended with another.
 */
const INDEX_DRIFT_SLACK = 2;

/**
 * How many times this route may try to store the site before giving up.
 *
 * **Where the number comes from.** The expression below is the derivation, and
 * its adversarial term is `./conflict-retry.ts`'s rather than a second copy:
 * {@link MAX_CONFLICT_RETRIES} is how many rounds of contention a request can
 * lose before its turn comes, and the premise it rests on — how many
 * transactions may be writing the fleet counter at once — is stated there, once.
 * `+ 1` is the attempt that then wins, and {@link INDEX_DRIFT_SLACK} covers the
 * losses that are nobody's race.
 */
const MAX_STORE_ATTEMPTS = MAX_CONFLICT_RETRIES + 1 + INDEX_DRIFT_SLACK;

export interface CreateSiteDeps {
  readonly sites: Pick<
    SiteAdapter,
    'createUserSiteWithCap' | 'oldestUserSite' | 'evictAndCreateUserSite'
  >;
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
 * How the site came to be stored — which is not a detail: `created` and
 * `evicted` record *which* adapter call committed the row, and so which of the
 * two ways past the cap this request took. Exhaustion carries the last loss
 * because it is the one thing that distinguishes "the fleet is busy" from "the
 * counter and the index have genuinely diverged", and the log line is where an
 * operator reads it.
 *
 * Neither storing outcome names the evicted site: nothing after the committed
 * write reads it.
 */
type StoreSiteOutcome =
  | { readonly stored: 'created' }
  | { readonly stored: 'evicted' }
  | { readonly stored: 'exhausted'; readonly lastOutcome: StoreSiteLoss }
  | { readonly stored: 'out_of_time' };

/** One pass at storing the site: a create, and the eviction it may need. */
type StoreSiteAttempt =
  | { readonly stored: 'created' }
  | { readonly stored: 'evicted' }
  | { readonly stored: 'lost'; readonly loss: StoreSiteLoss }
  | { readonly stored: 'out_of_time' };

/**
 * One attempt at storing the site, refusing to *start* a storage command the
 * invocation no longer has time for.
 *
 * **The gate sits only between commands, and that is the whole invariant.** It
 * is asked before `createUserSiteWithCap`, before `oldestUserSite` and before
 * `evictAndCreateUserSite` — never after one has been issued. So a create or an
 * evict transaction that has been sent is always awaited, and its
 * `created`/`evicted` answer always reaches {@link createSite}: the 201, and
 * with it the server-assigned id that is the only place the caller can learn it,
 * can never be lost to the deadline. What the gate can cost is an attempt that
 * had not begun, which costs nobody anything.
 *
 * A refusal is `out_of_time`, and it is terminal rather than a loss: the losses
 * are worth another attempt after a backoff, and time that has run out is worth
 * neither the sleep nor the attempt.
 */
const attemptStore = async (
  sites: CreateSiteDeps['sites'],
  site: FleetSite,
  deadline: RequestDeadline,
): Promise<StoreSiteAttempt> => {
  if (!hasBudgetForStorageCommands(deadline.remainingMs(), 1)) {
    return { stored: 'out_of_time' };
  }
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

  if (!hasBudgetForStorageCommands(deadline.remainingMs(), 1)) {
    return { stored: 'out_of_time' };
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

  if (!hasBudgetForStorageCommands(deadline.remainingMs(), 1)) {
    return { stored: 'out_of_time' };
  }
  const evicted = await sites.evictAndCreateUserSite(oldest.siteId, site);
  return evicted.evicted ? { stored: 'evicted' } : { stored: 'lost', loss: evicted.reason };
};

/**
 * Attempt {@link attemptStore} until it stores the site or the budget runs out,
 * sleeping the jittered backoff before every retry.
 *
 * The sleep is what makes a retry worth making (`./conflict-retry.ts` carries
 * the curve and the reasoning).
 */
const storeWithinCap = async (
  deps: CreateSiteDeps,
  site: FleetSite,
  deadline: RequestDeadline,
): Promise<StoreSiteOutcome> => {
  let attempt = await attemptStore(deps.sites, site, deadline);

  for (let retry = 1; retry < MAX_STORE_ATTEMPTS && attempt.stored === 'lost'; retry += 1) {
    await deps.sleep(conflictRetryDelayMs(retry, deps.random));
    attempt = await attemptStore(deps.sites, site, deadline);
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

  const outcome = await storeWithinCap(deps, site, request.deadline);

  if (outcome.stored === 'out_of_time') {
    // Nothing was written — the gate only ever refuses a command that had not
    // started — so this is a 500 for a create that did not happen, and the log
    // line is what separates it from the exhaustion above: no race was lost
    // here, the invocation simply ran out of time to start another command.
    deps.log({ event: createSiteDeadlineEvent, siteId: site.id });
    return errorResponse('internal', 'the site could not be added');
  }

  if (outcome.stored === 'exhausted') {
    // A 500 rather than a 503: nothing here tells the caller when to come back,
    // and the honest reading is that the fleet lost more races than the number
    // of things that can be racing explains. The log line is the only place
    // that says so.
    deps.log({
      event: createSiteStoreExhaustedEvent,
      siteId: site.id,
      attempts: MAX_STORE_ATTEMPTS,
      lastOutcome: outcome.lastOutcome,
    });
    return errorResponse('internal', 'the site could not be added');
  }

  return jsonResponse(201, fleetSiteSchema, site);
};
