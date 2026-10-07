import {
  FLEET_ROLLUP_ACTUALS_KIND,
  utcIsoTimestampSchema,
  type FleetSite,
  type SeriesKind,
} from '@cumulo/shared';
import type { FleetRollupRow, SeriesPoint } from '@cumulo/storage';
import { describe, expect, it } from 'vitest';

import { fleetSite, fullBudgetDeadline, generationPoint, RATHMINES_ID } from '../api-fixtures';

import {
  fleetActualsRollupFallbackEvent,
  readFleetActualsAggregate,
  type FleetActualsAggregateRead,
} from './fleet-actuals-rollup-read';
import {
  BRISTOL,
  BRISTOL_SITE,
  DUBLIN,
  EARLIER_RUN,
  RANELAGH,
  RATHMINES,
  partial,
  row,
} from './fleet-rollup-fixtures';
import type { FleetRollupReadDeps } from './fleet-rollup-read';

/** The actuals read's completeness rule (ADR 0009's #506 amendment), case by case. */

const FROM = utcIsoTimestampSchema.parse('2026-07-30T12:00:00Z');
const TO = utcIsoTimestampSchema.parse('2026-07-31T12:00:00Z');
/** The window's first hour, and one the producer no longer rewrites, and one it still does. */
const FIRST_HOUR = '2026-07-30T12:00:00Z';
const SETTLED_HOUR = '2026-07-31T06:00:00Z';
const REWRITTEN_HOUR = '2026-07-31T10:00:00Z';

/** A GEN slice: no band, as `fleetActualsRollupPartials` writes it. */
const slice = (validTime: string, acPowerKw: number) =>
  partial({
    validTime,
    acPowerKw,
    p10AcPowerKw: acPowerKw,
    p90AcPowerKw: acPowerKw,
    hasUncertainty: false,
  });

const DUBLIN_SITES = [RANELAGH, RATHMINES];

const harness = (
  rows: readonly FleetRollupRow[],
  pointsBySite: Readonly<Record<string, readonly SeriesPoint[]>> = {},
) => {
  const kinds: SeriesKind[] = [];
  const siteReads: string[] = [];
  const logged: Record<string, unknown>[] = [];
  const deps: FleetRollupReadDeps = {
    series: {
      queryFleetRollup: (kind) => {
        kinds.push(kind);
        return Promise.resolve({ rows: [...rows], complete: true });
      },
      querySeriesRange: (siteId) => {
        siteReads.push(siteId);
        return Promise.resolve({ points: [...(pointsBySite[siteId] ?? [])], complete: true });
      },
    },
    log: (entry) => logged.push(entry),
  };
  return { deps, kinds, siteReads, logged };
};

const read = (deps: FleetRollupReadDeps, sites: readonly FleetSite[]) =>
  readFleetActualsAggregate(deps, fullBudgetDeadline, sites, FROM, TO, 'deadline-event');

const pointsOf = (result: FleetActualsAggregateRead) => {
  if (!result.complete) {
    throw new Error('expected a complete read');
  }
  return result.points;
};

describe('readFleetActualsAggregate', () => {
  it('sums every location’s GEN slices, in one Query of the actuals kind, with no band', async () => {
    const { deps, kinds, siteReads, logged } = harness([
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
    expect(siteReads).toEqual([]);
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
    const { deps, siteReads } = harness([
      row(DUBLIN, [RANELAGH], slice(SETTLED_HOUR, 4)),
      row(DUBLIN, DUBLIN_SITES, slice(REWRITTEN_HOUR, 5)),
    ]);

    expect(pointsOf(await read(deps, DUBLIN_SITES)).map((point) => point.acPowerKw)).toEqual([
      4, 5,
    ]);
    expect(siteReads).toEqual([]);
  });

  it('falls back as stale when an hour the producer still rewrites carries another membership', async () => {
    const { deps, siteReads, logged } = harness(
      [row(DUBLIN, [RANELAGH], slice(REWRITTEN_HOUR, 5))],
      { [RATHMINES_ID]: [generationPoint({ siteId: RATHMINES_ID, acPowerKw: 1.5 })] },
    );

    const points = pointsOf(await read(deps, DUBLIN_SITES));

    expect(siteReads).toEqual([RANELAGH.id, RATHMINES_ID]);
    expect(points.map((point) => point.acPowerKw)).toEqual([1.5]);
    expect(logged).toEqual([
      {
        event: fleetActualsRollupFallbackEvent,
        reason: 'stale',
        expectedLocations: 1,
        presentLocations: 1,
        staleLocations: 1,
        uncoveredLocations: 0,
        hours: 1,
      },
    ]);
  });

  it.each([
    { name: 'absent', rows: [] },
    { name: 'incomplete', rows: [row(DUBLIN, DUBLIN_SITES, slice(REWRITTEN_HOUR, 5))] },
  ])('falls back as $name when a location has written nothing', async ({ name, rows }) => {
    const { deps, siteReads, logged } = harness(rows);

    await read(deps, [...DUBLIN_SITES, BRISTOL_SITE]);

    expect(siteReads).toHaveLength(3);
    expect(logged[0]).toMatchObject({ event: fleetActualsRollupFallbackEvent, reason: name });
  });

  it('falls back as incomplete when a location older than the window lacks its first hour', async () => {
    // The first week after the producer ships: recent hours exist, the history does not yet.
    const settledSites = DUBLIN_SITES.map((site) => ({ ...site, createdAt: EARLIER_RUN }));
    const old = [RANELAGH, RATHMINES].map((site) =>
      fleetSite({ id: site.id, name: site.name, createdAt: '2026-07-01T00:00:00Z' }),
    );
    const recentOnly = [row(DUBLIN, old, slice(REWRITTEN_HOUR, 5))];

    const short = harness(recentOnly);
    await read(short.deps, old);
    expect(short.logged[0]).toMatchObject({ reason: 'incomplete', uncoveredLocations: 1 });

    const whole = harness([...recentOnly, row(DUBLIN, old, slice(FIRST_HOUR, 1))]);
    expect(pointsOf(await read(whole.deps, old))).toHaveLength(2);
    expect(whole.logged).toEqual([]);

    // A location younger than the window owes no first hour: its sites had none to report.
    const young = harness([row(DUBLIN, settledSites, slice(REWRITTEN_HOUR, 5))]);
    expect(pointsOf(await read(young.deps, settledSites))).toHaveLength(1);
  });

  it('drops a location the fleet no longer has active sites at', async () => {
    const { deps } = harness([
      row(DUBLIN, DUBLIN_SITES, slice(REWRITTEN_HOUR, 5)),
      row(BRISTOL, [BRISTOL_SITE], slice(REWRITTEN_HOUR, 2)),
    ]);

    expect(pointsOf(await read(deps, DUBLIN_SITES)).map((point) => point.acPowerKw)).toEqual([5]);
  });

  it('answers a fleet with no active sites without touching the table', async () => {
    const { deps, kinds, siteReads } = harness([]);

    expect(pointsOf(await read(deps, [{ ...RANELAGH, active: false }]))).toEqual([]);
    expect(kinds).toEqual([]);
    expect(siteReads).toEqual([]);
  });
});
