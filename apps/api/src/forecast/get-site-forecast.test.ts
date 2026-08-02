import {
  apiErrorSchema,
  openMeteoAttribution,
  siteForecastResponseSchema,
  utcIsoTimestampSchema,
} from '@cumulo/shared';
import type { GetFleetSiteResult, QueryPaginationBound, SeriesPoint } from '@cumulo/storage';
import { describe, expect, it } from 'vitest';

import {
  countdownDeadline,
  fleetSite,
  forecast,
  forecastPoint,
  fullBudgetDeadline,
  generationPoint,
  jsonBodyOf,
  RANELAGH_ID,
  routeRequest,
} from '../api-fixtures';
import type { RequestDeadline } from '../http/request-deadline';

import {
  forecastReadDeadlineEvent,
  getSiteForecast,
  type GetSiteForecastDeps,
} from './get-site-forecast';

/** The clock every case below runs on, so the expected windows are readable constants. */
const NOW = utcIsoTimestampSchema.parse('2026-07-31T12:00:00Z');

/** The bounds a stubbed `querySeriesRange` was asked for, recorded in call order. */
interface QueriedWindow {
  readonly from: string;
  readonly to: string;
}

interface Stub {
  readonly deps: GetSiteForecastDeps;
  readonly windows: QueriedWindow[];
  readonly logged: Record<string, unknown>[];
  /** The pagination bound each read was given, to ask it what the adapter would. */
  readonly bounds: (QueryPaginationBound | undefined)[];
}

/**
 * `complete` is the adapter's own field rather than a mode flag: it is how a
 * bounded read says it stopped with the horizon unread.
 */
const stub = (
  siteResult: GetFleetSiteResult,
  points: readonly SeriesPoint[] = [],
  complete = true,
): Stub => {
  const windows: QueriedWindow[] = [];
  const logged: Record<string, unknown>[] = [];
  const bounds: (QueryPaginationBound | undefined)[] = [];

  return {
    windows,
    logged,
    bounds,
    deps: {
      sites: { getFleetSite: () => Promise.resolve(siteResult) },
      series: {
        querySeriesRange: (_siteId, from, to, bound) => {
          windows.push({ from, to });
          bounds.push(bound);
          return Promise.resolve({ points: [...points], complete });
        },
      },
      now: () => NOW,
      log: (entry) => logged.push(entry),
    },
  };
};

const existingSite: GetFleetSiteResult = { found: true, site: fleetSite() };

const forecastRequest = (
  query: Record<string, string> = {},
  deadline: RequestDeadline = fullBudgetDeadline,
) =>
  routeRequest({
    path: `/v1/sites/${RANELAGH_ID}/forecast`,
    params: { siteId: RANELAGH_ID },
    query,
    deadline,
  });

