import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

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

  it('rounds a sub-watt band outward, where rounding to nearest crossed the estimate', () => {
    // The regression this case exists for: the quantiles are published to watt precision and
    // `acPowerKw` is not, so an estimate whose own distance to its quantiles is under half a watt
    // used to get a band rounded onto the wrong side of it — 0.0006 kW came back bracketed by
    // 0.001 and 0.001, with p10 *above* the estimate. Every day's first and last lit hour passes
    // through these magnitudes, so this is production arithmetic rather than a corner.
    expect(simulatedUncertaintyBand(aForecast({ acPowerKw: 0.0006 }), CLEAR_SKY)).toStrictEqual({
      p10AcPowerKw: 0,
      p90AcPowerKw: 0.001,
    });
    expect(simulatedUncertaintyBand(aForecast({ acPowerKw: 0.0022 }), CLEAR_SKY)).toStrictEqual({
      p10AcPowerKw: 0.001,
      p90AcPowerKw: 0.003,
    });
  });

  it('brackets its own estimate at every magnitude, in every sky, at every lead', () => {
    // The powers straddle the half-watt rounding boundary the case above is about, then climb to
    // the residential cap; the skies and leads are the regimes the width model distinguishes.
    // `p90 <= MAX_PLAUSIBLE_RESIDENTIAL_KW` is proved here too, by the band's own parse: a case
    // that overshot the cap would throw rather than return.
    const cases = [0, 0.0004, 0.0006, 0.001, 0.0022, 0.0042, 0.02, 1, 4.437, 49.997, 50].flatMap(
      (acPowerKw) =>
        [CLEAR_SKY, 25, HALF_COVER, 75, OVERCAST].flatMap((cloudCoverPct) =>
          [0, 1, 26, 48, 168].map((leadHours) => ({ acPowerKw, cloudCoverPct, leadHours })),
        ),
    );

    // Reported as the list of cases that failed rather than as an assertion per case, so a
    // regression names the input it broke on instead of leaving a bare `0.001 <= 0.0006`.
    const unbracketed = cases.filter(({ acPowerKw, cloudCoverPct, leadHours }) => {
      const band = simulatedUncertaintyBand(aForecast({ acPowerKw, leadHours }), cloudCoverPct);
      return !(band.p10AcPowerKw <= acPowerKw && acPowerKw <= band.p90AcPowerKw);
    });

    expect(unbracketed).toEqual([]);
  });

  // The two cases below are the only ones in the repo that discriminate the grid snap in
  // `onDecimalGrid`: with the snap removed, every other test here and in `location-forecasts` and
  // the web suites still passes. One case per rounding direction, kept as separate tests so each
  // direction is exercised even when the other is failing, and both at ordinary production
  // magnitudes rather than contrived ones.

  it('floors p10 onto the watt its product missed only by representation error', () => {
    // `1 - halfWidth` is exactly 0.88 at clear sky and zero lead, yet 1.025 * 0.88 * 1000
    // evaluates to 901.9999999999999 rather than 902 — so an unsnapped `Math.floor` would publish
    // 0.901, a watt taken off the band by nothing but the last bit of a product.
    expect(simulatedUncertaintyBand(aForecast({ acPowerKw: 1.025 }), CLEAR_SKY)).toStrictEqual({
      p10AcPowerKw: 0.902,
      p90AcPowerKw: 1.148,
    });
  });

  it('raises p90 onto the watt its product overshot only by representation error', () => {
    // The mirror case, which needs the error to land just *above* a grid point. A lead this long
    // pins the half-width to its ceiling whatever the sky, so the exact p90 is half again the
    // estimate: 15.416 * 1.5 is 23.124, but scales to 23124.000000000004 — an unsnapped
    // `Math.ceil` would publish 23.125, a watt the band has not earned.
    expect(
      simulatedUncertaintyBand(aForecast({ acPowerKw: 15.416, leadHours: 99 }), CLEAR_SKY),
    ).toStrictEqual({ p10AcPowerKw: 7.708, p90AcPowerKw: 23.124 });
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

  it('treats a cover outside 0–100 % as the settled sky nearest to it', () => {
    const forecast = aForecast({ acPowerKw: 2 });

    // `weatherReadingSchema` bounds the reading, but this parameter is a bare number — and an
    // unclamped parabola answers a cover just over 100 with a *narrower* band, which the band's
    // own parse accepts. A quiet wrong answer is the one worth clamping away.
    expect(simulatedUncertaintyBand(forecast, 150)).toStrictEqual(
      simulatedUncertaintyBand(forecast, OVERCAST),
    );
    expect(simulatedUncertaintyBand(forecast, -20)).toStrictEqual(
      simulatedUncertaintyBand(forecast, CLEAR_SKY),
    );
  });

  it('refuses a NaN cover at its own parse rather than returning a quiet band', () => {
    // The clamp absorbs every *finite* cover, but `Math.max(0, NaN)` is `NaN`, which carries
    // through both quantiles. Pinned because the module's note claims this failure is loud, and a
    // claim about how something fails is worth exactly as much as the test under it. Unreachable
    // from the app — `weatherReadingSchema` rejects a `NaN` reading well upstream — so this is
    // the documented edge standing in for a `Number.isFinite` guard, not a path the fleet takes.
    expect(() => simulatedUncertaintyBand(aForecast({ acPowerKw: 1 }), Number.NaN)).toThrow(
      ZodError,
    );
  });

  it('treats a hindcast replay’s negative lead as no lead at all', () => {
    expect(simulatedUncertaintyBand(aForecast({ leadHours: -12 }), HALF_COVER)).toStrictEqual(
      simulatedUncertaintyBand(aForecast({ leadHours: 0 }), HALF_COVER),
    );
  });
});
