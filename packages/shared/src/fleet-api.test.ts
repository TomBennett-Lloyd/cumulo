import { describe, expect, it } from 'vitest';

import { openMeteoAttribution } from './attribution';
import {
  listSitesResponseSchema,
  siteForecastResponseSchema,
  siteSeriesResponseSchema,
} from './fleet-api';

const fleetSite = {
  id: 'e7b8f8a0-3c2d-4e5f-9a1b-2c3d4e5f6a7b',
  name: 'Ranelagh',
  latitude: 53.324,
  longitude: -6.254,
  tiltDegrees: 35,
  azimuthDegrees: 180,
  capacityKw: 4.2,
  origin: 'seed',
  createdAt: '2026-07-30T06:00:00Z',
  active: true,
};

const forecast = {
  siteId: fleetSite.id,
  model: 'physics',
  validTime: '2026-07-30T14:00:00Z',
  issuedAt: '2026-07-30T06:00:00Z',
  weatherSource: 'open-meteo',
  poaIrradianceWm2: 612.4,
  acPowerKw: 2.7,
};

const generationReading = {
  siteId: fleetSite.id,
  validTime: '2026-07-30T14:00:00Z',
  acPowerKw: 2.4,
};

describe('listSitesResponseSchema', () => {
  it('accepts a fleet carried under a named key rather than as a bare array', () => {
    const result = listSitesResponseSchema.safeParse({ sites: [fleetSite] });

    expect(result.success).toBe(true);
  });

  it('accepts an empty fleet — no sites is an answer, not a malformed body', () => {
    expect(listSitesResponseSchema.safeParse({ sites: [] }).success).toBe(true);
  });

  it('rejects a bare array, the shape the wrapper exists to avoid', () => {
    expect(listSitesResponseSchema.safeParse([fleetSite]).success).toBe(false);
  });
});

// The attribution cases are the load-bearing ones. CC BY 4.0 obliges the UI to
// display the Open-Meteo credit wherever it renders weather-derived data, and
// the web app can only render a credit that travels in the payload — so a body
// without one must fail to parse rather than reach a chart silently uncredited.
describe('siteForecastResponseSchema', () => {
  it('accepts forecasts carrying the attribution as a peer of the data it credits', () => {
    const result = siteForecastResponseSchema.safeParse({
      forecasts: [forecast],
      attribution: openMeteoAttribution,
    });

    expect(result.success).toBe(true);
  });

  it('accepts an empty forecasts array — a site awaiting its first cycle is a 200', () => {
    expect(
      siteForecastResponseSchema.safeParse({ forecasts: [], attribution: openMeteoAttribution })
        .success,
    ).toBe(true);
  });

  it('rejects a body missing attribution', () => {
    expect(siteForecastResponseSchema.safeParse({ forecasts: [forecast] }).success).toBe(false);
  });
});

describe('siteSeriesResponseSchema', () => {
  it('accepts forecasts and actuals as two named arrays beside the attribution', () => {
    const result = siteSeriesResponseSchema.safeParse({
      forecasts: [forecast],
      actuals: [generationReading],
      attribution: openMeteoAttribution,
    });

    expect(result.success).toBe(true);
  });

  it('rejects a body missing attribution', () => {
    expect(
      siteSeriesResponseSchema.safeParse({ forecasts: [forecast], actuals: [generationReading] })
        .success,
    ).toBe(false);
  });

  it('rejects a body missing actuals, so the two arrays cannot silently collapse to one', () => {
    expect(
      siteSeriesResponseSchema.safeParse({
        forecasts: [forecast],
        attribution: openMeteoAttribution,
      }).success,
    ).toBe(false);
  });
});