describe('GET /v1/sites/{siteId}/forecast', () => {
  it('reads the next 48 hours when no horizon is given', async () => {
    const { deps, windows } = stub(existingSite);

    const response = await getSiteForecast(deps, forecastRequest());

    expect(response.statusCode).toBe(200);
    expect(windows).toEqual([{ from: '2026-07-31T12:00:00Z', to: '2026-08-02T12:00:00Z' }]);
  });

  it.each([
    { hours: '24', to: '2026-08-01T12:00:00Z' },
    { hours: '48', to: '2026-08-02T12:00:00Z' },
    { hours: '168', to: '2026-08-07T12:00:00Z' },
  ])('reads $hours hours ahead when asked for $hours', async ({ hours, to }) => {
    const { deps, windows } = stub(existingSite);

    const response = await getSiteForecast(deps, forecastRequest({ hours }));

    expect(response.statusCode).toBe(200);
    // Fixed-width to the second, with no milliseconds: the bound is used as a
    // sort-key prefix, and `…T12:00:00.000Z` would sort past every real key at
    // that instant and drop the window's last hour.
    expect(windows).toEqual([{ from: '2026-07-31T12:00:00Z', to }]);
  });

  it.each(['12', '0', '', 'twenty-four', '48.0'])(
    'answers 400 for hours=%s, before any read is billed',
    async (hours) => {
      const { deps, windows } = stub(existingSite);

      const response = await getSiteForecast(deps, forecastRequest({ hours }));

      expect(response.statusCode).toBe(400);
      const body = apiErrorSchema.parse(jsonBodyOf(response));
      expect(body.code).toBe('validation_failed');
      expect(body.details?.[0]?.path).toBe('hours');
      expect(windows).toEqual([]);
    },
  );

  it('answers 404 when no site has that id, without reading the series', async () => {
    const { deps, windows } = stub({ found: false });

    const response = await getSiteForecast(deps, forecastRequest());

    expect(response.statusCode).toBe(404);
    expect(apiErrorSchema.parse(jsonBodyOf(response)).code).toBe('not_found');
    expect(windows).toEqual([]);
  });

  it('answers 400 for a path id that is not a uuid', async () => {
    const { deps } = stub(existingSite);

    const response = await getSiteForecast(deps, routeRequest({ params: { siteId: 'nope' } }));

    expect(response.statusCode).toBe(400);
    expect(apiErrorSchema.parse(jsonBodyOf(response)).details?.[0]?.path).toBe('siteId');
  });

  it('answers 200 with an empty array for a site that has no points yet', async () => {
    // The distinction #17's first-forecast poll keys on: 404 means stop, [] means
    // wait. A site created a minute ago is the normal way to reach this.
    const { deps } = stub(existingSite, []);

    const response = await getSiteForecast(deps, forecastRequest());

    expect(response.statusCode).toBe(200);
    expect(siteForecastResponseSchema.parse(jsonBodyOf(response)).forecasts).toEqual([]);
  });

  it('returns the forecasts of the window and drops the interleaved actuals', async () => {
    const physics = forecast({ model: 'physics', validTime: '2026-07-31T13:00:00Z' });
    const ml = forecast({ model: 'ml', validTime: '2026-07-31T13:00:00Z', acPowerKw: 3.1 });
    const { deps } = stub(existingSite, [
      { type: 'forecast', forecast: physics },
      generationPoint({ validTime: '2026-07-31T13:00:00Z' }),
      { type: 'forecast', forecast: ml },
    ]);

    const response = await getSiteForecast(deps, forecastRequest());

    const body = siteForecastResponseSchema.parse(jsonBodyOf(response));
    // Chronological server order survives the split, and both models are kept:
    // the physics/ML comparison is the product, not an implementation detail.
    expect(body.forecasts).toEqual([physics, ml]);
  });

  it('credits Open-Meteo in every 200 body', async () => {
    const { deps } = stub(existingSite, [forecastPoint()]);

    const response = await getSiteForecast(deps, forecastRequest());

    const body = siteForecastResponseSchema.parse(jsonBodyOf(response));
    expect(body.attribution).toEqual(openMeteoAttribution);
    expect(body.attribution.text).toBe('Weather data by Open-Meteo.com');
  });

  it('answers 500 rather than a horizon that quietly stops short', async () => {
    // `complete: false` means the bound stopped pagination with the window
    // unread. Serving those points as a 200 would be read as a forecast of
    // darkness — and by #17's poll as "keep waiting" — so the route refuses.
    const { deps, logged } = stub(existingSite, [forecastPoint()], false);

    const response = await getSiteForecast(deps, forecastRequest());

    expect(response.statusCode).toBe(500);
    expect(apiErrorSchema.parse(jsonBodyOf(response)).code).toBe('internal');
    expect(logged).toEqual([{ event: forecastReadDeadlineEvent, siteId: RANELAGH_ID }]);
  });

  it('serves the 200 unchanged and logs nothing when the horizon was read to its end', async () => {
    const { deps, logged } = stub(existingSite, [forecastPoint()]);

    const response = await getSiteForecast(deps, forecastRequest());

    expect(response.statusCode).toBe(200);
    expect(siteForecastResponseSchema.parse(jsonBodyOf(response)).forecasts).toHaveLength(1);
    expect(logged).toEqual([]);
  });

  it.each([
    { name: 'a request with its whole budget left', deadline: fullBudgetDeadline, permitted: true },
    { name: 'a request whose time is gone', deadline: countdownDeadline(0), permitted: false },
  ])(
    'hands the adapter a pagination bound that answers for $name',
    async ({ deadline, permitted }) => {
      const { deps, bounds } = stub(existingSite);

      await getSiteForecast(deps, forecastRequest({}, deadline));

      expect(bounds).toHaveLength(1);
      expect(bounds[0]?.hasBudgetForNextPage()).toBe(permitted);
    },
  );

  it('refuses to serve a stored point that violates the response contract', async () => {
    // The negative control for `jsonResponse`'s parse. `acPowerKw: 999` is a
    // legal `number` to the compiler and an illegal power to `forecastSchema`
    // (50 kW cap), so this is a row that could exist and a body that must not:
    // the parse throws, the boundary in main.ts answers 500, and no client ever
    // sees a 200 that lies. Without the parse this test would see a 200.
    const { deps } = stub(existingSite, [
      { type: 'forecast', forecast: { ...forecast(), acPowerKw: 999 } },
    ]);

    await expect(getSiteForecast(deps, forecastRequest())).rejects.toThrow();
  });
});
