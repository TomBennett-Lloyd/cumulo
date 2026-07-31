import { apiErrorSchema, openMeteoAttribution } from '@cumulo/shared';
import type { GetFleetSiteResult, SeriesPoint } from '@cumulo/storage';
import { describe, expect, it } from 'vitest';

import {
  fleetSite,
  forecast,
  forecastPoint,
  generationPoint,
  generationReading,
  jsonBodyOf,
  RANELAGH_ID,
  routeRequest,
} from '../api-fixtures';

import {
  getSiteSeries,
  MAX_SERIES_SPAN_HOURS,
  siteSeriesResponseSchema,
  type GetSiteSeriesDeps,
} from './get-site-series';

interface Stub {
  readonly deps: GetSiteSeriesDeps;
  /** How many times the series table was read — zero is the assertion that matters. */
  readonly reads: string[];
}

const stub = (siteResult: GetFleetSiteResult, points: readonly SeriesPoint[] = []): Stub => {
  const reads: string[] = [];

  return {
    reads,
    deps: {
      sites: { getFleetSite: () => Promise.resolve(siteResult) },
      series: {
        querySeriesRange: (siteId, from, to) => {
          reads.push(`${siteId} ${from} ${to}`);
          return Promise.resolve([...points]);
        },
      },
    },
  };
};

const existingSite: GetFleetSiteResult = { found: true, site: fleetSite() };

const FROM = '2026-07-30T00:00:00Z';
const TO = '2026-07-31T00:00:00Z';

const seriesRequest = (query: Record<string, string>) =>
  routeRequest({
    path: `/v1/sites/${RANELAGH_ID}/series`,
    params: { siteId: RANELAGH_ID },
    query,
  });

/** The first `details` entry's path, which is how a caller learns which bound was wrong. */
const firstBadPath = (body: unknown): string | undefined =>
  apiErrorSchema.parse(body).details?.[0]?.path;

