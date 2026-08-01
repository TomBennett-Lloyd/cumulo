import { apiErrorSchema, type FleetSite } from '@cumulo/shared';
import { StorageError, type SeriesCleanupOutcome } from '@cumulo/storage';
import { describe, expect, it } from 'vitest';

import { fleetSite, jsonBodyOf, RANELAGH_ID, routeRequest } from '../api-fixtures';
import { SERIES_CLEANUP_MAX_ITEMS } from '../request-budget';

import { deleteSite, type DeleteSiteDeps } from './delete-site';
import { seriesCleanupFailedEvent, seriesCleanupIncompleteEvent } from './series-cleanup';

/** Which delete an origin should take, recorded so the choice is assertable. */
interface DeleteCalls {
  readonly counted: string[];
  readonly plain: string[];
  readonly cleaned: string[];
  /** The item budget each pass was handed. */
  readonly budgets: number[];
  readonly logged: Record<string, unknown>[];
}

/** What the table holds for the requested id: a site, or nothing at all. */
const NO_SUCH_SITE = 'no-such-site';

/** A cleanup pass that emptied the partition and hit neither of its limits. */
const CLEAN_SWEEP: SeriesCleanupOutcome = {
  deletedCount: 3,
  declinedCount: 0,
  budgetReached: false,
};

interface DeleteScript {
  readonly stored?: FleetSite | typeof NO_SUCH_SITE;
  /** What the delete transaction reports — `false` is a lost race. */
  readonly deleted?: boolean;
  readonly cleanup?: () => Promise<SeriesCleanupOutcome>;
}

const scriptedSite = (script: DeleteScript = {}): { deps: DeleteSiteDeps; calls: DeleteCalls } => {
  const { stored = fleetSite(), deleted = true } = script;
  const calls: DeleteCalls = { counted: [], plain: [], cleaned: [], budgets: [], logged: [] };

  const deps: DeleteSiteDeps = {
    sites: {
      getFleetSite: () =>
        Promise.resolve(stored === NO_SUCH_SITE ? { found: false } : { found: true, site: stored }),
      deleteUserSiteWithCount: (siteId) => {
        calls.counted.push(siteId);
        return Promise.resolve({ deleted });
      },
      deleteFleetSite: (siteId) => {
        calls.plain.push(siteId);
        return Promise.resolve({ deleted });
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
    const { deps, calls } = scriptedSite({ stored: fleetSite({ origin: 'user' }) });

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
    const { deps, calls } = scriptedSite({ stored: fleetSite({ origin: 'user' }), deleted: false });

    const response = await deleteSite(deps, deleteRanelagh);

    expect(response.statusCode).toBe(404);
    expect(apiErrorSchema.parse(jsonBodyOf(response)).code).toBe('not_found');
    // No cleanup either: the site this request would have cleaned up after is
    // the other request's to finish.
    expect(calls.cleaned).toEqual([]);
  });

  it("deletes the site's series points once the row is gone", async () => {
    const { deps, calls } = scriptedSite({ stored: fleetSite({ origin: 'user' }) });

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
