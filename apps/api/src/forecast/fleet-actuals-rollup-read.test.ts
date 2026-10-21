import { FLEET_ROLLUP_ACTUALS_KIND } from '@cumulo/shared';
import { describe, expect, it } from 'vitest';

import {
  DUBLIN_SITES,
  REWRITTEN_HOUR,
  SETTLED_HOUR,
  harness,
  pointsOf,
  read,
  slice,
} from './fleet-actuals-rollup-fixtures';
import { fleetActualsRollupShortEvent } from './fleet-actuals-rollup-read';
import {
  BRISTOL,
  BRISTOL_SITE,
  DUBLIN,
  EARLIER_RUN,
  NEWCOMER,
  RANELAGH,
  row,
} from './fleet-rollup-fixtures';

/** The actuals read's completeness rule (ADR 0009's #506 and #507 amendments), case by case. */

describe('readFleetActualsAggregate', () => {
  it('sums every location’s GEN slices, in one Query of the actuals kind, with no band', async () => {
    const { deps, kinds, logged } = harness([
      row(DUBLIN, DUBLIN_SITES, slice(REWRITTEN_HOUR, 5)),
      row(BRISTOL, [BRISTOL_SITE], slice(REWRITTEN_HOUR, 2)),
    ]);

    const points = pointsOf(await read(deps, [...DUBLIN_SITES, BRISTOL_SITE]));

    expect(kinds).toEqual([FLEET_ROLLUP_ACTUALS_KIND]);
    expect(points).toEqual([
      {
        validTime: REWRITTEN_HOUR,
        acPowerKw: 7,
        contributingSiteCount: 4,
        contributingCapacityKw: 16.8,
      },
    ]);
    expect(logged).toEqual([]);
  });

  it('checks no vintage: a look-back is written by many runs', async () => {
    const { deps, logged } = harness([
      row(DUBLIN, DUBLIN_SITES, slice(SETTLED_HOUR, 4), EARLIER_RUN),
      row(DUBLIN, DUBLIN_SITES, slice(REWRITTEN_HOUR, 5)),
    ]);

    expect(pointsOf(await read(deps, DUBLIN_SITES))).toHaveLength(2);
    expect(logged).toEqual([]);
  });

  it('sums a settled hour as written, whatever membership it was summed under', async () => {
    const { deps } = harness([
      row(DUBLIN, [RANELAGH], slice(SETTLED_HOUR, 4)),
      row(DUBLIN, DUBLIN_SITES, slice(REWRITTEN_HOUR, 5)),
    ]);

    expect(pointsOf(await read(deps, DUBLIN_SITES)).map((point) => point.acPowerKw)).toEqual([
      4, 5,
    ]);
  });

  it('leaves a rewritten-hour slice with another membership out of the sum, and says so', async () => {
    const { deps, logged } = harness([
      row(DUBLIN, [RANELAGH], slice(REWRITTEN_HOUR, 5)),
      row(BRISTOL, [BRISTOL_SITE], slice(REWRITTEN_HOUR, 2)),
    ]);

    const result = await read(deps, [...DUBLIN_SITES, BRISTOL_SITE]);

    expect(pointsOf(result).map((point) => point.acPowerKw)).toEqual([2]);
    // The stale location has no run behind the sum, so it dates nothing.
    expect(result.complete && result.readingTimesByGroup).toEqual([[REWRITTEN_HOUR]]);
    expect(logged).toEqual([
      {
        event: fleetActualsRollupShortEvent,
        reason: 'stale',
        expectedLocations: 2,
        presentLocations: 2,
        staleLocations: 1,
        hours: 1,
      },
    ]);
  });

  it('sums a rewritten hour whose only membership change is an added site', async () => {
    const { deps, logged } = harness([row(DUBLIN, DUBLIN_SITES, slice(REWRITTEN_HOUR, 5))]);

    const points = pointsOf(await read(deps, [...DUBLIN_SITES, NEWCOMER]));

    expect(points.map((point) => point.acPowerKw)).toEqual([5]);
    expect(logged).toEqual([]);
  });

  it.each([
    { name: 'absent', rows: [], kilowatts: [] },
    {
      name: 'incomplete',
      rows: [row(DUBLIN, DUBLIN_SITES, slice(REWRITTEN_HOUR, 5))],
      kilowatts: [5],
    },
  ])('serves what has been written and says it is $name', async ({ name, rows, kilowatts }) => {
    const { deps, logged } = harness(rows);

    const points = pointsOf(await read(deps, [...DUBLIN_SITES, BRISTOL_SITE]));

    expect(points.map((point) => point.acPowerKw)).toEqual(kilowatts);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      event: fleetActualsRollupShortEvent,
      reason: name,
      presentLocations: kilowatts.length,
    });
  });

  it('drops a location the fleet no longer has sites at', async () => {
    const { deps } = harness([
      row(DUBLIN, DUBLIN_SITES, slice(REWRITTEN_HOUR, 5)),
      row(BRISTOL, [BRISTOL_SITE], slice(REWRITTEN_HOUR, 2)),
    ]);

    expect(pointsOf(await read(deps, DUBLIN_SITES)).map((point) => point.acPowerKw)).toEqual([5]);
  });

  it('answers an empty fleet without touching the table', async () => {
    const { deps, kinds } = harness([]);

    expect(pointsOf(await read(deps, []))).toEqual([]);
    expect(kinds).toEqual([]);
  });
});
