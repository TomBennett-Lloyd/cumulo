import { describe, expect, it } from 'vitest';

import {
  FLEET_ROLLUP_ACTUALS_KIND,
  fleetActualsAggregate,
  fleetActualsAggregatePointSchema,
  fleetActualsRollupPartials,
  sumFleetActualsRollupPartials,
} from './fleet-actuals-rollup';
import { generationReadingSchema, type GenerationReading } from './generation-reading';
import * as packageSurface from './index';

const noon = '2026-07-30T12:00:00Z';
const onePm = '2026-07-30T13:00:00Z';

const siteA = '11111111-1111-4111-8111-111111111111';
const siteB = '22222222-2222-4222-8222-222222222222';
const siteC = '33333333-3333-4333-8333-333333333333';

const capacities = [
  { id: siteA, capacityKw: 4 },
  { id: siteB, capacityKw: 6 },
  { id: siteC, capacityKw: 10 },
];

const reading = (siteId: string, validTime: string, acPowerKw: number): GenerationReading =>
  generationReadingSchema.parse({ siteId, validTime, acPowerKw });

describe('fleetActualsRollupPartials', () => {
  it('reports one band-less partial per hour reported, ascending, with its divisor', () => {
    expect(
      fleetActualsRollupPartials(
        [reading(siteB, onePm, 2), reading(siteA, noon, 3), reading(siteB, noon, 1)],
        capacities,
      ),
    ).toEqual([
      {
        validTime: noon,
        acPowerKw: 4,
        p10AcPowerKw: 4,
        p90AcPowerKw: 4,
        hasUncertainty: false,
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

  it('counts a site-hour once, so a re-run of the trailing window is a Put not an add', () => {
    const [partial] = fleetActualsRollupPartials(
      [reading(siteA, noon, 3), reading(siteA, noon, 3)],
      capacities,
    );
    expect(partial?.acPowerKw).toBe(3);
    expect(partial?.contributingSiteCount).toBe(1);
  });

  it('asserts no capacity it cannot evidence: an unknown site divides by 0', () => {
    const [partial] = fleetActualsRollupPartials([reading(siteC, noon, 3)], []);
    expect(partial?.contributingCapacityKw).toBe(0);
  });
});

describe('sumFleetActualsRollupPartials', () => {
  it('adds partials for the same hour and carries no band key', () => {
    const points = sumFleetActualsRollupPartials([
      ...fleetActualsRollupPartials([reading(siteA, noon, 3)], capacities),
      ...fleetActualsRollupPartials([reading(siteC, noon, 5)], capacities),
    ]);
    expect(points).toEqual([
      { validTime: noon, acPowerKw: 8, contributingSiteCount: 2, contributingCapacityKw: 14 },
    ]);
    for (const point of points) {
      expect(fleetActualsAggregatePointSchema.parse(point)).toEqual(point);
    }
  });

  it('equals the one-group aggregate over the same readings', () => {
    const readings = [reading(siteA, noon, 3), reading(siteB, noon, 1), reading(siteC, onePm, 7)];
    expect(fleetActualsAggregate(readings, capacities)).toEqual(
      sumFleetActualsRollupPartials(fleetActualsRollupPartials(readings, capacities)),
    );
  });
});

describe('package surface', () => {
  it('exports the actuals roll-up vocabulary from the package index', () => {
    expect(packageSurface.FLEET_ROLLUP_ACTUALS_KIND).toBe(FLEET_ROLLUP_ACTUALS_KIND);
    expect(packageSurface.fleetActualsRollupPartials).toBe(fleetActualsRollupPartials);
    expect(packageSurface.fleetActualsAggregate).toBe(fleetActualsAggregate);
  });
});
