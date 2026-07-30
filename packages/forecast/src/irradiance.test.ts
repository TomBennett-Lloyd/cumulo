import { describe, expect, it } from 'vitest';

import {
  angleOfIncidence,
  extraterrestrialNormalIrradiance,
  poaIrradiance,
  type PoaIrradianceInput,
} from './irradiance';

/**
 * A mid-morning, clear-sky, south-facing baseline. Individual tests override only the
 * fields whose effect they are proving, so the assertion and the cause stay adjacent.
 */
const baseline: PoaIrradianceInput = {
  ghiWm2: 500,
  dniWm2: 800,
  dhiWm2: 100,
  dniExtraWm2: 1361,
  apparentZenithDeg: 40,
  solarAzimuthDeg: 150,
  tiltDegrees: 35,
  azimuthDegrees: 180,
  albedo: 0.2,
};

const poaWith = (overrides: Partial<PoaIrradianceInput>): PoaIrradianceInput => ({
  ...baseline,
  ...overrides,
});

describe('extraterrestrialNormalIrradiance', () => {
  /**
   * Sanity bounds only — the tight check is the pvlib golden-fixture suite. Values are
   * Spencer's eccentricity correction times the 1366.1 W/m² solar constant: the annual
   * extremes of that series are 1414.019 W/m² at day 3 and 1320.457 W/m² at day 186.
   *
   * The plan quoted 1322 W/m² for the July figure; that is the textbook aphelion value
   * for a 1367 W/m² solar constant, and is unreachable with the 1366.1 W/m² constant
   * pinned by ADR 0003 and used by the fixture generator (the series never exceeds
   * 1320.46 W/m² downwards). The arithmetic value is asserted here instead.
   */
  it('peaks near perihelion in early January', () => {
    expect(extraterrestrialNormalIrradiance(Date.UTC(2026, 0, 3, 12, 0, 0))).toBeCloseTo(1414, 0);
  });

  it('bottoms out near aphelion in early July', () => {
    expect(extraterrestrialNormalIrradiance(Date.UTC(2026, 6, 4, 12, 0, 0))).toBeCloseTo(1320.5, 0);
  });

  it('depends only on the UTC day of the year, not the time of day', () => {
    const morning = extraterrestrialNormalIrradiance(Date.UTC(2026, 3, 15, 6, 0, 0));
    const evening = extraterrestrialNormalIrradiance(Date.UTC(2026, 3, 15, 21, 30, 0));

    expect(morning).toBe(evening);
  });
});

describe('angleOfIncidence', () => {
  /**
   * The worked example of Reda & Andreas, "Solar position algorithm for solar radiation
   * applications" (NREL/TP-560-34302), whose apparent zenith 50.11162° and azimuth
   * 194.34024° give an incidence angle of 25.18700° on a 30°-tilted surface rotated 10°
   * east of south. The paper's azimuth convention differs; 170° here is that same
   * surface expressed clockwise from true north.
   */
  it('reproduces the Reda & Andreas worked example incidence angle', () => {
    const aoiDeg = angleOfIncidence({
      apparentZenithDeg: 50.11162,
      solarAzimuthDeg: 194.34024,
      tiltDegrees: 30,
      azimuthDegrees: 170,
    });

    expect(Math.abs(aoiDeg - 25.187)).toBeLessThanOrEqual(0.01);
  });

  it('exceeds 90 degrees when the sun is behind the plane of the module', () => {
    const aoiDeg = angleOfIncidence({
      apparentZenithDeg: 50,
      solarAzimuthDeg: 180,
      tiltDegrees: 90,
      azimuthDegrees: 0,
    });

    expect(aoiDeg).toBeGreaterThan(90);
  });
});

describe('poaIrradiance', () => {
  it('returns no beam but positive diffuse when the sun is behind the module', () => {
    const geometry = {
      apparentZenithDeg: 50,
      solarAzimuthDeg: 180,
      tiltDegrees: 90,
      azimuthDegrees: 0,
    };
    expect(angleOfIncidence(geometry)).toBeGreaterThan(90);

    const poa = poaIrradiance(poaWith(geometry));

    expect(poa.beamWm2).toBe(0);
    expect(poa.skyDiffuseWm2).toBeGreaterThan(0);
    expect(poa.groundWm2).toBeGreaterThan(0);
    expect(poa.totalWm2).toBe(poa.skyDiffuseWm2 + poa.groundWm2);
  });

  it('returns exactly zero for every component when there is no irradiance at all', () => {
    const darkGeometries: readonly Partial<PoaIrradianceInput>[] = [
      { apparentZenithDeg: 95, solarAzimuthDeg: 300, tiltDegrees: 35, azimuthDegrees: 180 },
      { apparentZenithDeg: 140, solarAzimuthDeg: 10, tiltDegrees: 0, azimuthDegrees: 0 },
      { apparentZenithDeg: 20, solarAzimuthDeg: 180, tiltDegrees: 90, azimuthDegrees: 180 },
    ];

    for (const geometry of darkGeometries) {
      const poa = poaIrradiance(poaWith({ ...geometry, ghiWm2: 0, dniWm2: 0, dhiWm2: 0 }));

      expect(poa.beamWm2).toBe(0);
      expect(poa.skyDiffuseWm2).toBe(0);
      expect(poa.groundWm2).toBe(0);
      expect(poa.totalWm2).toBe(0);
    }
  });

  it('reflects nothing off the ground and reproduces GHI for a horizontal module', () => {
    const apparentZenithDeg = 30;
    const dniWm2 = 800;
    const dhiWm2 = 100;
    const ghiWm2 = dniWm2 * Math.cos((apparentZenithDeg * Math.PI) / 180) + dhiWm2;

    const poa = poaIrradiance(
      poaWith({ apparentZenithDeg, dniWm2, dhiWm2, ghiWm2, tiltDegrees: 0 }),
    );

    expect(poa.groundWm2).toBe(0);
    expect(poa.totalWm2).toBeCloseTo(ghiWm2, 9);
  });

  /**
   * pvlib floors cos(zenith) at 0.01745 (cos 89°) inside the Hay-Davies projection ratio
   * (upstream GH 432), so the circumsolar term is capped at 1/0.01745 ≈ 57.3 times DHI
   * instead of diverging as the sun reaches the horizon.
   */
  it('stays finite and bounded as the sun crosses the horizon', () => {
    const maximumProjectionRatio = 1 / 0.01745;

    for (const apparentZenithDeg of [89.5, 89.9, 90, 90.1, 90.5]) {
      const dhiWm2 = 12;
      const poa = poaIrradiance(
        poaWith({ apparentZenithDeg, dniWm2: 5, dhiWm2, ghiWm2: 10, solarAzimuthDeg: 180 }),
      );

      for (const component of [poa.beamWm2, poa.skyDiffuseWm2, poa.groundWm2, poa.totalWm2]) {
        expect(Number.isFinite(component)).toBe(true);
        expect(component).toBeGreaterThanOrEqual(0);
      }
      expect(poa.skyDiffuseWm2).toBeLessThanOrEqual(dhiWm2 * (1 + maximumProjectionRatio));
    }
  });

  it('is the sum of its three components', () => {
    const poa = poaIrradiance(baseline);

    expect(poa.totalWm2).toBe(poa.beamWm2 + poa.skyDiffuseWm2 + poa.groundWm2);
  });
});
