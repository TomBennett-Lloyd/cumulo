import { utcIsoTimestampSchema } from '@cumulo/shared';
import { describe, expect, it } from 'vitest';

import {
  ISSUED_AT,
  RANELAGH_ID,
  RATHMINES_ID,
  nightReading,
  reading,
  sitePhysics,
} from './forecast-fixtures';
import { locationForecasts } from './location-forecasts';

/**
 * The pure core, tested densely and cheaply (`docs/standards/testing.md` rule 2).
 * Every case here is a plain input and a plain assertion — no doubles, no clock,
 * because the fan-out has nothing to double.
 *
 * The physics itself is `@cumulo/forecast`'s to prove, against its pvlib golden
 * fixtures. What is proved here is the fan-out: how many rows, for which sites,
 * carrying which provenance.
 */

const rathmines = sitePhysics({ id: RATHMINES_ID, latitude: 53.3201, longitude: -6.2652 });

describe('locationForecasts', () => {
  it('produces nothing for a location with no sites', () => {
    expect(locationForecasts({ sites: [], readings: [reading()], issuedAt: ISSUED_AT })).toEqual(
      [],
    );
  });

  it('produces nothing for a location with no readings', () => {
    expect(
      locationForecasts({ sites: [sitePhysics()], readings: [], issuedAt: ISSUED_AT }),
    ).toEqual([]);
  });

  it('produces one row per site per hour', () => {
    const readings = [
      reading({ validTime: '2026-07-31T11:00:00Z' }),
      reading({ validTime: '2026-07-31T12:00:00Z' }),
      reading({ validTime: '2026-07-31T13:00:00Z' }),
    ];

    const forecasts = locationForecasts({
      sites: [sitePhysics(), rathmines],
      readings,
      issuedAt: ISSUED_AT,
    });

    expect(forecasts).toHaveLength(6);
  });

  it('groups a site’s whole horizon together, in site-major order', () => {
    // Site-major is what keeps a site's rows contiguous in the write batches, and
    // `cumulo-series` partitions by site — so this ordering is a storage property,
    // not a stylistic one.
    const readings = [
      reading({ validTime: '2026-07-31T11:00:00Z' }),
      reading({ validTime: '2026-07-31T12:00:00Z' }),
    ];

    const forecasts = locationForecasts({
      sites: [sitePhysics(), rathmines],
      readings,
      issuedAt: ISSUED_AT,
    });

    expect(forecasts.map((forecast) => forecast.siteId)).toEqual([
      RANELAGH_ID,
      RANELAGH_ID,
      RATHMINES_ID,
      RATHMINES_ID,
    ]);
  });

  it('emits a zero-power row for a night hour rather than omitting it', () => {
    // The read side plots what it finds, so an absent row and a zero row are the
    // difference between a flat night and a hole in the chart.
    const [nightForecast] = locationForecasts({
      sites: [sitePhysics()],
      readings: [nightReading()],
      issuedAt: ISSUED_AT,
    });

    expect(nightForecast?.acPowerKw).toBe(0);
    expect(nightForecast?.poaIrradianceWm2).toBe(0);
    expect(nightForecast?.validTime).toBe('2026-07-31T02:00:00Z');
  });

  it('produces real output for a bright hour, so the zero case above means something', () => {
    // Testing rule 7's shape applied to a fixture rather than a knob: a suite in
    // which every hour returned 0 would pass the night assertion for the wrong
    // reason.
    const [middayForecast] = locationForecasts({
      sites: [sitePhysics()],
      readings: [reading()],
      issuedAt: ISSUED_AT,
    });

    expect(middayForecast?.acPowerKw).toBeGreaterThan(0);
    expect(middayForecast?.poaIrradianceWm2).toBeGreaterThan(0);
  });

  it('stamps every row with the model, the vintage and the weather provenance', () => {
    const vintage = utcIsoTimestampSchema.parse('2026-07-31T12:34:56Z');

    const forecasts = locationForecasts({
      sites: [sitePhysics(), rathmines],
      readings: [reading(), nightReading()],
      issuedAt: vintage,
    });

    expect(forecasts).toHaveLength(4);
    for (const forecast of forecasts) {
      expect(forecast.model).toBe('physics');
      expect(forecast.issuedAt).toBe(vintage);
      // Provenance propagates from the weather so the UI can render the mandatory
      // Open-Meteo credit on forecast displays too.
      expect(forecast.weatherSource).toBe('open-meteo');
    }
  });

  it('carries each hour’s validTime through unchanged', () => {
    const readings = [
      reading({ validTime: '2026-07-31T11:00:00Z' }),
      reading({ validTime: '2026-07-31T12:00:00Z' }),
    ];

    const forecasts = locationForecasts({
      sites: [sitePhysics()],
      readings,
      issuedAt: ISSUED_AT,
    });

    expect(forecasts.map((forecast) => forecast.validTime)).toEqual([
      '2026-07-31T11:00:00Z',
      '2026-07-31T12:00:00Z',
    ]);
  });

  it('scales a canonical five-site location to 240 rows over a 48-hour horizon', () => {
    // The number the handler's budget arithmetic is written against.
    const sites = Array.from({ length: 5 }, (_unused, index) =>
      sitePhysics({ id: `3f1a2b4c-5d6e-4f7a-8b9c-0d1e2f3a4b5${String(index)}` }),
    );
    const readings = Array.from({ length: 48 }, (_unused, hour) =>
      reading({
        validTime: new Date(Date.UTC(2026, 6, 31, hour)).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      }),
    );

    expect(locationForecasts({ sites, readings, issuedAt: ISSUED_AT })).toHaveLength(240);
  });
});
