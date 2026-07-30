import { describe, expect, it } from 'vitest';

import { solarPosition } from './solar-position';

/** Assert an angle is within `toleranceDeg` of its reference, reporting both on failure. */
const expectDegreesWithin = (
  label: string,
  actualDeg: number,
  expectedDeg: number,
  toleranceDeg: number,
): void => {
  expect(
    Math.abs(actualDeg - expectedDeg),
    `${label}: got ${String(actualDeg)}, reference ${String(expectedDeg)}`,
  ).toBeLessThanOrEqual(toleranceDeg);
};

interface SamplePoint {
  readonly name: string;
  readonly latitudeDeg: number;
  readonly longitudeDeg: number;
  readonly timeUtcMs: number;
}

const samplePoints: readonly SamplePoint[] = [
  {
    name: 'Dublin at midsummer noon',
    latitudeDeg: 53.3498,
    longitudeDeg: -6.2603,
    timeUtcMs: Date.UTC(2026, 5, 21, 12, 0, 0),
  },
  {
    name: 'Dublin in the middle of a winter night',
    latitudeDeg: 53.3498,
    longitudeDeg: -6.2603,
    timeUtcMs: Date.UTC(2026, 11, 21, 2, 0, 0),
  },
  {
    name: 'Tromsø-ish polar latitude during the midnight sun',
    latitudeDeg: 68.5,
    longitudeDeg: 18.95,
    timeUtcMs: Date.UTC(2026, 5, 21, 23, 0, 0),
  },
  {
    name: 'Tromsø-ish polar latitude during the polar night',
    latitudeDeg: 68.5,
    longitudeDeg: 18.95,
    timeUtcMs: Date.UTC(2026, 11, 21, 12, 0, 0),
  },
  {
    name: 'Melbourne in the southern-hemisphere summer',
    latitudeDeg: -37.8136,
    longitudeDeg: 144.9631,
    timeUtcMs: Date.UTC(2026, 0, 15, 2, 0, 0),
  },
  {
    name: 'the equator at an equinox, sun near overhead',
    latitudeDeg: 0,
    longitudeDeg: 0,
    timeUtcMs: Date.UTC(2026, 2, 20, 12, 0, 0),
  },
  {
    name: 'the South Pole',
    latitudeDeg: -90,
    longitudeDeg: 0,
    timeUtcMs: Date.UTC(2026, 0, 1, 6, 0, 0),
  },
];

describe('solarPosition', () => {
  it('reproduces the Reda & Andreas worked example within 0.001°', () => {
    // NREL/TP-560-34302 (Reda & Andreas), appendix worked example: 17 October 2003,
    // 12:30:30 local time at UTC−7, observer at 39.742476°N 105.1786°W, 1830.14 m,
    // 820 mbar, 11 °C, ΔT = 67 s. The paper reports topocentric zenith 50.11162° and
    // azimuth 194.34024°.
    //
    // The tolerance is 0.001° because the paper prints five decimals and a faithful
    // SPA port agrees with it to ~1e-4°; it is a real check on the transcription of
    // the coefficient tables, not headroom. ADR 0003 makes widening it review-blocking.
    const position = solarPosition({
      latitudeDeg: 39.742476,
      longitudeDeg: -105.1786,
      timeUtcMs: Date.UTC(2003, 9, 17, 19, 30, 30),
      elevationM: 1830.14,
      pressurePa: 82000,
      temperatureC: 11,
      deltaTSeconds: 67,
    });

    expectDegreesWithin('apparent zenith', position.apparentZenithDeg, 50.11162, 0.001);
    expectDegreesWithin('azimuth', position.azimuthDeg, 194.34024, 0.001);
  });

  describe.each(samplePoints)('at $name', (point) => {
    it('returns a zenith within [0, 180] and an azimuth within [0, 360)', () => {
      const { apparentZenithDeg, azimuthDeg } = solarPosition(point);

      expect(apparentZenithDeg).toBeGreaterThanOrEqual(0);
      expect(apparentZenithDeg).toBeLessThanOrEqual(180);
      expect(azimuthDeg).toBeGreaterThanOrEqual(0);
      expect(azimuthDeg).toBeLessThan(360);
    });
  });

  it('is pure: the same input evaluated twice gives an identical result', () => {
    const input = {
      latitudeDeg: 53.3498,
      longitudeDeg: -6.2603,
      timeUtcMs: Date.UTC(2026, 5, 21, 11, 30, 0),
    };

    expect(solarPosition(input)).toStrictEqual(solarPosition(input));
  });

  it('uses pvlib spa_python defaults when the optional atmosphere arguments are omitted', () => {
    // Defaults are part of the pinned model (ADR 0003: generator and port must be the
    // same named model), so the production default path is the one exercised here.
    const withDefaults = solarPosition({
      latitudeDeg: 53.3498,
      longitudeDeg: -6.2603,
      timeUtcMs: Date.UTC(2026, 5, 21, 11, 30, 0),
    });
    const spelledOut = solarPosition({
      latitudeDeg: 53.3498,
      longitudeDeg: -6.2603,
      timeUtcMs: Date.UTC(2026, 5, 21, 11, 30, 0),
      elevationM: 0,
      pressurePa: 101325,
      temperatureC: 12,
      deltaTSeconds: 67.0,
    });

    expect(withDefaults).toStrictEqual(spelledOut);
  });
});
