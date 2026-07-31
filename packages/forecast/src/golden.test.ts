/**
 * The golden-fixture comparison: every committed pvlib reference case is replayed through
 * the full TypeScript chain and held to ADR 0003's tolerances.
 *
 * This is the test the whole port exists to pass. The other test files check that each
 * module behaves sensibly; only this one checks that it agrees with an implementation
 * nobody here wrote, which is what makes a mismatch evidence about our code rather than a
 * restatement of our own assumptions (ADR 0003).
 *
 * Two rules govern how it may be edited, both review-blocking:
 *
 * 1. **Tolerances are ADR 0003's, verbatim, and may not be widened to get green.** If a
 *    value cannot be hit, the port is aligned with pvlib v0.15.2 or the divergence is
 *    recorded explicitly with its reason. A quietly loosened constant is the precise
 *    failure this contract exists to prevent.
 * 2. **Fixture numbers are not editable either.** They are the reference; regeneration is
 *    a deliberate human act run from `tools/pvlib-fixtures/`, never a way to make a test
 *    pass.
 */

import { siteSchema, weatherReadingSchema, type Site, type WeatherReading } from '@cumulo/shared';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { goldenFixtureFileSchema, type GoldenCase } from './golden-fixture';
import { runPhysicsChain } from './physics-forecast';

/**
 * The fixtures are untyped external data until the schema says otherwise: read as text,
 * parsed to `unknown`, then validated (typing rule 3 — a parse where a cast would lie).
 */
const fixtures = goldenFixtureFileSchema.parse(
  JSON.parse(readFileSync(new URL('../fixtures/pvlib-golden.json', import.meta.url), 'utf8')),
);

/**
 * A tolerance from ADR 0003, "absolute-or-relative, whichever is looser": values near zero
 * are not held to impossible relative precision, and midday values are not held to absurd
 * absolute precision. `relative: 0` means the quantity has an absolute bound only.
 */
interface Tolerance {
  /** Absolute bound, in the quantity's own unit. */
  readonly absolute: number;
  /** Relative bound as a fraction of the expected magnitude. */
  readonly relative: number;
}

/** ADR 0003: solar position (zenith, azimuth) and angle of incidence — 0.01° absolute. */
const angleToleranceDeg: Tolerance = { absolute: 0.01, relative: 0 };

/** ADR 0003: POA irradiance components and total — 0.5 W/m² absolute or 0.1 % relative. */
const poaTolerance: Tolerance = { absolute: 0.5, relative: 0.001 };

/** ADR 0003: cell temperature — 0.1 °C absolute. */
const cellTemperatureTolerance: Tolerance = { absolute: 0.1, relative: 0 };

/** ADR 0003: DC and AC power — 0.1 % relative with a 1 W (0.001 kW) absolute floor. */
const powerTolerance: Tolerance = { absolute: 0.001, relative: 0.001 };

const expectWithin = (
  actual: number,
  expected: number,
  tolerance: Tolerance,
  label: string,
): void => {
  const allowed = Math.max(tolerance.absolute, tolerance.relative * Math.abs(expected));

  expect(
    Math.abs(actual - expected),
    `${label}: pvlib ${String(expected)}, port ${String(actual)} — allowed ±${String(allowed)}`,
  ).toBeLessThanOrEqual(allowed);
};

/**
 * The same comparison for quantities where zero is a correctness property rather than a
 * small number: POA components and totals, DC and AC power.
 *
 * ADR 0003 makes the zero cases — sun below the horizon, polar night — exactly zero and
 * explicitly not a tolerance: a small negative or a `NaN` is a bug that a tolerance would
 * hide, and a fleet total is a sum over thousands of night hours. `toBe` compares with
 * `Object.is`, so it rejects `-0` and `NaN` too.
 */
const expectZeroOrWithin = (
  actual: number,
  expected: number,
  tolerance: Tolerance,
  label: string,
): void => {
  if (expected === 0) {
    expect(actual, `${label}: pvlib says exactly zero`).toBe(0);
    return;
  }

  expectWithin(actual, expected, tolerance, label);
};

/**
 * Shortest angular separation between two bearings, degrees in [0, 180].
 *
 * Azimuth is on a circle, so a plain difference is wrong at the wrap: the north-facing
 * southern-hemisphere case sits either side of 0°/360°, where 359.999 and 0.001 are two
 * thousandths of a degree apart, not 359.998.
 */
const angularDistanceDeg = (a: number, b: number): number => {
  const separation = Math.abs(a - b) % 360;

  return Math.min(separation, 360 - separation);
};

/** A fixed identity for the fixture site: the physics never reads either field. */
const FIXTURE_SITE_ID = '3f6b2c8a-1d94-4e57-9b02-8c5a7e14d6f0';

const siteForCase = (goldenCase: GoldenCase): Site =>
  siteSchema.parse({
    id: FIXTURE_SITE_ID,
    name: `Golden fixture ${goldenCase.id}`,
    ...goldenCase.site,
  });

/**
 * The fixture's weather inputs as a `WeatherReading`.
 *
 * Parsing through the real schema rather than assembling a literal is the point: it proves
 * every generated case is an input production would accept, and it is the only way to
 * obtain the branded `validTime`. Two fields the generator does not vary are filled in:
 * `directRadiationWm2`, which the chain never reads (Hay-Davies takes DNI and DHI), and
 * `cloudCoverPct`, which the physics ignores by design.
 */
