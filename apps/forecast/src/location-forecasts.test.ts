import { utcIsoTimestampSchema, type Forecast, type UncertaintyBand } from '@cumulo/shared';
import { describe, expect, it } from 'vitest';

import {
  ISSUED_AT,
  RANELAGH_ID,
  RATHMINES_ID,
  nightReading,
  reading,
  sitePhysics,
} from './forecast-fixtures';
import { locationForecasts, type LocationForecastsInput } from './location-forecasts';

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

/**
 * The rows of a completed fan-out, or a failure naming what came back instead. A
 * typed narrowing rather than an assertion: an `implausible-hour` outcome reaching
 * a test that expected rows should read as that outcome, not as a length mismatch.
 */
const rowsOf = (input: LocationForecastsInput): Forecast[] => {
  const outcome = locationForecasts(input);
  if (outcome.status !== 'complete') {
    throw new Error(`expected a complete fan-out, got '${outcome.status}' — ${outcome.detail}`);
  }
  return outcome.forecasts;
};

/**
 * A row's simulated band, or a failure naming the row that had none — the same
 * narrowing shape as `rowsOf`, for the same reason: `uncertainty` is optional on
 * `Forecast`, and a missing band should read as a missing band rather than as an
 * assertion on `undefined`.
 */
const bandOf = (forecast: Forecast | undefined): UncertaintyBand => {
  const band = forecast?.uncertainty;
  if (band === undefined) {
    throw new Error('expected the row to carry a simulated uncertainty band');
  }
  return band;
};

const widthOf = (band: UncertaintyBand): number => band.p90AcPowerKw - band.p10AcPowerKw;

/**
 * The row at `index`, or a failure naming the gap it found instead — the same
 * narrowing shape as `rowsOf` and `bandOf`. `noUncheckedIndexedAccess` makes
 * every indexed read optional, and a fan-out that produced fewer rows than the
 * case asked for should read as that, not as an assertion on `undefined`.
 */
const rowAt = (forecasts: readonly Forecast[], index: number): Forecast => {
  const forecast = forecasts[index];
  if (forecast === undefined) {
    throw new Error(`expected a row at index ${String(index)}, got ${String(forecasts.length)}`);
  }
  return forecast;
};

/**
 * A row's band width as a fraction of the estimate it brackets. The envelope is
 * relative, so this is the quantity comparable across two hours of *different*
 * output — raw width is not, and a wider band on a brighter hour would prove
 * nothing about which weather it was paired with.
 */
const relativeWidthOf = (forecast: Forecast): number =>
  widthOf(bandOf(forecast)) / forecast.acPowerKw;

