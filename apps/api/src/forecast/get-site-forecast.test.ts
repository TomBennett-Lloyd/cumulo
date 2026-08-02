import {
  apiErrorSchema,
  openMeteoAttribution,
  siteForecastResponseSchema,
  utcIsoTimestampSchema,
} from '@cumulo/shared';
import type { GetFleetSiteResult, SeriesPoint } from '@cumulo/storage';
import { describe, expect, it } from 'vitest';

import {
  fleetSite,
  forecast,
  forecastPoint,
  generationPoint,
  jsonBodyOf,
  RANELAGH_ID,
  routeRequest,
} from '../api-fixtures';

import { getSiteForecast, type GetSiteForecastDeps } from './get-site-forecast';

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
}

const stub = (siteResult: GetFleetSiteResult, points: readonly SeriesPoint[] = []): Stub => {
  const windows: QueriedWindow[] = [];

  return {
    windows,
    deps: {
      sites: { getFleetSite: () => Promise.resolve(siteResult) },
      series: {
        querySeriesRange: (_siteId, from, to) => {
          windows.push({ from, to });
          return Promise.resolve({ points: [...points], complete: true });
        },
      },
      now: () => NOW,
    },
  };
};

const existingSite: GetFleetSiteResult = { found: true, site: fleetSite() };

const forecastRequest = (query: Record<string, string> = {}) =>
  routeRequest({
    path: `/v1/sites/${RANELAGH_ID}/forecast`,
    params: { siteId: RANELAGH_ID },
    query,
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
