import { apiErrorSchema, type FleetSite } from '@cumulo/shared';
import { StorageError, type SeriesCleanupOutcome } from '@cumulo/storage';
import { describe, expect, it } from 'vitest';

import {
  countdownDeadline,
  fleetSite,
  jsonBodyOf,
  RANELAGH_ID,
  routeRequest,
} from '../api-fixtures';
import { SERIES_CLEANUP_MAX_ITEMS } from '../request-budget';

import {
  deleteSite,
  deleteSiteConflictExhaustedEvent,
  deleteSiteDeadlineEvent,
  type DeleteSiteDeps,
} from './delete-site';
import { seriesCleanupFailedEvent, seriesCleanupIncompleteEvent } from './series-cleanup';

/** Which delete an origin should take, recorded so the choice is assertable. */
interface DeleteCalls {
  readonly counted: string[];
  readonly plain: string[];
  readonly cleaned: string[];
  /** The item budget each pass was handed. */
  readonly budgets: number[];
  readonly logged: Record<string, unknown>[];
  /** Every backoff the route slept, in order: the curve as it actually ran. */
  readonly sleeps: number[];
}

/** What the table holds for the requested id: a site, or nothing at all. */
const NO_SUCH_SITE = 'no-such-site';

/** A cleanup pass that emptied the partition and hit neither of its limits. */
const CLEAN_SWEEP: SeriesCleanupOutcome = {
  deletedCount: 3,
  declinedCount: 0,
  budgetReached: false,
};

/** The site the counted delete is for; the fixture's default origin is seed. */
const userSite = fleetSite({ origin: 'user' });

/** One attempt's answer, in the adapter's own vocabulary. */
type DeleteAnswer = 'deleted' | 'already_gone' | 'conflict';

interface DeleteScript {
  readonly stored?: FleetSite | typeof NO_SUCH_SITE;
  /**
   * One answer per attempt, the last one holding once the script runs out — so
   * a script states only what changes between attempts, and `['conflict']` is
   * the fleet that never stops contending.
   */
  readonly deletes?: readonly DeleteAnswer[];
  readonly cleanup?: () => Promise<SeriesCleanupOutcome>;
  /**
   * Makes the counted delete *reject* rather than answer — the shape a storage
   * failure that is nobody's expected outcome arrives in, as opposed to the
   * three above.
   */
  readonly deleteFailure?: () => Promise<never>;
}

/**
 * The script's answer for this attempt. Deliberately not shared with
 * `create-site-fixtures.ts`'s look-alike (`docs/standards/structure.md` rule 7):
 * the two routes model different contention — a create can lose an eviction
 * race this route has no equivalent of — and are free to diverge.
 */
const answerFor = (answers: readonly DeleteAnswer[], attempt: number): DeleteAnswer =>
  answers[Math.min(attempt, answers.length - 1)] ?? 'deleted';

const scriptedSite = (script: DeleteScript = {}): { deps: DeleteSiteDeps; calls: DeleteCalls } => {
  const { stored = fleetSite(), deletes = ['deleted'] } = script;
  const calls: DeleteCalls = {
    counted: [],
    plain: [],
    cleaned: [],
    budgets: [],
    logged: [],
    sleeps: [],
  };

  const deps: DeleteSiteDeps = {
    sites: {
      getFleetSite: () =>
        Promise.resolve(stored === NO_SUCH_SITE ? { found: false } : { found: true, site: stored }),
      deleteUserSiteWithCount: (siteId) => {
        const answer = answerFor(deletes, calls.counted.length);
        calls.counted.push(siteId);
        if (script.deleteFailure !== undefined) {
          return script.deleteFailure();
        }
        return Promise.resolve(
          answer === 'deleted' ? { deleted: true } : { deleted: false, reason: answer },
        );
      },
      deleteFleetSite: (siteId) => {
        // A plain DeleteItem has no transaction to cancel, so it cannot report a
        // conflict: every answer that is not 'deleted' is the same idempotent
        // "there was nothing there".
        const answer = answerFor(deletes, calls.plain.length);
        calls.plain.push(siteId);
        return Promise.resolve({ deleted: answer === 'deleted' });
      },
    },
    series: {
      deleteSiteSeries: (siteId, maxItems) => {
        calls.cleaned.push(siteId);
        calls.budgets.push(maxItems);
        return script.cleanup?.() ?? Promise.resolve(CLEAN_SWEEP);
      },
    },
    log: (entry) => calls.logged.push(entry),
    // Recorded and resolved rather than actually waited: what a test can prove
    // about a backoff is the sequence of delays, and sleeping them would price
    // the exhaustion case at seconds.
    sleep: (ms) => {
      calls.sleeps.push(ms);
      return Promise.resolve();
    },
    // Full jitter is `floor(random × cap)`, so a fixed 0.5 turns each recorded
    // sleep into exactly half its ceiling — the curve, readable in the numbers.
    random: () => 0.5,
  };

  return { deps, calls };
};

