import { describe, expect, it } from 'vitest';

import { countdownDeadline } from '../api-fixtures';
import { errorResponse } from '../http/response';

import { readFleetActualsAggregate } from './fleet-actuals-rollup-read';
import {
  DUBLIN_SITES,
  FROM,
  LONG_AGO,
  REWRITTEN_HOUR,
  SETTLED_HOUR,
  TO,
  harness,
  pointsOf,
  read,
  slice,
  total,
} from './fleet-actuals-rollup-fixtures';
import { BRISTOL_SITE, DUBLIN, RANELAGH, row } from './fleet-rollup-fixtures';

/**
 * The actuals read's two-Query shape (ADR 0009's #615 entry): totals over the window, then the
 * slices from the hour after the last total. Windows are asserted literally, for the reason
 * `packages/storage/src/adapters/series/fleet-rollup-adapter.test.ts` gives.
 */

const hourly = (from: number, to: number, kw: number) =>
  Array.from({ length: to - from + 1 }, (_unused, index) => {
    const hour = from + index;
    const day = hour < 24 ? '2026-07-30' : '2026-07-31';
    return total(`${day}T${String(hour % 24).padStart(2, '0')}:00:00Z`, kw);
  });

const OLD_SITES = DUBLIN_SITES.map((site) => ({ ...site, createdAt: LONG_AGO }));

describe('readFleetActualsAggregate over totals and slices', () => {
  it('reads the totals over the window, then the slices from the hour after the last total', async () => {
    const totals = [...hourly(12, 24 + 6, 3)];
    const { deps, totalsWindows, sliceWindows, logged } = harness(
      [
        row(DUBLIN, OLD_SITES, slice('2026-07-31T07:00:00Z', 4)),
        row(DUBLIN, OLD_SITES, slice(REWRITTEN_HOUR, 5)),
      ],
      totals,
    );

    const points = pointsOf(await read(deps, OLD_SITES));

    expect(totalsWindows).toEqual([[FROM, TO]]);
    expect(sliceWindows).toEqual([['2026-07-31T07:00:00Z', TO]]);
    expect(points.map((point) => point.validTime)).toEqual([
      ...totals.map((point) => point.validTime),
      '2026-07-31T07:00:00Z',
      REWRITTEN_HOUR,
    ]);
    expect(logged).toEqual([]);
  });

  it('reads every slice from the window start when no total exists', async () => {
    const { deps, sliceWindows } = harness([row(DUBLIN, DUBLIN_SITES, slice(REWRITTEN_HOUR, 5))]);

    await read(deps, DUBLIN_SITES);

    expect(sliceWindows).toEqual([[FROM, TO]]);
  });

  it('never double-counts the last total’s hour', async () => {
    const { deps } = harness(
      [
        row(DUBLIN, DUBLIN_SITES, slice(SETTLED_HOUR, 99)),
        row(DUBLIN, DUBLIN_SITES, slice(REWRITTEN_HOUR, 5)),
      ],
      [...hourly(12, 24 + 5, 3), total(SETTLED_HOUR, 3)],
    );

    const points = pointsOf(await read(deps, OLD_SITES));

    expect(points.filter((point) => point.validTime === SETTLED_HOUR)).toEqual([
      total(SETTLED_HOUR, 3),
    ]);
  });

  it('issues no slices Query when the last total ends at the window, and logs nothing', async () => {
    const last = total('2026-07-31T11:00:00Z', 3);
    const { deps, sliceWindows, logged } = harness([], [last]);

    const points = pointsOf(await read(deps, DUBLIN_SITES));

    expect(sliceWindows).toEqual([]);
    expect(points).toEqual([last]);
    expect(logged).toEqual([]);
  });

  it('checks membership on the trailing slices and never on a total', async () => {
    const totals = hourly(12, 24 + 6, 3);
    const live = harness([row(DUBLIN, OLD_SITES, slice(REWRITTEN_HOUR, 5))], totals);
    expect(pointsOf(await read(live.deps, OLD_SITES))).toHaveLength(totals.length + 1);

    const resized = harness([row(DUBLIN, [RANELAGH], slice(REWRITTEN_HOUR, 5))], totals);
    expect(pointsOf(await read(resized.deps, OLD_SITES))).toHaveLength(totals.length);
    expect(resized.logged[0]).toMatchObject({ reason: 'stale' });
  });

  it('names a location missing from the slices read as incomplete, and sums the rest', async () => {
    const totals = hourly(12, 24 + 6, 3);
    const { deps, logged } = harness([row(DUBLIN, OLD_SITES, slice(REWRITTEN_HOUR, 5))], totals);

    const points = pointsOf(
      await read(deps, [...OLD_SITES, { ...BRISTOL_SITE, createdAt: LONG_AGO }]),
    );

    expect(points).toHaveLength(totals.length + 1);
    expect(logged[0]).toMatchObject({ reason: 'incomplete', presentLocations: 1 });
  });

  it.each([
    { walk: 'totals', options: { totalsComplete: false } },
    { walk: 'slices', options: { sliceComplete: false } },
  ])(
    'refuses with the deadline response when the $walk page walk was read short',
    async ({ options }) => {
      const { deps, logged } = harness(
        [row(DUBLIN, OLD_SITES, slice(REWRITTEN_HOUR, 5))],
        hourly(12, 24 + 6, 3),
        options,
      );

      const result = await read(deps, OLD_SITES);

      expect(result).toEqual({
        complete: false,
        response: errorResponse('internal', 'the request could not be completed in time'),
      });
      expect(logged).toEqual([{ event: 'deadline-event', totalsRead: 19, slicesRead: 1 }]);
    },
  );

  it('refuses with the deadline response rather than start the slices Query without budget', async () => {
    const { deps, sliceWindows, logged } = harness([], hourly(12, 24 + 6, 3));

    const result = await readFleetActualsAggregate(
      deps,
      countdownDeadline(0),
      OLD_SITES,
      FROM,
      TO,
      'deadline-event',
    );

    expect(result).toEqual({
      complete: false,
      response: errorResponse('internal', 'the request could not be completed in time'),
    });
    expect(logged).toEqual([{ event: 'deadline-event', totalsRead: 19 }]);
    expect(sliceWindows).toEqual([]);
  });

  it('admits the slices Query with exactly one permit, the gate being a single reading', async () => {
    const { deps, sliceWindows } = harness([], hourly(12, 24 + 6, 3));

    await readFleetActualsAggregate(
      deps,
      countdownDeadline(1),
      OLD_SITES,
      FROM,
      TO,
      'deadline-event',
    );

    expect(sliceWindows).toHaveLength(1);
  });

  it('dates the response by the slices only, never by a total', async () => {
    const result = await read(
      harness([row(DUBLIN, OLD_SITES, slice(REWRITTEN_HOUR, 5))], hourly(12, 24 + 6, 3)).deps,
      OLD_SITES,
    );

    expect(result.complete && result.readingTimesByGroup).toEqual([[REWRITTEN_HOUR]]);
  });
});