describe('GET /v1/sites/{siteId}/series', () => {
  it('reads exactly the window the caller asked for', async () => {
    const { deps, reads } = stub(existingSite);

    const response = await getSiteSeries(deps, seriesRequest({ from: FROM, to: TO }));

    expect(response.statusCode).toBe(200);
    expect(reads).toEqual([`${RANELAGH_ID} ${FROM} ${TO}`]);
  });

  it('splits the interleaved points into forecasts and actuals, order preserved', async () => {
    const early = forecast({ validTime: '2026-07-30T01:00:00Z' });
    const late = forecast({ validTime: '2026-07-30T02:00:00Z', acPowerKw: 3.3 });
    const actual = generationReading({ validTime: '2026-07-30T01:00:00Z' });
    const { deps } = stub(existingSite, [
      { type: 'forecast', forecast: early },
      { type: 'generation', reading: actual },
      { type: 'forecast', forecast: late },
    ]);

    const response = await getSiteSeries(deps, seriesRequest({ from: FROM, to: TO }));

    const body = siteSeriesResponseSchema.parse(jsonBodyOf(response));
    expect(body.forecasts).toEqual([early, late]);
    expect(body.actuals).toEqual([actual]);
  });

  it('answers 200 with empty arrays for a window that holds nothing', async () => {
    const { deps } = stub(existingSite, []);

    const response = await getSiteSeries(deps, seriesRequest({ from: FROM, to: TO }));

    expect(response.statusCode).toBe(200);
    const body = siteSeriesResponseSchema.parse(jsonBodyOf(response));
    expect(body.forecasts).toEqual([]);
    expect(body.actuals).toEqual([]);
  });

  it('credits Open-Meteo in every 200 body', async () => {
    const { deps } = stub(existingSite, [forecastPoint(), generationPoint()]);

    const response = await getSiteSeries(deps, seriesRequest({ from: FROM, to: TO }));

    const body = siteSeriesResponseSchema.parse(jsonBodyOf(response));
    expect(body.attribution).toEqual(openMeteoAttribution);
    expect(body.attribution.text).toBe('Weather data by Open-Meteo.com');
  });

  it.each([
    { name: 'from missing', query: { to: TO }, path: 'from' },
    { name: 'to missing', query: { from: FROM }, path: 'to' },
    { name: 'from not a timestamp', query: { from: 'yesterday', to: TO }, path: 'from' },
    // Same instant, wrong shape: milliseconds break the fixed-width ordering the
    // range query stands on, so this API has exactly one accepted spelling.
    {
      name: 'to carries milliseconds',
      query: { from: FROM, to: '2026-07-31T00:00:00.000Z' },
      path: 'to',
    },
  ])('answers 400 when $name, before any read is billed', async ({ query, path }) => {
    const { deps, reads } = stub(existingSite);

    const response = await getSiteSeries(deps, seriesRequest(query));

    expect(response.statusCode).toBe(400);
    expect(firstBadPath(jsonBodyOf(response))).toBe(path);
    expect(reads).toEqual([]);
  });

  it.each([
    { name: 'inverted', from: TO, to: FROM },
    { name: 'empty', from: FROM, to: FROM },
  ])('answers 400 for a $name window, which can only return nothing', async ({ from, to }) => {
    const { deps, reads } = stub(existingSite);

    const response = await getSiteSeries(deps, seriesRequest({ from, to }));

    expect(response.statusCode).toBe(400);
    expect(firstBadPath(jsonBodyOf(response))).toBe('from');
    expect(reads).toEqual([]);
  });

  it('reads a window exactly at the span ceiling', async () => {
    // The boundary from the accepting side, so the ceiling is proved to be
    // inclusive rather than merely "somewhere around 336".
    const { deps, reads } = stub(existingSite);

    const response = await getSiteSeries(
      deps,
      seriesRequest({ from: '2026-07-01T00:00:00Z', to: '2026-07-15T00:00:00Z' }),
    );

    expect(MAX_SERIES_SPAN_HOURS).toBe(336);
    expect(response.statusCode).toBe(200);
    expect(reads).toHaveLength(1);
  });

  it('answers 400 one hour past the span ceiling', async () => {
    const { deps, reads } = stub(existingSite);

    const response = await getSiteSeries(
      deps,
      seriesRequest({ from: '2026-07-01T00:00:00Z', to: '2026-07-15T01:00:00Z' }),
    );

    expect(response.statusCode).toBe(400);
    const body = apiErrorSchema.parse(jsonBodyOf(response));
    expect(body.code).toBe('validation_failed');
    expect(body.details?.[0]?.path).toBe('to');
    expect(body.details?.[0]?.message).toContain('336');
    expect(reads).toEqual([]);
  });

  it('answers 404 when no site has that id, without reading the series', async () => {
    const { deps, reads } = stub({ found: false });

    const response = await getSiteSeries(deps, seriesRequest({ from: FROM, to: TO }));

    expect(response.statusCode).toBe(404);
    expect(apiErrorSchema.parse(jsonBodyOf(response)).code).toBe('not_found');
    expect(reads).toEqual([]);
  });

  it('answers 400 for a path id that is not a uuid', async () => {
    const { deps } = stub(existingSite);

    const response = await getSiteSeries(
      deps,
      routeRequest({ params: { siteId: 'nope' }, query: { from: FROM, to: TO } }),
    );

    expect(response.statusCode).toBe(400);
    expect(firstBadPath(jsonBodyOf(response))).toBe('siteId');
  });

  it('refuses to serve a stored actual that violates the response contract', async () => {
    // The negative control for `jsonResponse`'s parse, on this route's second
    // array. `acPowerKw: -1` type-checks and fails `generationReadingSchema`'s
    // lower bound, so the handler rejects and the boundary answers 500 rather
    // than shipping a 200 the OpenAPI document does not describe.
    const { deps } = stub(existingSite, [
      { type: 'generation', reading: { ...generationReading(), acPowerKw: -1 } },
    ]);

    await expect(getSiteSeries(deps, seriesRequest({ from: FROM, to: TO }))).rejects.toThrow();
  });
});
