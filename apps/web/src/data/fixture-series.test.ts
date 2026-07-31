import {
  canonicalFleetSeed,
  forecastSchema,
  generateFleet,
  generationReadingSchema,
} from '@cumulo/shared';
import { describe, expect, it } from 'vitest';

import { fixtureActuals, fixtureForecasts, FIXTURE_NOW } from './fixture-series';

const sites = generateFleet(canonicalFleetSeed);
const firstSite = sites[0];
if (firstSite === undefined) {
  throw new Error('the canonical fleet is empty — every test below depends on it');
}

/** 24 h back + the current hour + 24 h forward. */
const hoursInRange24 = 49;

describe('fixtureForecasts', () => {
  it('returns byte-identical series for identical calls', () => {
    expect(fixtureForecasts(firstSite, 0, 48)).toEqual(fixtureForecasts(firstSite, 0, 48));
  });

  it('emits forecasts that satisfy the shared forecast schema', () => {
    const forecasts = fixtureForecasts(firstSite, 0, 24);

    expect(forecasts).toHaveLength(hoursInRange24);
    for (const forecast of forecasts) {
      expect(() => forecastSchema.parse(forecast)).not.toThrow();
    }
  });

  it('brackets every median between its own p10 and p90', () => {
    for (const forecast of fixtureForecasts(firstSite, 0, 168)) {
      const band = forecast.uncertainty;
      expect(band).toBeDefined();
      expect(band?.p10AcPowerKw).toBeLessThanOrEqual(forecast.acPowerKw);
      expect(forecast.acPowerKw).toBeLessThanOrEqual(band?.p90AcPowerKw ?? Number.NaN);
    }
  });

  it('covers 24 hours back, now, and the 24-hour horizon at hourly resolution', () => {
    const validTimes = fixtureForecasts(firstSite, 0, 24).map((forecast) => forecast.validTime);

    expect(new Set(validTimes).size).toBe(hoursInRange24);
    expect(validTimes[0]).toBe('2026-07-29T12:00:00Z');
    expect(validTimes.at(-1)).toBe('2026-07-31T12:00:00Z');
    expect(validTimes).toEqual([...validTimes].sort());
  });

  it('widens the band with lead time', () => {
    // Both endpoints of a 24 h range are solar noon, so the two bands differ only by lead time.
    const forecasts = fixtureForecasts(firstSite, 0, 24);
    const relativeHalfWidth = (forecast: (typeof forecasts)[number] | undefined): number => {
      if (forecast?.uncertainty === undefined) {
        throw new Error('every fixture forecast carries a band');
      }
      return (forecast.uncertainty.p90AcPowerKw - forecast.acPowerKw) / forecast.acPowerKw;
    };

    expect(relativeHalfWidth(forecasts[0])).toBeCloseTo(0.2, 2);
    expect(relativeHalfWidth(forecasts.at(-1))).toBeCloseTo(0.44, 2);
  });

  /**
   * The index is what keys the weather, so two sites with the same hardware still get different
   * days. Passing the same site under two indices isolates that from every other input.
   */
  it('gives the same site different weather at a different fleet position', () => {
    expect(fixtureForecasts(firstSite, 0, 24)).not.toEqual(fixtureForecasts(firstSite, 1, 24));
  });
});

describe('fixtureActuals', () => {
  it('returns byte-identical series for identical calls', () => {
    expect(fixtureActuals(firstSite, 0, 48)).toEqual(fixtureActuals(firstSite, 0, 48));
  });

  it('emits actuals that satisfy the shared generation-reading schema', () => {
    const actuals = fixtureActuals(firstSite, 0, 24);

    expect(actuals.length).toBeGreaterThan(0);
    for (const actual of actuals) {
      expect(() => generationReadingSchema.parse(actual)).not.toThrow();
    }
  });

  it('measures nothing later than the pinned fixture now', () => {
    const actuals = fixtureActuals(firstSite, 0, 168);

    expect(actuals.every((actual) => actual.validTime <= FIXTURE_NOW)).toBe(true);
    expect(actuals.at(-1)?.validTime).toBe(FIXTURE_NOW);
  });
});
