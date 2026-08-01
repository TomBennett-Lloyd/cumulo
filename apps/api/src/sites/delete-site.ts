import type { DeleteUserSiteResult, SeriesAdapter, SiteAdapter } from '@cumulo/storage';

import { errorResponse, type ApiResponse } from '../http/response';
import type { RouteRequest } from '../http/router';

import { MAX_CONFLICT_RETRIES, conflictRetryDelayMs } from './conflict-retry';
import { cleanUpSiteSeries } from './series-cleanup';
import { parseSiteIdParam } from './site-id-param';

/**
 * `DELETE /v1/sites/{siteId}` — remove a site from the fleet.
 *
 * 204 when something was deleted, 404 when there was nothing to delete. The
 * adapters can tell the difference, and reporting it costs nothing: a delete
 * that answered 204 unconditionally would tell a client that mistyped an id
 * that it had succeeded.
 *
 * **The site is read before it is deleted**, which the previous single-shot
 * delete did not need to do. `origin` decides which delete is correct: a user
 * site is one half of the cap's arithmetic, so it leaves through
 * `deleteUserSiteWithCount` and takes a counter decrement with it in the same
 * transaction; a seed site was never counted, so decrementing for it would
 * quietly raise the effective cap by one per seed site deleted. There is no way
 * to pick between them without knowing what kind of site this is.
 *
 * **The site's series points go too** (access pattern X3): `cleanUpSiteSeries`
 * range-deletes them, best-effort, with the 90-day TTL of ADR 0002 as the
 * backstop rather than the plan. It runs after the row is gone, in that order
 * on purpose — every series route looks the site up first and 404s, so from the
 * moment the row goes the points are unreachable, and a cleanup that ran first
 * would be deleting the points of a site that a lost race might leave in place.
 *
 * **Only the counted delete retries.** The user branch writes the fleet counter
 * inside its transaction and so contends with every concurrent capped create
 * (#155); the seed branch is a plain `DeleteItem` on one row, with no counter
 * and no transaction to cancel, so there is no conflict for it to sleep through
 * and it takes the adapter's answer as final.
 */

/** Emitted when the conflict retries below ran out with the site still there. */
export const deleteSiteConflictExhaustedEvent = 'api.site.delete-conflict-exhausted';

export interface DeleteSiteDeps {
  readonly sites: Pick<SiteAdapter, 'getFleetSite' | 'deleteFleetSite' | 'deleteUserSiteWithCount'>;
  readonly series: Pick<SeriesAdapter, 'deleteSiteSeries'>;
  /** Structured-logging sink (`docs/standards/error-handling.md` rule 4). */
  readonly log: (entry: Record<string, unknown>) => void;
  /**
   * The backoff between contended delete attempts. Injected rather than a
   * `setTimeout` in the loop, so this route's tests observe the delays it slept
   * instead of waiting them out (`main.ts` supplies the real timer). Same field
   * names as `CreateSiteDeps`: the two routes retry one shared policy.
   */
  readonly sleep: (ms: number) => Promise<void>;
  /** The jitter source, injected for the same reason. Production is `Math.random`. */
  readonly random: () => number;
}

const noSuchSite = (): ApiResponse => errorResponse('not_found', 'no site exists with that id');

/** A conflicted delete is the one outcome worth re-issuing — this asks if it is one. */
const lostTheRace = (outcome: DeleteUserSiteResult): boolean =>
  !outcome.deleted && outcome.reason === 'conflict';

/**
 * Issue the counted delete, and re-issue it while contention is all that stands
 * in its way.
 *
 * The sleep before each retry is what makes the retry worth making: re-issuing
 * immediately contends with the winner still committing, and uncorrelated
 * losers all retrying at once is how contention becomes a herd
 * (`./conflict-retry.ts` carries the curve, the budget and the reasoning for
 * both write routes).
 */
const deleteUserSiteWithRetries = async (
  deps: DeleteSiteDeps,
  siteId: string,
): Promise<DeleteUserSiteResult> => {
  let outcome = await deps.sites.deleteUserSiteWithCount(siteId);

  for (let retry = 1; retry <= MAX_CONFLICT_RETRIES && lostTheRace(outcome); retry += 1) {
    await deps.sleep(conflictRetryDelayMs(retry, deps.random));
    outcome = await deps.sites.deleteUserSiteWithCount(siteId);
  }

  return outcome;
};

/**
 * What became of the row, in one vocabulary both origins answer in.
 *
 * `conflict_exhausted` exists only on the user branch, and it is deliberately
 * not folded into `already_gone`: the site is still there, and saying otherwise
 * would be the 404 that tells a caller its delete succeeded when nothing was
 * deleted.
 */
type SiteDeleteOutcome = 'deleted' | 'already_gone' | 'conflict_exhausted';

const deleteByOrigin = async (
  deps: DeleteSiteDeps,
  origin: 'user' | 'seed',
  siteId: string,
): Promise<SiteDeleteOutcome> => {
  if (origin === 'seed') {
    const { deleted } = await deps.sites.deleteFleetSite(siteId);
    return deleted ? 'deleted' : 'already_gone';
  }

  const outcome = await deleteUserSiteWithRetries(deps, siteId);
  if (outcome.deleted) {
    return 'deleted';
  }

  return outcome.reason === 'conflict' ? 'conflict_exhausted' : 'already_gone';
};

export const deleteSite = async (
  deps: DeleteSiteDeps,
  request: RouteRequest,
): Promise<ApiResponse> => {
  const param = parseSiteIdParam(request.params);
  if (!param.valid) {
    return param.response;
  }

  const found = await deps.sites.getFleetSite(param.siteId);
  if (!found.found) {
    return noSuchSite();
  }

  const outcome = await deleteByOrigin(deps, found.site.origin, param.siteId);

  if (outcome === 'conflict_exhausted') {
    // A 500 rather than a 503, matching the create path: nothing here tells the
    // caller when to come back, and the honest reading is that this request lost
    // more races than the number of things that can be racing explains. The log
    // line is the only place that says so — the caller gets a generic message,
    // and the site is still in the fleet for it to try again on.
    deps.log({
      event: deleteSiteConflictExhaustedEvent,
      siteId: param.siteId,
      retries: MAX_CONFLICT_RETRIES,
    });
    return errorResponse('internal', 'the site could not be deleted');
  }

  if (outcome === 'already_gone') {
    // The read said the site was there and the delete's condition said it was
    // not, so a concurrent delete won between the two. That request answered
    // 204 and this one is a delete of nothing — the same 404 a mistyped id
    // gets, and emphatically not a decrement, which the transaction has
    // already declined to make.
    return noSuchSite();
  }

  await cleanUpSiteSeries(deps, param.siteId);

  // No body and no content-type: 204 is the one response on this API that has
  // nothing to say, and an empty JSON object would be a lie about that.
  return { statusCode: 204, headers: {} };
};
