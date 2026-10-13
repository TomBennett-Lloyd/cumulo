import { utcIsoTimestampSchema, type FleetSite } from '@cumulo/shared';
import type { FleetRollupRow } from '@cumulo/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_LIMITED_REQUESTS_PER_WINDOW } from './abuse/ip-limiter';
import { RANELAGH_ID, fleetSite, forecastPoint, gatewayEvent } from './api-fixtures';
import { STALE_RETRY_SECONDS, dataCycleAt } from './forecast/cycle-cache';
import {
  BRISTOL,
  BRISTOL_SITE,
  DUBLIN,
  RANELAGH,
  partial,
  row,
} from './forecast/fleet-rollup-fixtures';

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
  interface StubOptions {
    readonly sites?: FleetSite[];
    readonly rollupRows?: FleetRollupRow[];
  }
  /** Issued by the 12:07 run, which settles into the 12:15 cycle `MID_CYCLE` sits in. */
  const THIS_RUN = '2026-10-07T12:09:00Z';
  const LAST_RUN = '2026-10-07T11:09:00Z';

  const stubStorage = async (
    issuedAt = THIS_RUN,
    { sites = [fleetSite()], rollupRows = [] }: StubOptions = {},
  ) => {
    const storage = await import('@cumulo/storage');

    const incrementRateWindow = vi
      .spyOn(storage.AbuseAdapter.prototype, 'incrementRateWindow')
      .mockResolvedValue(1);
    const querySeriesRange = vi
      .spyOn(storage.SeriesAdapter.prototype, 'querySeriesRange')
      .mockResolvedValue({ points: [forecastPoint({ issuedAt })], complete: true });
    const queryFleetRollup = vi
      .spyOn(storage.SeriesAdapter.prototype, 'queryFleetRollup')
      .mockResolvedValue({ rows: rollupRows, complete: true });
    const calls = [
      incrementRateWindow,
      vi.spyOn(storage.AbuseAdapter.prototype, 'getBlock').mockResolvedValue({ blocked: false }),
      vi.spyOn(storage.AbuseAdapter.prototype, 'putBlock').mockResolvedValue(undefined),
      vi.spyOn(storage.SiteAdapter.prototype, 'listFleetSites').mockResolvedValue(sites),
      vi
        .spyOn(storage.SiteAdapter.prototype, 'getFleetSite')
        .mockResolvedValue({ found: true, site: fleetSite() }),
      querySeriesRange,
      queryFleetRollup,
    ];

    return { calls, incrementRateWindow, querySeriesRange };
  };

  const seriesEvent = (headers: Record<string, string>): Record<string, unknown> =>
    gatewayEvent({
      rawPath: `/v1/sites/${RANELAGH_ID}/series`,
      queryStringParameters: { from: '2026-10-06T13:00:00Z', to: '2026-10-09T13:00:00Z' },
      headers,
    });

  const fleetForecastEvent = (headers: Record<string, string>): Record<string, unknown> =>
    gatewayEvent({ rawPath: '/v1/fleet/forecast', headers });

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
          vary: 'origin',
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
    expect(response).not.toHaveProperty('dataCycleStart');
    expect(incrementRateWindow).toHaveBeenCalledTimes(1);
  });

  it('serves a late run’s data briefly, under that run’s own cycle tag', async () => {
    await stubStorage(LAST_RUN);
    const { handler } = await import('./main');
    const lastCycle = dataCycleAt(MID_CYCLE.getTime() / 1000 - 3600);

    const response = await handler(seriesEvent({}));

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe(
      `public, max-age=${String(STALE_RETRY_SECONDS)}`,
    );
    expect(response.headers.etag).toBe(lastCycle.etag);
  });

  it('reads again on a stale tag rather than answering 304, and picks up the run that landed', async () => {
    const { incrementRateWindow } = await stubStorage(THIS_RUN);
    const { handler } = await import('./main');
    const lastCycle = dataCycleAt(MID_CYCLE.getTime() / 1000 - 3600);
    const cycle = dataCycleAt(MID_CYCLE.getTime() / 1000);

    const response = await handler(seriesEvent({ 'if-none-match': lastCycle.etag }));

    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBe(cycle.etag);
    expect(response.headers['cache-control']).toBe(
      `public, max-age=${String(cycle.secondsToNext)}`,
    );
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

  describe('on /v1/fleet/forecast', () => {
    const issued = (at: string) => utcIsoTimestampSchema.parse(at);
    const wholeFleetRollup = (...runs: readonly string[]): FleetRollupRow[] =>
      runs.map((at, index) =>
        index === 0
          ? row(DUBLIN, [RANELAGH], partial(), issued(at))
          : row(BRISTOL, [BRISTOL_SITE], partial(), issued(at)),
      );

    it('serves a late roll-up run briefly, under that run’s own cycle tag', async () => {
      const { querySeriesRange } = await stubStorage(THIS_RUN, {
        rollupRows: wholeFleetRollup(LAST_RUN),
      });
      const { handler } = await import('./main');
      const lastCycle = dataCycleAt(MID_CYCLE.getTime() / 1000 - 3600);

      const response = await handler(fleetForecastEvent({}));

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe(
        `public, max-age=${String(STALE_RETRY_SECONDS)}`,
      );
      expect(response.headers.etag).toBe(lastCycle.etag);
      expect(response).not.toHaveProperty('dataCycleStart');
      expect(querySeriesRange).not.toHaveBeenCalled();
    });

    it('caches an on-time roll-up run to the boundary', async () => {
      await stubStorage(LAST_RUN, { rollupRows: wholeFleetRollup(THIS_RUN) });
      const { handler } = await import('./main');
      const cycle = dataCycleAt(MID_CYCLE.getTime() / 1000);

      const response = await handler(fleetForecastEvent({}));

      expect(response.headers['cache-control']).toBe(
        `public, max-age=${String(cycle.secondsToNext)}`,
      );
      expect(response.headers.etag).toBe(cycle.etag);
    });

    it('dates the body by its most-behind location', async () => {
      await stubStorage(THIS_RUN, {
        sites: [fleetSite(), BRISTOL_SITE],
        rollupRows: wholeFleetRollup(THIS_RUN, LAST_RUN),
      });
      const { handler } = await import('./main');
      const lastCycle = dataCycleAt(MID_CYCLE.getTime() / 1000 - 3600);

      const response = await handler(fleetForecastEvent({}));

      expect(response.headers['cache-control']).toBe(
        `public, max-age=${String(STALE_RETRY_SECONDS)}`,
      );
      expect(response.headers.etag).toBe(lastCycle.etag);
    });

    it('is not answered 304 to a stale tag once the run has landed', async () => {
      const { incrementRateWindow } = await stubStorage(LAST_RUN, {
        rollupRows: wholeFleetRollup(THIS_RUN),
      });
      const { handler } = await import('./main');
      const lastCycle = dataCycleAt(MID_CYCLE.getTime() / 1000 - 3600);
      const cycle = dataCycleAt(MID_CYCLE.getTime() / 1000);

      const response = await handler(fleetForecastEvent({ 'if-none-match': lastCycle.etag }));

      expect(response.statusCode).toBe(200);
      expect(response.headers.etag).toBe(cycle.etag);
      expect(incrementRateWindow).toHaveBeenCalledTimes(1);
    });

    it.each([
      {
        run: LAST_RUN,
        outcome: 'briefly, under that run’s tag',
        cacheControl: `public, max-age=${String(STALE_RETRY_SECONDS)}`,
        etag: dataCycleAt(MID_CYCLE.getTime() / 1000 - 3600).etag,
      },
      {
        run: THIS_RUN,
        outcome: 'to the boundary',
        cacheControl: `public, max-age=${String(dataCycleAt(MID_CYCLE.getTime() / 1000).secondsToNext)}`,
        etag: dataCycleAt(MID_CYCLE.getTime() / 1000).etag,
      },
    ])('caches the fallback $outcome, dated by the per-site forecasts', async (expected) => {
      await stubStorage(expected.run);
      const { handler } = await import('./main');

      const response = await handler(fleetForecastEvent({}));

      expect(response.headers['cache-control']).toBe(expected.cacheControl);
      expect(response.headers.etag).toBe(expected.etag);
    });

    it('never dates a body by a slice with no stamp: the read falls back to the per-site forecasts', async () => {
      const unstamped: FleetRollupRow = {
        locationId: DUBLIN,
        provenance: undefined,
        partial: partial(),
      };
      const { querySeriesRange } = await stubStorage(LAST_RUN, { rollupRows: [unstamped] });
      const { handler } = await import('./main');

      const response = await handler(fleetForecastEvent({}));

      expect(querySeriesRange).toHaveBeenCalled();
      expect(response.headers['cache-control']).toBe(
        `public, max-age=${String(STALE_RETRY_SECONDS)}`,
      );
    });
  });
});
