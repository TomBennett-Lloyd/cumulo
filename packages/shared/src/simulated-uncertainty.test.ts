import { describe, expect, it } from 'vitest';

import { forecastSchema, type Forecast, type UncertaintyBand } from './forecast';
import { simulatedUncertaintyBand } from './simulated-uncertainty';

const MILLISECONDS_PER_HOUR = 3_600_000;
const ISSUED_AT = '2026-07-30T06:00:00Z';
const ISSUED_AT_EPOCH_MS = Date.parse(ISSUED_AT);

/** Hour-ending instants derived by arithmetic, not by a clock — `Date` is only the formatter. */
const hoursAfterIssue = (leadHours: number): string =>
  new Date(ISSUED_AT_EPOCH_MS + leadHours * MILLISECONDS_PER_HOUR)
    .toISOString()
    .replace(/\.\d{3}Z$/u, 'Z');

interface ForecastFixture {
  readonly acPowerKw?: number;
  readonly leadHours?: number;
}

const aForecast = ({ acPowerKw = 1, leadHours = 0 }: ForecastFixture = {}): Forecast =>
  forecastSchema.parse({
    siteId: '00000000-0000-4000-8000-000000000001',
    model: 'physics',
    validTime: hoursAfterIssue(leadHours),
    issuedAt: ISSUED_AT,
    weatherSource: 'open-meteo',
    poaIrradianceWm2: 612.4,
    acPowerKw,
  });

const bandWidth = (band: UncertaintyBand): number => band.p90AcPowerKw - band.p10AcPowerKw;

const CLEAR_SKY = 0;
const HALF_COVER = 50;
const OVERCAST = 100;

describe('simulatedUncertaintyBand', () => {
  it('returns the same band every time it is asked about the same forecast hour', () => {
    const forecast = aForecast({ acPowerKw: 3.7, leadHours: 18 });

    expect(simulatedUncertaintyBand(forecast, HALF_COVER)).toStrictEqual(
      simulatedUncertaintyBand(forecast, HALF_COVER),
    );
  });

  it('leaves a zero estimate at a zero-width band, whatever the sky and however far ahead', () => {
    for (const cloudCoverPct of [CLEAR_SKY, HALF_COVER, OVERCAST]) {
      for (const leadHours of [0, 48, 168]) {
        expect(
          simulatedUncertaintyBand(aForecast({ acPowerKw: 0, leadHours }), cloudCoverPct),
        ).toStrictEqual({ p10AcPowerKw: 0, p90AcPowerKw: 0 });
      }
    }
  });

  it('brackets a clear-sky forecast at issue time with the P10–P90 of the simulated actuals', () => {
    // 0.88 and 1.12 are asserted as literals, not derived from SIMULATED_ACTUAL_FACTOR_MIN/MAX: a
    // test that reads the value it is proving moves with it and proves nothing (restatement ledger
    // in `simulated-uncertainty.ts`). This is the calibration claim — the band at the origin is
    // exactly the spread of the actuals it will be scored against.
    expect(simulatedUncertaintyBand(aForecast({ acPowerKw: 1 }), CLEAR_SKY)).toStrictEqual({
      p10AcPowerKw: 0.88,
      p90AcPowerKw: 1.12,
    });
  });

  it('scales the band with the estimate it brackets rather than adding a fixed width', () => {
    expect(simulatedUncertaintyBand(aForecast({ acPowerKw: 4 }), CLEAR_SKY)).toStrictEqual({
      p10AcPowerKw: 3.52,
      p90AcPowerKw: 4.48,
    });
  });

  it('widens under broken cloud, the volatile regime, against both settled skies', () => {
    const forecast = aForecast({ acPowerKw: 2 });

    const broken = bandWidth(simulatedUncertaintyBand(forecast, HALF_COVER));

    expect(broken).toBeGreaterThan(bandWidth(simulatedUncertaintyBand(forecast, CLEAR_SKY)));
    expect(broken).toBeGreaterThan(bandWidth(simulatedUncertaintyBand(forecast, OVERCAST)));
  });

  it('treats clear and overcast alike — both are settled skies, and the parabola is symmetric', () => {
    const forecast = aForecast({ acPowerKw: 2 });

    expect(simulatedUncertaintyBand(forecast, CLEAR_SKY)).toStrictEqual(
      simulatedUncertaintyBand(forecast, OVERCAST),
    );
  });

  it('never narrows as the forecast reaches further ahead', () => {
    const widths = [0, 1, 6, 24, 72, 168, 300].map((leadHours) =>
      bandWidth(simulatedUncertaintyBand(aForecast({ leadHours }), CLEAR_SKY)),
    );

    // Asserted as "already in ascending order" rather than pairwise, so the claim is about the
    // whole sequence and no index access needs a fallback that would weaken it.
    expect(widths).toStrictEqual([...widths].sort((left, right) => left - right));
  });

  it('caps the half-width at half the estimate however far ahead the forecast reaches', () => {
    // The 0.5 cap is pinned through the quantiles it produces on a 10 kW estimate, as a literal
    // for the same reason as the calibration test above.
    expect(
      simulatedUncertaintyBand(aForecast({ acPowerKw: 10, leadHours: 5000 }), HALF_COVER),
    ).toStrictEqual({ p10AcPowerKw: 5, p90AcPowerKw: 15 });
  });

  it('clamps p90 at the residential cap for a site already generating at nameplate', () => {
    // Unclamped this would be 56 kW, which `uncertaintyBandSchema` refuses — so the band the
    // function returns at all is half the assertion.
    expect(simulatedUncertaintyBand(aForecast({ acPowerKw: 50 }), CLEAR_SKY)).toStrictEqual({
      p10AcPowerKw: 44,
      p90AcPowerKw: 50,
    });
  });

  it('treats a hindcast replay’s negative lead as no lead at all', () => {
    expect(simulatedUncertaintyBand(aForecast({ leadHours: -12 }), HALF_COVER)).toStrictEqual(
      simulatedUncertaintyBand(aForecast({ leadHours: 0 }), HALF_COVER),
    );
  });
});