describe('locationForecasts', () => {
  it('produces nothing for a location with no sites', () => {
    expect(rowsOf({ sites: [], readings: [reading()], issuedAt: ISSUED_AT })).toEqual([]);
  });

  it('produces nothing for a location with no readings', () => {
    expect(rowsOf({ sites: [sitePhysics()], readings: [], issuedAt: ISSUED_AT })).toEqual([]);
  });

  it('produces one row per site per hour', () => {
    const readings = [
      reading({ validTime: '2026-07-31T11:00:00Z' }),
      reading({ validTime: '2026-07-31T12:00:00Z' }),
      reading({ validTime: '2026-07-31T13:00:00Z' }),
    ];

    const forecasts = rowsOf({
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

    const forecasts = rowsOf({
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
    const [nightForecast] = rowsOf({
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
    const [middayForecast] = rowsOf({
      sites: [sitePhysics()],
      readings: [reading()],
      issuedAt: ISSUED_AT,
    });

    expect(middayForecast?.acPowerKw).toBeGreaterThan(0);
    expect(middayForecast?.poaIrradianceWm2).toBeGreaterThan(0);
  });

  it('attaches a simulated uncertainty band to every row', () => {
    // The physics core emits point estimates only; the envelope is composed here,
    // so "every row" is the property that makes the band UI honest downstream.
    const forecasts = rowsOf({
      sites: [sitePhysics(), rathmines],
      readings: [reading(), nightReading()],
      issuedAt: ISSUED_AT,
    });

    expect(forecasts).toHaveLength(4);
    for (const forecast of forecasts) {
      const band = bandOf(forecast);
      expect(band.p10AcPowerKw).toBeLessThanOrEqual(forecast.acPowerKw);
      expect(band.p90AcPowerKw).toBeGreaterThanOrEqual(forecast.acPowerKw);
    }
  });

  it('closes the band to exactly zero width for a night hour', () => {
    // The width is relative to the estimate, so an unlit panel gets no band at
    // all — a ribbon around a flat zero night would be uncertainty about nothing.
    const [nightForecast] = rowsOf({
      sites: [sitePhysics()],
      readings: [nightReading()],
      issuedAt: ISSUED_AT,
    });

    expect(nightForecast?.acPowerKw).toBe(0);
    expect(bandOf(nightForecast)).toEqual({ p10AcPowerKw: 0, p90AcPowerKw: 0 });
  });

  it('widens the band under broken cloud, for the same site-hour a clear sky narrows', () => {
    const at = (cloudCoverPct: number): Forecast | undefined =>
      rowsOf({
        sites: [sitePhysics()],
        readings: [reading({ cloudCoverPct })],
        issuedAt: ISSUED_AT,
      })[0];

    const broken = at(50);
    const clear = at(0);

    // Cloud cover is not a physics input, so both hours share one point estimate
    // and the whole difference below belongs to the envelope.
    expect(broken?.acPowerKw).toBe(clear?.acPowerKw);
    expect(widthOf(bandOf(broken))).toBeGreaterThan(widthOf(bandOf(clear)));
  });

  it('pairs each row with its own hour’s cloud, not the horizon’s first', () => {
    // The seam's actual job, and the one property the cases above cannot see: they
    // vary cloud one *call* at a time, so a fan-out that read the horizon's first
    // reading for every hour would satisfy every one of them. Two lit hours under
    // different skies in a single horizon is what separates the two — the night
    // hour cannot, because a zero estimate closes the band whatever cloud it is
    // handed.
    const forecasts = rowsOf({
      sites: [sitePhysics()],
      readings: [
        reading({ validTime: '2026-07-31T13:00:00Z', cloudCoverPct: 50 }),
        reading({ validTime: '2026-07-31T14:00:00Z', cloudCoverPct: 0 }),
      ],
      issuedAt: ISSUED_AT,
    });
    const brokenHour = rowAt(forecasts, 0);
    const clearHour = rowAt(forecasts, 1);

    // Both hours are lit, so the relative widths below are ratios of real output
    // rather than of zero — the guard that keeps a night hour from passing this.
    expect(brokenHour.acPowerKw).toBeGreaterThan(0);
    expect(clearHour.acPowerKw).toBeGreaterThan(0);
    // The clear hour is the *later* of the two, so lead time is pushing its band
    // the other way: only the pairing can make it the narrower one.
    expect(relativeWidthOf(brokenHour)).toBeGreaterThan(relativeWidthOf(clearHour));
  });

  it('stamps every row with the model, the vintage and the weather provenance', () => {
    const vintage = utcIsoTimestampSchema.parse('2026-07-31T12:34:56Z');

    const forecasts = rowsOf({
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

    const forecasts = rowsOf({
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

    expect(rowsOf({ sites, readings, issuedAt: ISSUED_AT })).toHaveLength(240);
  });

  it('stops at the first implausible hour and reports the site and hour it belongs to', () => {
    // The whole record fails on this outcome (`consume-message.ts`), so stopping is
    // the honest shape: half a horizon written and half reported would leave the two
    // halves of one message on different vintages after the redelivery.
    const outcome = locationForecasts({
      sites: [sitePhysics({ tiltDegrees: 90, azimuthDegrees: 89.47 })],
      readings: [
        reading({ validTime: '2026-07-31T11:00:00Z' }),
        reading({
          validTime: '2026-03-20T07:00:00Z',
          shortwaveRadiationWm2: 1500,
          directRadiationWm2: 1500,
          diffuseRadiationWm2: 1500,
          directNormalIrradianceWm2: 1500,
        }),
      ],
      issuedAt: ISSUED_AT,
    });

    expect(outcome.status).toBe('implausible-hour');
    if (outcome.status !== 'implausible-hour') {
      throw new Error('unreachable: the assertion above already refused every other arm');
    }
    expect(outcome.siteId).toBe(RANELAGH_ID);
    expect(outcome.validTime).toBe('2026-03-20T07:00:00Z');
    expect(outcome.detail).toContain('acPowerKw');
  });
});
