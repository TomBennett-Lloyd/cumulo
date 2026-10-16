import { describe, expect, it } from 'vitest';

import { countdownDeadline, generationPoint, RATHMINES_ID } from '../api-fixtures';
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
    const { deps, totalsWindows, sliceWindows, siteReads, logged } = harness(
      [
        row(DUBLIN, OLD_SITES, slice('2026-07-31T07:00:00Z', 4)),
        row(DUBLIN, OLD_SITES, slice(REWRITTEN_HOUR, 5)),
      ],
      {},
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
    expect(siteReads).toEqual([]);
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
      {},
      [...hourly(12, 24 + 5, 3), total(SETTLED_HOUR, 3)],
    );

    const points = pointsOf(await read(deps, OLD_SITES));

    expect(points.filter((point) => point.validTime === SETTLED_HOUR)).toEqual([
      total(SETTLED_HOUR, 3),
    ]);
  });

  it('issues no slices Query when the last total ends at the window, and falls back', async () => {
    const { deps, sliceWindows, logged } = harness([], {}, [total('2026-07-31T11:00:00Z', 3)]);

    await read(deps, DUBLIN_SITES);

    expect(sliceWindows).toEqual([]);
    expect(logged[0]).toMatchObject({ reason: 'absent' });
  });

  it('is covered at its first hour by a total, and not by a total an hour later', async () => {
    const slices = [row(DUBLIN, OLD_SITES, slice(REWRITTEN_HOUR, 5))];
    const covered = harness(slices, {}, [...hourly(12, 24 + 9, 3)]);
    expect(pointsOf(await read(covered.deps, OLD_SITES))).toHaveLength(23);
    expect(covered.logged).toEqual([]);

    const late = harness(slices, {}, [...hourly(13, 24 + 9, 3)]);
    await read(late.deps, OLD_SITES);
    expect(late.logged[0]).toMatchObject({ reason: 'incomplete', uncoveredLocations: 1 });
  });

  it('checks membership on the trailing slices and never on a total', async () => {
    const totals = hourly(12, 24 + 6, 3);
    const live = harness([row(DUBLIN, OLD_SITES, slice(REWRITTEN_HOUR, 5))], {}, totals);
    expect(pointsOf(await read(live.deps, OLD_SITES))).toHaveLength(totals.length + 1);

    const resized = harness([row(DUBLIN, [RANELAGH], slice(REWRITTEN_HOUR, 5))], {}, totals);
    await read(resized.deps, OLD_SITES);
    expect(resized.logged[0]).toMatchObject({ reason: 'stale' });
  });

  it('requires every expected location in the slices read', async () => {
    const { deps, logged } = harness(
      [row(DUBLIN, OLD_SITES, slice(REWRITTEN_HOUR, 5))],
      {},
      hourly(12, 24 + 6, 3),
    );

    await read(deps, [...OLD_SITES, { ...BRISTOL_SITE, createdAt: LONG_AGO }]);

    expect(logged[0]).toMatchObject({ reason: 'incomplete', presentLocations: 1 });
  });

  it('falls back as incomplete when the totals page walk was read short', async () => {
    const { deps, logged } = harness(
      [row(DUBLIN, OLD_SITES, slice(REWRITTEN_HOUR, 5))],
      { [RATHMINES_ID]: [generationPoint({ siteId: RATHMINES_ID })] },
      hourly(12, 24 + 6, 3),
      { totalsComplete: false },
    );

    await read(deps, OLD_SITES);

    expect(logged[0]).toMatchObject({ reason: 'incomplete' });
  });

  it('refuses with the deadline response rather than start the slices Query without budget', async () => {
    const { deps, sliceWindows, logged } = harness([], {}, hourly(12, 24 + 6, 3));

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
    const { deps, sliceWindows } = harness([], {}, hourly(12, 24 + 6, 3));

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
      harness([row(DUBLIN, OLD_SITES, slice(REWRITTEN_HOUR, 5))], {}, hourly(12, 24 + 6, 3)).deps,
      OLD_SITES,
    );

    expect(result.complete && result.readingTimesByGroup).toEqual([[REWRITTEN_HOUR]]);
  });
});
