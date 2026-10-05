import { describe, expect, it } from 'vitest';

import {
  fleetForecastAggregate,
  fleetRollupPartials,
  sumFleetRollupPartials,
  type FleetRollupPartial,
} from './fleet-rollup';
import { forecastSchema } from './forecast';
import type { Forecast, UncertaintyBand } from './forecast';
import * as packageSurface from './index';
import { utcIsoTimestampSchema } from './timestamp';

const noon = '2026-07-30T12:00:00Z';
const onePm = '2026-07-30T13:00:00Z';
const twoPm = '2026-07-30T14:00:00Z';
const issuedAt = '2026-07-30T06:00:00Z';

interface ForecastSpec {
  readonly siteId: string;
  readonly validTime: string;
  readonly acPowerKw: number;
  readonly issuedAt?: string;
  readonly band?: UncertaintyBand;
}

/**
 * Fixtures go through `forecastSchema.parse` — the only cast-free way to obtain the branded
 * timestamps, and a standing check that what these tests sum is a forecast a real producer could
 * have emitted. The same shape `aggregation.test.ts` uses, and deliberately its own copy: these
 * suites are free to diverge in what they need to vary.
 */
const buildForecast = (spec: ForecastSpec): Forecast =>
  forecastSchema.parse({
    siteId: spec.siteId,
    model: 'physics',
    validTime: spec.validTime,
    issuedAt: spec.issuedAt ?? issuedAt,
    weatherSource: 'open-meteo',
    poaIrradianceWm2: 0,
    acPowerKw: spec.acPowerKw,
    ...(spec.band === undefined ? {} : { uncertainty: spec.band }),
  });

const siteA = '11111111-1111-4111-8111-111111111111';
const siteB = '22222222-2222-4222-8222-222222222222';
const siteC = '33333333-3333-4333-8333-333333333333';

const capacities = [
  { id: siteA, capacityKw: 4 },
  { id: siteB, capacityKw: 6 },
  { id: siteC, capacityKw: 10 },
];

describe('fleetRollupPartials', () => {
  it('reports one partial per hour reported, ascending, with the summed band and divisor', () => {
    const partials = fleetRollupPartials(
      [
        buildForecast({ siteId: siteB, validTime: onePm, acPowerKw: 2 }),
        buildForecast({
          siteId: siteA,
          validTime: noon,
          acPowerKw: 3,
          band: { p10AcPowerKw: 2, p90AcPowerKw: 5 },
        }),
        buildForecast({ siteId: siteB, validTime: noon, acPowerKw: 1 }),
      ],
      capacities,
    );

    expect(partials).toEqual([
      {
        validTime: noon,
        acPowerKw: 4,
        // Site B carried no band, so it contributes its point estimate to both edges.
        p10AcPowerKw: 3,
        p90AcPowerKw: 6,
        hasUncertainty: true,
        contributingSiteCount: 2,
        contributingCapacityKw: 10,
      },
      {
        validTime: onePm,
        acPowerKw: 2,
        p10AcPowerKw: 2,
        p90AcPowerKw: 2,
        hasUncertainty: false,
        contributingSiteCount: 1,
        contributingCapacityKw: 6,
      },
    ]);
  });

  it('collapses a redelivered site-hour to the latest issue, so a partial is a Put not an add', () => {
    const partials = fleetRollupPartials(
      [
        buildForecast({ siteId: siteA, validTime: noon, acPowerKw: 3, issuedAt }),
        buildForecast({
          siteId: siteA,
          validTime: noon,
          acPowerKw: 9,
          issuedAt: '2026-07-30T07:00:00Z',
        }),
      ],
      capacities,
    );

    expect(partials).toEqual([
      {
        validTime: noon,
        acPowerKw: 9,
        p10AcPowerKw: 9,
        p90AcPowerKw: 9,
        hasUncertainty: false,
        contributingSiteCount: 1,
        contributingCapacityKw: 4,
      },
    ]);
  });

  it('asserts no capacity it cannot evidence: an unknown site divides by 0, not by a guess', () => {
    const [partial] = fleetRollupPartials(
      [buildForecast({ siteId: siteC, validTime: noon, acPowerKw: 7 })],
      [{ id: siteA, capacityKw: 4 }],
    );

    expect(partial?.contributingCapacityKw).toBe(0);
    expect(partial?.acPowerKw).toBe(7);
  });

  it('yields nothing for a group with no forecasts', () => {
    expect(fleetRollupPartials([], capacities)).toEqual([]);
  });
});

describe('sumFleetRollupPartials', () => {
  /** Parsed rather than cast: `utcIsoTimestampSchema` is the only cast-free way to brand an hour. */
  const partial = (
    spec: Omit<Partial<FleetRollupPartial>, 'validTime'> & { readonly validTime: string },
  ): FleetRollupPartial => ({
    validTime: utcIsoTimestampSchema.parse(spec.validTime),
    acPowerKw: spec.acPowerKw ?? 0,
    p10AcPowerKw: spec.p10AcPowerKw ?? 0,
    p90AcPowerKw: spec.p90AcPowerKw ?? 0,
    hasUncertainty: spec.hasUncertainty ?? false,
    contributingSiteCount: spec.contributingSiteCount ?? 0,
    contributingCapacityKw: spec.contributingCapacityKw ?? 0,
  });

  it('adds partials for the same hour and orders the result chronologically', () => {
    const summed = sumFleetRollupPartials([
      partial({
        validTime: twoPm,
        acPowerKw: 1,
        p10AcPowerKw: 1,
        p90AcPowerKw: 1,
        contributingSiteCount: 1,
        contributingCapacityKw: 4,
      }),
      partial({
        validTime: noon,
        acPowerKw: 3,
        p10AcPowerKw: 2,
        p90AcPowerKw: 5,
        hasUncertainty: true,
        contributingSiteCount: 1,
        contributingCapacityKw: 4,
      }),
      partial({
        validTime: noon,
        acPowerKw: 10,
        p10AcPowerKw: 10,
        p90AcPowerKw: 10,
        contributingSiteCount: 2,
        contributingCapacityKw: 16,
      }),
    ]);

    expect(summed).toEqual([
      {
        validTime: noon,
        acPowerKw: 13,
        uncertainty: { p10AcPowerKw: 12, p90AcPowerKw: 15 },
        contributingSiteCount: 3,
        contributingCapacityKw: 20,
      },
      {
        validTime: twoPm,
        acPowerKw: 1,
        contributingSiteCount: 1,
        contributingCapacityKw: 4,
      },
    ]);
  });

  it('omits the band key entirely when no contributing group had one', () => {
    const [point] = sumFleetRollupPartials([partial({ validTime: noon, acPowerKw: 2 })]);

    expect(point).toBeDefined();
    expect(point && 'uncertainty' in point).toBe(false);
  });

  it('yields no points for no partials', () => {
    expect(sumFleetRollupPartials([])).toEqual([]);
  });
});

describe('package surface', () => {
  it('exports the roll-up vocabulary from the package index', () => {
    expect(packageSurface.fleetRollupPartials).toBe(fleetRollupPartials);
    expect(packageSurface.sumFleetRollupPartials).toBe(sumFleetRollupPartials);
    expect(packageSurface.fleetForecastAggregate).toBe(fleetForecastAggregate);
    expect(packageSurface.FLEET_ROLLUP_PARTITION).toBe('#FLEET');
  });
});