const deleteRanelagh = routeRequest({ method: 'DELETE', params: { siteId: RANELAGH_ID } });

describe('DELETE /v1/sites/{siteId}', () => {
  it('answers 204 with no body when the site was there', async () => {
    const { deps } = scriptedSite();

    const response = await deleteSite(deps, deleteRanelagh);

    expect(response.statusCode).toBe(204);
    expect(response.body).toBeUndefined();
  });

  it('answers 404 when no site has that id, without deleting anything', async () => {
    // A blanket 204 would tell a caller that mistyped an id that it succeeded.
    const { deps, calls } = scriptedSite({ stored: NO_SUCH_SITE });

    const response = await deleteSite(deps, deleteRanelagh);

    expect(response.statusCode).toBe(404);
    expect(apiErrorSchema.parse(jsonBodyOf(response)).code).toBe('not_found');
    expect(calls.counted).toEqual([]);
    expect(calls.plain).toEqual([]);
    expect(calls.cleaned).toEqual([]);
  });

  it('answers 400 for a path id that is not a uuid, without touching the table', async () => {
    const { deps, calls } = scriptedSite();

    const response = await deleteSite(
      deps,
      routeRequest({ method: 'DELETE', params: { siteId: 'not-a-uuid' } }),
    );

    expect(response.statusCode).toBe(400);
    expect(apiErrorSchema.parse(jsonBodyOf(response)).code).toBe('validation_failed');
    expect(calls.counted).toEqual([]);
    expect(calls.plain).toEqual([]);
  });

  it('decrements the user counter when the departing site is user-created', async () => {
    const { deps, calls } = scriptedSite({ stored: userSite });

    await deleteSite(deps, deleteRanelagh);

    expect(calls.counted).toEqual([RANELAGH_ID]);
    expect(calls.plain).toEqual([]);
  });

  it('leaves the user counter alone when the departing site is seed data', async () => {
    // A seed site was never counted, so decrementing for one would raise the
    // effective cap by a site every time an operator pruned the seed fleet.
    const { deps, calls } = scriptedSite({ stored: fleetSite({ origin: 'seed' }) });

    await deleteSite(deps, deleteRanelagh);

    expect(calls.plain).toEqual([RANELAGH_ID]);
    expect(calls.counted).toEqual([]);
  });

  it('answers 404 when a concurrent delete won the race between read and write', async () => {
    const { deps, calls } = scriptedSite({ stored: userSite, deletes: ['already_gone'] });

    const response = await deleteSite(deps, deleteRanelagh);

    expect(response.statusCode).toBe(404);
    expect(apiErrorSchema.parse(jsonBodyOf(response)).code).toBe('not_found');
    // Final, and so not retried: the condition that declined is the site's
    // absence, which no amount of waiting will change.
    expect(calls.counted).toHaveLength(1);
    expect(calls.sleeps).toEqual([]);
    // No cleanup either: the site this request would have cleaned up after is
    // the other request's to finish.
    expect(calls.cleaned).toEqual([]);
  });

  it('retries the counted delete after a conflict and still answers 204', async () => {
    // The delete writes the same counter item every capped create writes (#155),
    // so it loses the same races — and a 404 for one of them would tell a caller
    // its site is gone while the site is still in the fleet.
    const { deps, calls } = scriptedSite({ stored: userSite, deletes: ['conflict', 'deleted'] });

    const response = await deleteSite(deps, deleteRanelagh);

    expect(response.statusCode).toBe(204);
    expect(calls.counted).toEqual([RANELAGH_ID, RANELAGH_ID]);
    // Slept before re-issuing rather than hot-retrying into the same winner.
    expect(calls.sleeps).toEqual([25]);
    expect(calls.cleaned).toEqual([RANELAGH_ID]);
  });

  it('answers 404 when the site went away between conflicted attempts', async () => {
    // The retry is for the conflict only. Once the transaction reports the row
    // itself is gone, the answer is the ordinary 404 and the loop stops.
    const { deps, calls } = scriptedSite({
      stored: userSite,
      deletes: ['conflict', 'already_gone'],
    });

    const response = await deleteSite(deps, deleteRanelagh);

    expect(response.statusCode).toBe(404);
    expect(apiErrorSchema.parse(jsonBodyOf(response)).code).toBe('not_found');
    expect(calls.counted).toHaveLength(2);
    expect(calls.sleeps).toEqual([25]);
    expect(calls.cleaned).toEqual([]);
  });

  it('answers 500 naming the exhausted budget when every delete conflicts', async () => {
    const { deps, calls } = scriptedSite({ stored: userSite, deletes: ['conflict'] });

    const response = await deleteSite(deps, deleteRanelagh);

    expect(response.statusCode).toBe(500);
    expect(apiErrorSchema.parse(jsonBodyOf(response)).code).toBe('internal');
    // One initial attempt plus the nine retries the budget allows.
    expect(calls.counted).toHaveLength(10);
    // The curve, at half of each ceiling: 50, 100, 200, then held at 400.
    expect(calls.sleeps).toEqual([25, 50, 100, 200, 200, 200, 200, 200, 200]);
    // The structured line an operator reads: which budget ran out, and on what.
    expect(calls.logged).toEqual([
      {
        event: deleteSiteConflictExhaustedEvent,
        siteId: RANELAGH_ID,
        retries: 9,
      },
    ]);
    // The row is still there, so its series points are not this request's to
    // delete — a cleanup here would strip a live site's history.
    expect(calls.cleaned).toEqual([]);
  });

  it('answers 500 when the deadline runs out between conflicted attempts', async () => {
    // Two commands of budget against a fleet that never stops contending: the
    // third delete is refused before it is issued, so the request answers in
    // schema instead of being killed at the function timeout. Not a 404 — the
    // site is still there, and nothing was deleted to report.
    const { deps, calls } = scriptedSite({ stored: userSite, deletes: ['conflict'] });

    const response = await deleteSite(
      deps,
      routeRequest({
        method: 'DELETE',
        params: { siteId: RANELAGH_ID },
        deadline: countdownDeadline(2),
      }),
    );

    expect(response.statusCode).toBe(500);
    expect(apiErrorSchema.parse(jsonBodyOf(response)).code).toBe('internal');
    expect(calls.counted).toHaveLength(2);
    expect(calls.logged).toEqual([{ event: deleteSiteDeadlineEvent, siteId: RANELAGH_ID }]);
    // The row is still there, so its points are not this request's to delete.
    expect(calls.cleaned).toEqual([]);
  });

  it('does not issue even the first counted delete without the budget for it', async () => {
    // The gate covers the first attempt, not only the retries — a request that
    // arrives with nothing left starts no transaction at all.
    const { deps, calls } = scriptedSite({ stored: userSite });

    const response = await deleteSite(
      deps,
      routeRequest({
        method: 'DELETE',
        params: { siteId: RANELAGH_ID },
        deadline: countdownDeadline(0),
      }),
    );

    expect(response.statusCode).toBe(500);
    expect(calls.counted).toEqual([]);
    expect(calls.sleeps).toEqual([]);
    expect(calls.logged).toEqual([{ event: deleteSiteDeadlineEvent, siteId: RANELAGH_ID }]);
  });

  it('never retries the seed delete, which has no transaction to conflict', async () => {
    // The negative control on the retry's reach. This is the script that makes
    // the user branch answer 204 on its second attempt; the seed branch has no
    // counter, no transaction and so no race to lose, and takes the first
    // answer as final rather than sleeping over a `DeleteItem`.
    const { deps, calls } = scriptedSite({
      stored: fleetSite({ origin: 'seed' }),
      deletes: ['conflict', 'deleted'],
    });

    const response = await deleteSite(deps, deleteRanelagh);

    expect(response.statusCode).toBe(404);
    expect(calls.plain).toEqual([RANELAGH_ID]);
    expect(calls.counted).toEqual([]);
    expect(calls.sleeps).toEqual([]);
  });

  it('does not retry a StorageError, leaving it for the request boundary', async () => {
    // The other negative control on the loop's reach: an unexpected storage
    // failure is not a lost race, so retrying it would spend ten attempts and up
    // to 2.7 seconds on a call that cannot succeed. It propagates on the first.
    const { deps, calls } = scriptedSite({
      stored: userSite,
      deleteFailure: () =>
        Promise.reject(
          new StorageError(
            { operation: 'deleteUserSiteWithCount', table: 'cumulo-sites-dev' },
            { cause: new Error('throughput exceeded') },
          ),
        ),
    });

    await expect(deleteSite(deps, deleteRanelagh)).rejects.toBeInstanceOf(StorageError);
    expect(calls.counted).toHaveLength(1);
    expect(calls.sleeps).toEqual([]);
  });

  it("deletes the site's series points once the row is gone", async () => {
    const { deps, calls } = scriptedSite({ stored: userSite });

    await deleteSite(deps, deleteRanelagh);

    expect(calls.cleaned).toEqual([RANELAGH_ID]);
  });

  it('hands the cleanup the budget derived from the function timeout', async () => {
    // The handler must not invent its own ceiling: an unbounded pass here is
    // what turns a committed delete into a function timeout.
    const { deps, calls } = scriptedSite();

    await deleteSite(deps, deleteRanelagh);

    expect(calls.budgets).toEqual([SERIES_CLEANUP_MAX_ITEMS]);
  });

  it('still answers 204 when the series cleanup fails, and says so in the log', async () => {
    const { deps, calls } = scriptedSite({
      cleanup: () =>
        Promise.reject(
          new StorageError(
            { operation: 'deleteSiteSeries', table: 'cumulo-series-dev' },
            { cause: new Error('throughput exceeded') },
          ),
        ),
    });

    const response = await deleteSite(deps, deleteRanelagh);

    expect(response.statusCode).toBe(204);
    expect(calls.logged).toEqual([
      {
        event: seriesCleanupFailedEvent,
        siteId: RANELAGH_ID,
        detail:
          "StorageError: storage operation 'deleteSiteSeries' failed on table 'cumulo-series-dev'",
      },
    ]);
  });

  it('reports deletes the table declined rather than treating them as done', async () => {
    const { deps, calls } = scriptedSite({
      cleanup: () => Promise.resolve({ deletedCount: 18, declinedCount: 7, budgetReached: false }),
    });

    const response = await deleteSite(deps, deleteRanelagh);

    expect(response.statusCode).toBe(204);
    expect(calls.logged).toEqual([
      {
        event: seriesCleanupIncompleteEvent,
        siteId: RANELAGH_ID,
        deletedCount: 18,
        declinedCount: 7,
        budgetReached: false,
      },
    ]);
  });

  it('reports a pass that stopped at its item budget with rows still to go', async () => {
    // The common case for an old site: the budget buys one batch, and the rest
    // of the partition is the TTL's job. Silence here would read as "clean".
    const { deps, calls } = scriptedSite({
      cleanup: () => Promise.resolve({ deletedCount: 25, declinedCount: 0, budgetReached: true }),
    });

    const response = await deleteSite(deps, deleteRanelagh);

    expect(response.statusCode).toBe(204);
    expect(calls.logged).toEqual([
      {
        event: seriesCleanupIncompleteEvent,
        siteId: RANELAGH_ID,
        deletedCount: 25,
        declinedCount: 0,
        budgetReached: true,
      },
    ]);
  });

  it('logs nothing when the pass emptied the partition', async () => {
    const { deps, calls } = scriptedSite();

    await deleteSite(deps, deleteRanelagh);

    expect(calls.logged).toEqual([]);
  });
});
