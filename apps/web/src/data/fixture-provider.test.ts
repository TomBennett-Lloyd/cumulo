import {
  canonicalFleetSeed,
  forecastSchema,
  generateFleet,
  generationReadingSchema,
} from '@cumulo/shared';
import { describe, expect, it } from 'vitest';

import { FIXTURE_NOW, fixtureProvider } from './fixture-provider';
import type { DataResult } from './provider';

const sites = generateFleet(canonicalFleetSeed);
const firstSite = sites[0];
if (firstSite === undefined) {
  throw new Error('the canonical fleet is empty — every test below depends on it');
}

/** Unwrap a ready result, failing loudly with the provider's own message when it is not. */
const readyData = <T>(result: DataResult<T>): T => {
  if (result.status === 'failed') {
    throw new Error(`expected a ready result, got: ${result.error}`);
  }
  return result.data;
};

/** 24 h back + the current hour + 24 h forward. */
const hoursInRange24 = 49;

describe('fixtureProvider', () => {
  it('lists the canonical demo fleet', async () => {
    expect(readyData(await fixtureProvider.listSites())).toEqual(sites);
  });

  it('returns byte-identical series for identical calls', async () => {
    const [forecastsA, forecastsB] = await Promise.all([
      fixtureProvider.siteForecasts(firstSite.id, 48),
      fixtureProvider.siteForecasts(firstSite.id, 48),
    ]);
    const [actualsA, actualsB] = await Promise.all([
      fixtureProvider.siteActuals(firstSite.id, 48),
      fixtureProvider.siteActuals(firstSite.id, 48),
    ]);

    expect(forecastsA).toEqual(forecastsB);
    expect(actualsA).toEqual(actualsB);
  });

  it('emits forecasts that satisfy the shared forecast schema', async () => {
    const forecasts = readyData(await fixtureProvider.siteForecasts(firstSite.id, 24));

    expect(forecasts).toHaveLength(hoursInRange24);
    for (const forecast of forecasts) {
      expect(() => forecastSchema.parse(forecast)).not.toThrow();
    }
  });

  it('emits actuals that satisfy the shared generation-reading schema', async () => {
    const actuals = readyData(await fixtureProvider.siteActuals(firstSite.id, 24));

    expect(actuals.length).toBeGreaterThan(0);
    for (const actual of actuals) {
      expect(() => generationReadingSchema.parse(actual)).not.toThrow();
    }
  });

  it('measures nothing later than the pinned fixture now', async () => {
    const actuals = readyData(await fixtureProvider.siteActuals(firstSite.id, 168));

    expect(actuals.every((actual) => actual.validTime <= FIXTURE_NOW)).toBe(true);
  });

  it('brackets every median between its own p10 and p90', async () => {
    const forecasts = readyData(await fixtureProvider.siteForecasts(firstSite.id, 168));

    for (const forecast of forecasts) {
      const band = forecast.uncertainty;
      expect(band).toBeDefined();
      expect(band?.p10AcPowerKw).toBeLessThanOrEqual(forecast.acPowerKw);
      expect(forecast.acPowerKw).toBeLessThanOrEqual(band?.p90AcPowerKw ?? Number.NaN);
    }
  });

  it('covers 24 hours back, now, and the 24-hour horizon at hourly resolution', async () => {
    const forecasts = readyData(await fixtureProvider.siteForecasts(firstSite.id, 24));
    const validTimes = forecasts.map((forecast) => forecast.validTime);

    expect(new Set(validTimes).size).toBe(hoursInRange24);
    expect(validTimes[0]).toBe('2026-07-29T12:00:00Z');
    expect(validTimes.at(-1)).toBe('2026-07-31T12:00:00Z');
    expect(validTimes).toEqual([...validTimes].sort());
  });

  it('widens the band with lead time', async () => {
    // Both endpoints of a 24 h range are solar noon, so the two bands differ only by lead time.
    const forecasts = readyData(await fixtureProvider.siteForecasts(firstSite.id, 24));
    const yesterdayNoon = forecasts[0];
    const tomorrowNoon = forecasts.at(-1);
    const relativeHalfWidth = (forecast: (typeof forecasts)[number] | undefined): number => {
      if (forecast?.uncertainty === undefined) {
        throw new Error('every fixture forecast carries a band');
      }
      return (forecast.uncertainty.p90AcPowerKw - forecast.acPowerKw) / forecast.acPowerKw;
    };

    expect(relativeHalfWidth(yesterdayNoon)).toBeCloseTo(0.2, 2);
    expect(relativeHalfWidth(tomorrowNoon)).toBeCloseTo(0.44, 2);
  });

  it('reports an unknown site id as a failure naming the operation and the id', async () => {
    const result = await fixtureProvider.siteForecasts('not-a-site', 24);

    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.error).toContain('siteForecasts');
    expect(result.status === 'failed' && result.error).toContain('not-a-site');
  });

  it('serves the whole fleet from the fleet-level calls', async () => {
    const forecasts = readyData(await fixtureProvider.fleetForecasts(24));
    const actuals = readyData(await fixtureProvider.fleetActuals(24));

    expect(new Set(forecasts.map((forecast) => forecast.siteId)).size).toBe(sites.length);
    expect(forecasts).toHaveLength(sites.length * hoursInRange24);
    expect(new Set(actuals.map((actual) => actual.siteId)).size).toBe(sites.length);
  });
});