const weatherForCase = (goldenCase: GoldenCase): WeatherReading =>
  weatherReadingSchema.parse({
    latitude: goldenCase.site.latitude,
    longitude: goldenCase.site.longitude,
    validTime: goldenCase.validTime,
    kind: 'forecast',
    source: 'open-meteo',
    shortwaveRadiationWm2: goldenCase.weather.ghiWm2,
    directRadiationWm2: 0,
    diffuseRadiationWm2: goldenCase.weather.dhiWm2,
    directNormalIrradianceWm2: goldenCase.weather.dniWm2,
    temperature2mC: goldenCase.weather.temperature2mC,
    windSpeed10mMs: goldenCase.weather.windSpeed10mMs,
    cloudCoverPct: 0,
  });

/**
 * The edge cases ADR 0003 requires the fixture set to contain — "required, not suggested".
 *
 * Listed here as well as in the generator on purpose: this is the assertion that a future
 * regeneration cannot quietly drop the hard cases and stay green. A grid of midday
 * mid-latitude hours passes with a badly wrong low-sun transposition.
 */
const REQUIRED_EDGE_CASE_IDS: readonly string[] = [
  'edge-polar-low-sun',
  'edge-midnight-sun',
  // Polar night, every hour of the day: the whole 24 must be exactly zero.
  ...Array.from(
    { length: 24 },
    (_, hour) => `edge-polar-winter-night-h${String(hour).padStart(2, '0')}`,
  ),
  'edge-night-mid-latitude',
  'edge-twilight-diffuse',
  'edge-sun-behind-panel',
  'edge-sunrise-boundary',
  'edge-sunset-boundary',
  'edge-tilt-0',
  'edge-tilt-90-south',
  'edge-tilt-90-north',
  'edge-southern-hemisphere',
  'edge-equator-equinox-noon',
  'edge-clipping',
  'edge-snow-albedo',
  'edge-dst-h01',
  'edge-dst-h02',
  'edge-dst-h11',
  'edge-dst-h12',
];

describe('the golden fixture set', () => {
  it('was generated by the pinned pvlib release the port was transcribed from', () => {
    // A comparison against a different pvlib measures the gap between two libraries, not
    // the fidelity of this port (ADR 0003: generator and port use the same named model).
    expect(fixtures.provenance.pvlibVersion).toBe('0.15.2');
  });

  it('samples the everyday domain densely enough to be evidence', () => {
    expect(fixtures.cases.length).toBeGreaterThanOrEqual(300);
  });

  it('contains every edge case ADR 0003 requires', () => {
    const presentIds = new Set(fixtures.cases.map((goldenCase) => goldenCase.id));

    expect(REQUIRED_EDGE_CASE_IDS.filter((id) => !presentIds.has(id))).toEqual([]);
  });

  it('has an inverter-clipping case whose reference AC power sits exactly at nameplate', () => {
    // The clipping edge case only tests clipping if pvlib's answer is the clipped value;
    // if a regeneration made it a sub-nameplate hour, the case would silently stop biting.
    const clipping = fixtures.cases.find((goldenCase) => goldenCase.id === 'edge-clipping');

    // Not `clipping?.…` on both sides: a missing case would make that pass by comparing
    // `undefined` to `undefined`, which is exactly the silence this test is here to break.
    if (clipping === undefined) {
      throw new Error('the required `edge-clipping` fixture case is missing');
    }

    expect(clipping.expected.acPowerKw).toBe(clipping.site.capacityKw);
  });
});

describe('runPhysicsChain against pvlib golden fixtures', () => {
  it.each(fixtures.cases)(
    'reproduces pvlib within ADR 0003 tolerances for $id',
    (goldenCase: GoldenCase) => {
      const { expected } = goldenCase;

      const chain = runPhysicsChain(siteForCase(goldenCase), weatherForCase(goldenCase), {
        albedo: goldenCase.params.albedo,
      });

      expectWithin(
        chain.solar.apparentZenithDeg,
        expected.apparentZenithDeg,
        angleToleranceDeg,
        'apparent zenith (deg)',
      );
      expectWithin(
        angularDistanceDeg(chain.solar.azimuthDeg, expected.azimuthDeg),
        0,
        angleToleranceDeg,
        `solar azimuth wrap-aware separation (deg, pvlib ${String(expected.azimuthDeg)}, port ${String(chain.solar.azimuthDeg)})`,
      );
      expectWithin(chain.aoiDeg, expected.aoiDeg, angleToleranceDeg, 'angle of incidence (deg)');

      expectZeroOrWithin(chain.poa.beamWm2, expected.poaBeamWm2, poaTolerance, 'POA beam (W/m²)');
      expectZeroOrWithin(
        chain.poa.skyDiffuseWm2,
        expected.poaSkyDiffuseWm2,
        poaTolerance,
        'POA sky diffuse (W/m²)',
      );
      expectZeroOrWithin(
        chain.poa.groundWm2,
        expected.poaGroundWm2,
        poaTolerance,
        'POA ground reflected (W/m²)',
      );
      expectZeroOrWithin(
        chain.poa.totalWm2,
        expected.poaTotalWm2,
        poaTolerance,
        'POA total (W/m²)',
      );

      expectWithin(
        chain.cellTemperatureC,
        expected.cellTemperatureC,
        cellTemperatureTolerance,
        'cell temperature (°C)',
      );

      expectZeroOrWithin(chain.dcPowerKw, expected.dcPowerKw, powerTolerance, 'DC power (kW)');
      expectZeroOrWithin(chain.acPowerKw, expected.acPowerKw, powerTolerance, 'AC power (kW)');
    },
  );
});
