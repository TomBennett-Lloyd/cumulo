import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_LIMITED_REQUESTS_PER_WINDOW } from './abuse/ip-limiter';
import { RANELAGH_ID, fleetSite, forecastPoint, gatewayEvent } from './api-fixtures';
import { dataCycleAt } from './forecast/cycle-cache';

/**
 * A third test file over `main.ts`, beside `main-deadline.test.ts`, because
 * `main.test.ts` sits at the `max-lines` ceiling. Every case gets a fresh module
 * graph: the composition root composes at module scope.
 */

beforeEach(() => {
  vi.resetModules();
});

/**
 * The cycle cache sits in front of the limiter on the three metered reads
 * (`forecast/cycle-cache.ts`, #583). The clock is pinned mid-cycle so the tag a
 * case sends and the tag the route computes cannot straddle a boundary.
 */
describe('the cycle cache on the metered reads', () => {
  const MID_CYCLE = new Date('2026-10-07T12:20:00Z');

  const stubStorage = async () => {
    const storage = await import('@cumulo/storage');

    const incrementRateWindow = vi
      .spyOn(storage.AbuseAdapter.prototype, 'incrementRateWindow')
      .mockResolvedValue(1);
    const calls = [
      incrementRateWindow,
      vi.spyOn(storage.AbuseAdapter.prototype, 'getBlock').mockResolvedValue({ blocked: false }),
      vi.spyOn(storage.AbuseAdapter.prototype, 'putBlock').mockResolvedValue(undefined),
      vi.spyOn(storage.SiteAdapter.prototype, 'listFleetSites').mockResolvedValue([fleetSite()]),
      vi
        .spyOn(storage.SiteAdapter.prototype, 'getFleetSite')
        .mockResolvedValue({ found: true, site: fleetSite() }),
      vi
        .spyOn(storage.SeriesAdapter.prototype, 'querySeriesRange')
        .mockResolvedValue({ points: [forecastPoint()], complete: true }),
      vi
        .spyOn(storage.SeriesAdapter.prototype, 'queryFleetRollup')
        .mockResolvedValue({ rows: [], complete: true }),
    ];

    return { calls, incrementRateWindow };
  };

  const seriesEvent = (headers: Record<string, string>): Record<string, unknown> =>
    gatewayEvent({
      rawPath: `/v1/sites/${RANELAGH_ID}/series`,
      queryStringParameters: { from: '2026-10-06T13:00:00Z', to: '2026-10-09T13:00:00Z' },
      headers,
    });

  beforeEach(() => {
    vi.stubEnv('CUMULO_ENV', 'test');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(MID_CYCLE);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([`/v1/sites/${RANELAGH_ID}/series`, '/v1/fleet/actuals', '/v1/fleet/forecast'])(
    'answers %s 304 to this cycle’s tag with no storage command at all',
    async (rawPath) => {
      const { calls } = await stubStorage();
      const { handler } = await import('./main');
      const cycle = dataCycleAt(MID_CYCLE.getTime() / 1000);

      const response = await handler(
        gatewayEvent({ rawPath, headers: { 'if-none-match': cycle.etag } }),
      );

      // Neither the limiter's two reads nor the route's own: a repeat view is free.
      expect(response).toEqual({
        statusCode: 304,
        headers: {
          'cache-control': `public, max-age=${String(cycle.secondsToNext)}`,
          etag: cycle.etag,
        },
      });
      for (const call of calls) {
        expect(call).not.toHaveBeenCalled();
      }
    },
  );

  it('serves a 200 cacheable to the next cycle, counted by the limiter', async () => {
    const { incrementRateWindow } = await stubStorage();
    const { handler } = await import('./main');
    const cycle = dataCycleAt(MID_CYCLE.getTime() / 1000);

    const response = await handler(seriesEvent({}));

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe(
      `public, max-age=${String(cycle.secondsToNext)}`,
    );
    expect(response.headers.etag).toBe(cycle.etag);
    expect(incrementRateWindow).toHaveBeenCalledTimes(1);
  });

  it('counts a revalidation carrying the previous cycle’s tag, and serves it fresh', async () => {
    const { incrementRateWindow } = await stubStorage();
    const { handler } = await import('./main');
    const previous = dataCycleAt(MID_CYCLE.getTime() / 1000 - 3600);

    const response = await handler(seriesEvent({ 'if-none-match': previous.etag }));

    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).not.toBe(previous.etag);
    expect(incrementRateWindow).toHaveBeenCalledTimes(1);
  });

  it('leaves a refusal uncached — a 429 is not this cycle’s data', async () => {
    const { incrementRateWindow } = await stubStorage();
    incrementRateWindow.mockResolvedValue(MAX_LIMITED_REQUESTS_PER_WINDOW + 1);
    const { handler } = await import('./main');

    const response = await handler(seriesEvent({}));

    expect(response.statusCode).toBe(429);
    expect(response.headers['cache-control']).toBeUndefined();
    expect(response.headers.etag).toBeUndefined();
  });
});
