import { apiErrorSchema, type FleetSite } from '@cumulo/shared';
import { StorageError, type BatchWriteOutcome } from '@cumulo/storage';
import { describe, expect, it } from 'vitest';

import { fleetSite, jsonBodyOf, RANELAGH_ID, routeRequest } from '../api-fixtures';

import { deleteSite, type DeleteSiteDeps } from './delete-site';
import { seriesCleanupFailedEvent, seriesCleanupIncompleteEvent } from './series-cleanup';

/** Which delete an origin should take, recorded so the choice is assertable. */
interface DeleteCalls {
  readonly counted: string[];
  readonly plain: string[];
  readonly cleaned: string[];
  readonly logged: Record<string, unknown>[];
}

/** What the table holds for the requested id: a site, or nothing at all. */
const NO_SUCH_SITE = 'no-such-site';

interface DeleteScript {
  readonly stored?: FleetSite | typeof NO_SUCH_SITE;
  /** What the delete transaction reports — `false` is a lost race. */
  readonly deleted?: boolean;
  readonly cleanup?: () => Promise<BatchWriteOutcome>;
}

const scriptedSite = (script: DeleteScript = {}): { deps: DeleteSiteDeps; calls: DeleteCalls } => {
  const { stored = fleetSite(), deleted = true } = script;
  const calls: DeleteCalls = { counted: [], plain: [], cleaned: [], logged: [] };

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
      deleteSiteSeries: (siteId) => {
        calls.cleaned.push(siteId);
        return script.cleanup?.() ?? Promise.resolve({ status: 'complete' });
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

  it('reports a partly drained cleanup rather than treating it as complete', async () => {
    const { deps, calls } = scriptedSite({
      cleanup: () => Promise.resolve({ status: 'partial', unprocessedCount: 7 }),
    });

    const response = await deleteSite(deps, deleteRanelagh);

    expect(response.statusCode).toBe(204);
    expect(calls.logged).toEqual([
      { event: seriesCleanupIncompleteEvent, siteId: RANELAGH_ID, unprocessedCount: 7 },
    ]);
  });

  it('logs nothing when the cleanup drained fully', async () => {
    const { deps, calls } = scriptedSite();

    await deleteSite(deps, deleteRanelagh);

    expect(calls.logged).toEqual([]);
  });
});
