import type { QueryPaginationBound } from '@cumulo/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RANELAGH_ID, fleetSite, gatewayEvent } from './api-fixtures';
import { lambdaContextDeadline } from './http/request-deadline';
import type { Route } from './http/router';

/**
 * The invocation context reaching a handler, which this boundary used to drop
 * on the floor (#165).
 *
 * A second test file over `main.ts` rather than more of `main.test.ts`, which
 * sits at the `max-lines` ceiling: these cases are one story — how long is left
 * before this invocation is killed, and what the routes do with that — and the
 * split follows the story rather than cutting an arbitrary number of lines out
 * of the other file (`docs/standards/structure.md` rule 4).
 *
 * Tested here rather than only in `http/request-deadline.test.ts` because that
 * unit test proves the deadline *reads* the context, and these prove the number
 * survives the trip: through `handleApiEvent`, through the router, onto the
 * `RouteRequest` a handler is given, and — for the last case — all the way into
 * the pagination bound a real route hands the storage adapter. Those are
 * different ways to be wrong, and the trip is the one that was wrong before.
 *
 * Every case gets a fresh module graph via `vi.resetModules()`, because the
 * composition root composes at module scope and runs once per graph.
 */

/** Answers with whatever the deadline the request carries reports. */
const probeRoute = (seen: number[]): Route => ({
  method: 'GET',
  segments: ['v1', 'sites'],
  handle: (request) => {
    seen.push(request.deadline.remainingMs());
    return Promise.resolve({ statusCode: 200, headers: {} });
  },
});

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('CUMULO_ENV', 'test');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('the invocation deadline reaching a handler', () => {
  it('hands the handler the context’s own remaining time', async () => {
    const { handleApiEvent } = await import('./main');
    const seen: number[] = [];
    // 1,234 is a number nothing in this service could compute: it is the
    // context's answer or it is nothing.
    const context = { getRemainingTimeInMillis: () => 1_234 };

    await handleApiEvent(
      { routes: [probeRoute(seen)], log: () => undefined },
      gatewayEvent(),
      lambdaContextDeadline(context, 15_000),
    );

    expect(seen).toEqual([1_234]);
  });

  it('hands the handler a budget countdown when the invocation had no context', async () => {
    const { handleApiEvent } = await import('./main');
    const seen: number[] = [];
    // A direct `aws lambda invoke` passes no context; the clock is injected so
    // the case needs no timers.
    const readings = [1_000, 3_000];
    const now = (): number => readings.shift() ?? 3_000;

    await handleApiEvent(
      { routes: [probeRoute(seen)], log: () => undefined },
      gatewayEvent(),
      lambdaContextDeadline(undefined, 15_000, now),
    );

    expect(seen).toEqual([13_000]);
  });

  it.each([
    { name: 'nearly gone, so no further page may start', remaining: 1_234, permitted: false },
    { name: 'plentiful, so one more may', remaining: 14_321, permitted: true },
  ])(
    'shapes a real route’s pagination bound when the context says time is $name',
    async ({ remaining, permitted }) => {
      // The two probes above stop at the `RouteRequest`; this one follows the
      // number the rest of the way — through `handler`'s own second argument,
      // the one place a Lambda context ever arrives, and the real route table
      // — into the bound `GET …/forecast` hands the adapter. Both remaining
      // times are numbers nothing here could compute and they straddle the
      // budget predicate's threshold, so the bound's answer is the context's
      // and not a constant's.
      const storage = await import('@cumulo/storage');
      vi.spyOn(storage.SiteAdapter.prototype, 'getFleetSite').mockResolvedValue({
        found: true,
        site: fleetSite(),
      });
      const bounds: (QueryPaginationBound | undefined)[] = [];
      vi.spyOn(storage.SeriesAdapter.prototype, 'querySeriesRange').mockImplementation(
        (_siteId, _from, _to, bound) => {
          bounds.push(bound);
          return Promise.resolve({ points: [], complete: true });
        },
      );
      const { handler } = await import('./main');

      const response = await handler(
        gatewayEvent({ method: 'GET', rawPath: `/v1/sites/${RANELAGH_ID}/forecast` }),
        { getRemainingTimeInMillis: () => remaining },
      );

      expect(response.statusCode).toBe(200);
      expect(bounds).toHaveLength(1);
      expect(bounds[0]?.hasBudgetForNextPage()).toBe(permitted);
    },
  );
});
