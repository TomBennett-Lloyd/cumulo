import type { DeleteUserSiteResult, SiteAdapter } from '@cumulo/storage';

import type { RequestDeadline } from '../http/request-deadline';
import { errorResponse, type ApiResponse } from '../http/response';
import type { RouteRequest } from '../http/router';
import { hasBudgetForStorageCommands } from '../request-budget';

import { MAX_CONFLICT_RETRIES, conflictRetryDelayMs } from './conflict-retry';
import { parseSiteIdParam } from './site-id-param';

/**
 * `DELETE /v1/sites/{siteId}` — remove a site from the fleet.
 *
 * 204 when something was deleted, 404 when there was nothing to delete. The
 * adapters can tell the difference, and reporting it costs nothing: a delete
 * that answered 204 unconditionally would tell a client that mistyped an id
 * that it had succeeded.
 *
 * **The site is read before it is deleted**. `origin` decides which delete is
 * correct: a user site is one half of the cap's arithmetic, so it leaves
 * through `deleteUserSiteWithCount` and takes a counter decrement with it in
 * the same transaction; a seed site was never counted, so decrementing for it
 * would quietly raise the effective cap by one per seed site deleted.
 *
 * **The site's series points are left to the TTL** (access pattern X3, ADR
 * 0007): nothing here deletes them, and the row's own deletion is what makes
 * that safe. Every series route resolves the site first and 404s, so from the
 * moment the row goes the points are unreachable — and nothing writes more of
 * them, because ingestion and forecasting only serve fleet-listed sites. What
 * is left is invisible, costs no reads.
 */

/** Emitted when the conflict retries below ran out with the site still there. */
export const deleteSiteConflictExhaustedEvent = 'api.site.delete-conflict-exhausted';

/**
 * Emitted when the invocation ran out of time before a counted delete could be
 * started. Its own event for the same reason the create path's is: exhaustion
 * means contention this route could not win, and this means there was no budget
 * left to try in.
 */
export const deleteSiteDeadlineEvent = 'api.site.delete-deadline-reached';

export interface DeleteSiteDeps {
  readonly sites: Pick<SiteAdapter, 'getFleetSite' | 'deleteFleetSite' | 'deleteUserSiteWithCount'>;
  /** Structured-logging sink (`docs/standards/error-handling.md` rule 4). */
  readonly log: (entry: Record<string, unknown>) => void;
  /**
   * The backoff between contended delete attempts.
   */
  readonly sleep: (ms: number) => Promise<void>;
  /** The jitter source. Production is `Math.random`. */
  readonly random: () => number;
}

const noSuchSite = (): ApiResponse => errorResponse('not_found', 'no site exists with that id');

/** A conflicted delete is the one outcome worth re-issuing — this asks if it is one. */
const lostTheRace = (outcome: DeleteUserSiteResult): boolean =>
  !outcome.deleted && outcome.reason === 'conflict';

/**
 * What became of the row, in one vocabulary both origins answer in.
 *
 * `conflict_exhausted` exists only on the user branch, and it is deliberately
 * not folded into `already_gone`: the site is still there, and saying otherwise
 * would be the 404 that tells a caller its delete succeeded when nothing was
 * deleted.
 */
type SiteDeleteOutcome = 'deleted' | 'already_gone' | 'conflict_exhausted' | 'out_of_time';

/**
 * Issue the counted delete, and re-issue it while contention is all that stands
 * in its way — as long as the invocation has time to start another one.
 *
 * The sleep before each retry is what makes the retry worth making
 * (`./conflict-retry.ts` carries the curve, the budget and the reasoning for
 * both write routes).
 *
 * **Every delete is gated, the first included**, and each check sits
 * immediately before the command rather than before the backoff that precedes
 * it — a budget read taken before a sleep is stale by the length of the sleep,
 * and the question being asked is whether there is time to start the command
 * *now*. A refusal therefore never leaves a delete in flight: the transaction is
 * either not issued or fully awaited.
 */
const deleteUserSiteWithRetries = async (
  deps: DeleteSiteDeps,
  siteId: string,
  deadline: RequestDeadline,
): Promise<SiteDeleteOutcome> => {
  if (!hasBudgetForStorageCommands(deadline.remainingMs(), 1)) {
    return 'out_of_time';
  }
  let outcome: DeleteUserSiteResult = await deps.sites.deleteUserSiteWithCount(siteId);

  for (let retry = 1; retry <= MAX_CONFLICT_RETRIES && lostTheRace(outcome); retry += 1) {
    await deps.sleep(conflictRetryDelayMs(retry, deps.random));
    if (!hasBudgetForStorageCommands(deadline.remainingMs(), 1)) {
      return 'out_of_time';
    }
    outcome = await deps.sites.deleteUserSiteWithCount(siteId);
  }

  if (outcome.deleted) {
    return 'deleted';
  }

  return outcome.reason === 'conflict' ? 'conflict_exhausted' : 'already_gone';
};

const deleteByOrigin = async (
  deps: DeleteSiteDeps,
  origin: 'user' | 'seed',
  siteId: string,
  deadline: RequestDeadline,
): Promise<SiteDeleteOutcome> => {
  if (origin === 'seed') {
    const { deleted } = await deps.sites.deleteFleetSite(siteId);
    return deleted ? 'deleted' : 'already_gone';
  }

  return deleteUserSiteWithRetries(deps, siteId, deadline);
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

  const outcome = await deleteByOrigin(deps, found.site.origin, param.siteId, request.deadline);

  if (outcome === 'out_of_time') {
    // A 500, and emphatically not the 404 `already_gone` gets: the site is
    // still there. The delete was never issued, so the caller's own retry is
    // the right next move.
    deps.log({ event: deleteSiteDeadlineEvent, siteId: param.siteId });
    return errorResponse('internal', 'the site could not be deleted');
  }

  if (outcome === 'conflict_exhausted') {
    // A 500 rather than a 503, matching the create path: nothing here tells the
    // caller when to come back.
    deps.log({
      event: deleteSiteConflictExhaustedEvent,
      siteId: param.siteId,
      retries: MAX_CONFLICT_RETRIES,
    });
    return errorResponse('internal', 'the site could not be deleted');
  }

  if (outcome === 'already_gone') {
    // The read said the site was there and the delete's condition said it was
    // not, so a concurrent delete won between the two.
    return noSuchSite();
  }

  // No body and no content-type: this is the one *resource* response on this
  // API that has nothing to say, and an empty JSON object would be a lie about
  // that.
  return { statusCode: 204, headers: {} };
};
