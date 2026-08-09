import { describe, expect, it } from 'vitest';

import { forecastSchema, type Forecast } from './forecast';
import { generationReadingSchema } from './generation-reading';
import { simulatedActualFromForecast } from './simulated-actual';

const MILLISECONDS_PER_HOUR = 3_600_000;
const BASE_EPOCH_MS = Date.parse('2026-07-30T00:00:00Z');

/** Distinct, well-formed site ids without a fixture fleet: index 3 becomes `…-000000000003`. */
const siteIdAt = (index: number): string =>
  `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`;

/** Hour-ending instants derived by arithmetic, not by a clock — `Date` is only the formatter. */
const hourlyTimestamp = (hourOffset: number): string =>
  new Date(BASE_EPOCH_MS + hourOffset * MILLISECONDS_PER_HOUR)
    .toISOString()
    .replace(/\.\d{3}Z$/u, 'Z');

interface ForecastFixture {
  readonly siteId?: string;
  readonly validTime?: string;
  readonly acPowerKw?: number;
}

const aForecast = ({
  siteId = siteIdAt(1),
  validTime = '2026-07-30T14:00:00Z',
  acPowerKw = 1,
}: ForecastFixture = {}): Forecast =>
  forecastSchema.parse({
    siteId,
    model: 'physics',
    validTime,
    issuedAt: '2026-07-30T06:00:00Z',
    weatherSource: 'open-meteo',
    poaIrradianceWm2: 612.4,
    acPowerKw,
  });

/** 20 sites over 12 consecutive hours — 240 distinct `(siteId, validTime)` pairs. */
const SWEEP_SITES = 20;
const SWEEP_HOURS = 12;

const sweepForecasts = (): readonly Forecast[] => {
  const forecasts: Forecast[] = [];
  for (let site = 0; site < SWEEP_SITES; site += 1) {
    for (let hour = 0; hour < SWEEP_HOURS; hour += 1) {
      forecasts.push(
        aForecast({ siteId: siteIdAt(site), validTime: hourlyTimestamp(hour), acPowerKw: 1 }),
      );
    }
  }
  return forecasts;
};

describe('simulatedActualFromForecast', () => {
  it('returns the same reading every time it is asked about the same forecast hour', () => {
    const forecast = aForecast();

    const first = simulatedActualFromForecast(forecast);
    const second = simulatedActualFromForecast(forecast);

    expect(first).toStrictEqual(second);
    // Pinned so a change to the hash, the scramble or the rounding is a failing test rather than
    // a silent re-simulation of every hour the fleet has already published.
    expect(first.acPowerKw).toBe(1.021);
  });

  it('keeps every simulated actual within ±15 % of its forecast', () => {
    // The bounds are asserted as literals, not as SIMULATED_ACTUAL_FACTOR_MIN/MAX: a test that
    // reads the constants it is proving moves with them and proves nothing (restatement ledger
    // in `simulated-actual.ts`).
    for (const forecast of sweepForecasts()) {
      const { acPowerKw } = simulatedActualFromForecast(forecast);

      expect(acPowerKw).toBeGreaterThanOrEqual(0.85);
      expect(acPowerKw).toBeLessThanOrEqual(1.15);
    }
  });

  it('spreads the draw across the sweep rather than clustering at one factor', () => {
    const distinct = new Set(sweepForecasts().map((f) => simulatedActualFromForecast(f).acPowerKw));

    expect(distinct.size).toBeGreaterThan(SWEEP_SITES);
  });

  it('gives two sites different actuals for the same hour, so the fleet is not one curve', () => {
    const validTime = '2026-07-30T14:00:00Z';

    const first = simulatedActualFromForecast(aForecast({ siteId: siteIdAt(1), validTime }));
    const second = simulatedActualFromForecast(aForecast({ siteId: siteIdAt(2), validTime }));

    expect(first.acPowerKw).not.toBe(second.acPowerKw);
  });

  it('leaves a zero forecast at exactly zero — night stays night whatever the draw', () => {
    expect(simulatedActualFromForecast(aForecast({ acPowerKw: 0 })).acPowerKw).toBe(0);
  });

  it('carries the forecast’s site and hour through unchanged', () => {
    const forecast = aForecast({ siteId: siteIdAt(7), validTime: '2026-07-30T09:00:00Z' });

    const actual = simulatedActualFromForecast(forecast);

    expect(actual.siteId).toBe(forecast.siteId);
    expect(actual.validTime).toBe(forecast.validTime);
  });

  it('returns a reading that parses as a generation reading', () => {
    const result = generationReadingSchema.safeParse(
      simulatedActualFromForecast(aForecast({ acPowerKw: 4.2 })),
    );

    expect(result.success).toBe(true);
  });

  it('clamps a forecast at the residential cap to a reading the schema still accepts', () => {
    // The draw can scale upwards, so the cap is reachable from a forecast already sitting on it.
    const result = generationReadingSchema.safeParse(
      simulatedActualFromForecast(aForecast({ acPowerKw: 50 })),
    );

    expect(result.success).toBe(true);
  });
});
