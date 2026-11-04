import type { FleetSite } from '@cumulo/shared';
import type { FleetRollupRow } from '@cumulo/storage';
import { describe, expect, it } from 'vitest';

import { errorResponse } from '../http/response';

import {
  BRISTOL,
  BRISTOL_SITE,
  DEADLINE_EVENT,
  DUBLIN,
  EARLIER_RUN,
  harness,
  ISSUED_AT,
  NEWCOMER,
  partial,
  pointsOf,
  RANELAGH,
  RATHMINES,
  read,
  row,
} from './fleet-rollup-fixtures';
import { fleetRollupShortEvent } from './fleet-rollup-read';

/**
 * Which partition states are summed whole, which are served short, and which are refused — the
 * decision ADR 0009's 2026-10-21 (#507) entry makes, tested where it lives rather than through the
 * route.
 *
 * Through `readFleetForecastAggregate` directly because the route adds nothing to this question: it
 * chooses a window and parses an envelope, and `get-fleet-forecast.test.ts` owns both.
 */

describe('the roll-up answers', () => {
  it('sums the partition when every expected location has written', async () => {
    const { deps, logged } = harness({
      rows: [
        row(DUBLIN, [RANELAGH], partial({ acPowerKw: 5 })),
        row(BRISTOL, [BRISTOL_SITE], partial({ acPowerKw: 3 })),
      ],
    });

    const points = pointsOf(await read(deps, [RANELAGH, BRISTOL_SITE]));

    expect(points.map((point) => point.acPowerKw)).toEqual([8]);
    expect(logged).toEqual([]);
  });

  it('counts two sites in one bucket as one expected partial', async () => {
    // `locationId` is what the producer's messages are keyed by (ADR 0004), so a fleet of sixty
    // sites in twelve buckets expects twelve partials. Expecting one per *site* would log `short`
    // for ever.
    const { deps, logged } = harness({ rows: [row(DUBLIN, [RANELAGH, RATHMINES], partial())] });

    await read(deps, [RANELAGH, RATHMINES]);

    expect(logged).toEqual([]);
  });

  it('never sums a location the fleet no longer has sites at', async () => {
    // The partials of a decommissioned location are written under keys nothing rewrites once
    // ingestion stops publishing for it, and they outlive its last site by the whole horizon. Summed
    // blind, that is a ghost site generating for about two days.
    const { deps, logged } = harness({
      rows: [
        row(DUBLIN, [RANELAGH], partial({ acPowerKw: 5, contributingSiteCount: 2 })),
        row(BRISTOL, [BRISTOL_SITE], partial({ acPowerKw: 3, contributingSiteCount: 1 })),
      ],
    });

    const points = pointsOf(await read(deps, [RANELAGH]));

    expect(points.map((point) => point.acPowerKw)).toEqual([5]);
    expect(points[0]?.contributingSiteCount).toBe(2);
    // The fleet it is asked about is complete, and the extra row is answered by ignoring it.
    expect(logged).toEqual([]);
  });

  /**
   * The completeness decision, pinned rather than argued: the check is per **location**, so a
   * location that wrote some of its hours and not others is summed rather than refused, and the
   * short hour is **labelled** by the `contributingSiteCount` that travels on it — which
   * `minimumContributingSites` folds and `partialAggregateNotice` renders
   * (`docs/standards/error-handling.md` rule 5). ADR 0009's 2026-10-05 (#531) amendment states why
   * an expected-*hours* notion is not this route's to hold.
   *
   * This case does not fail on the pre-#531 code. It is here so the amendment has an asserting test
   * rather than standing prose (`docs/standards/prose.md` rule 2): a change that started refusing
   * the short hour, or that stopped carrying the count that labels it, fails here.
   */
  it('sums a location that wrote half its hours, and the short hour says how thin it is', async () => {
    const twoPm = '2026-07-31T14:00:00Z';
    const { deps, logged } = harness({
      rows: [
        row(DUBLIN, [RANELAGH], partial({ acPowerKw: 5, contributingSiteCount: 2 })),
        row(
          DUBLIN,
          [RANELAGH],
          partial({ validTime: twoPm, acPowerKw: 6, contributingSiteCount: 2 }),
        ),
        row(BRISTOL, [BRISTOL_SITE], partial({ acPowerKw: 3, contributingSiteCount: 1 })),
      ],
    });

    const points = pointsOf(await read(deps, [RANELAGH, BRISTOL_SITE]));

    expect(points.map((point) => point.acPowerKw)).toEqual([8, 6]);
    expect(points.map((point) => point.contributingSiteCount)).toEqual([3, 2]);
    expect(logged).toEqual([]);
  });

  it('answers an empty fleet without reading anything at all', async () => {
    const { deps, rollupReads, logged } = harness();

    expect(pointsOf(await read(deps, []))).toEqual([]);
    expect(rollupReads).toBe(0);
    expect(logged).toEqual([]);
  });
});

/**
 * Membership and vintage (#602, #507): a location that has written is summed only if its slices
 * were summed from the sites it had when the run was issued, by one run. Each stale case below sums
 * on the pre-#602 code — the location-set check alone passes every one.
 */
describe('a stale location', () => {
  const BRISTOL_ROW = row(
    BRISTOL,
    [BRISTOL_SITE],
    partial({ acPowerKw: 3, contributingSiteCount: 1 }),
  );

  /** Dublin's rows against Dublin's sites now, beside a Bristol that is fresh. */
  const staleRead = async (
    dublin: readonly FleetRollupRow[],
    dublinSites: readonly FleetSite[],
  ) => {
    const { deps, logged } = harness({ rows: [...dublin, BRISTOL_ROW] });
    return { points: pointsOf(await read(deps, [...dublinSites, BRISTOL_SITE])), logged };
  };

  const expectBristolAlone = (
    { points, logged }: Awaited<ReturnType<typeof staleRead>>,
    hours = 1,
  ) => {
    expect(points.map((point) => [point.acPowerKw, point.contributingSiteCount])).toEqual([[3, 1]]);
    expect(logged).toEqual([
      {
        event: fleetRollupShortEvent,
        reason: 'stale',
        expectedLocations: 2,
        presentLocations: 2,
        staleLocations: 1,
        hours,
      },
    ]);
  };

  it('leaves out a location whose slice still sums a site that has gone', async () => {
    // #579: the slice still carries the deleted site's kilowatts, count and capacity.
    expectBristolAlone(
      await staleRead(
        [row(DUBLIN, [RANELAGH, RATHMINES], partial({ acPowerKw: 5, contributingSiteCount: 2 }))],
        [RANELAGH],
      ),
    );
  });

  it('leaves out a location when one site left and another joined the same bucket', async () => {
    // Same count, possibly the same capacity: only the membership itself tells these apart. The
    // joiner is old enough for the run to have listed it, so it is not an add.
    const joiner = {
      ...NEWCOMER,
      createdAt: RATHMINES.createdAt,
      capacityKw: RATHMINES.capacityKw,
    };

    expectBristolAlone(await staleRead([row(DUBLIN, [RANELAGH, RATHMINES])], [RANELAGH, joiner]));
  });

  it('leaves out a location whose site’s physics were edited in place', async () => {
    // `PUT /v1/sites/{siteId}` keeps the id; the slice's capacity divisor and kilowatts do not move.
    expectBristolAlone(
      await staleRead([row(DUBLIN, [RANELAGH])], [{ ...RANELAGH, capacityKw: 5 }]),
    );
  });

  it('leaves out a location whose slices come from two forecast runs', async () => {
    // A `store-partial` roll-up drain, or a replayed message, leaves part of the horizon on another run.
    expectBristolAlone(
      await staleRead(
        [
          row(DUBLIN, [RANELAGH], partial(), ISSUED_AT),
          row(DUBLIN, [RANELAGH], partial({ validTime: '2026-07-31T14:00:00Z' }), EARLIER_RUN),
        ],
        [RANELAGH],
      ),
      2,
    );
  });

  it('counts a site created in the same instant as the run as one the run should have listed', async () => {
    const sameInstant = { ...NEWCOMER, createdAt: ISSUED_AT };

    expectBristolAlone(await staleRead([row(DUBLIN, [RANELAGH])], [RANELAGH, sameInstant]));
  });

  it('sums a location whose only change since its run is an added site', async () => {
    // The run could not have listed a site created after it, and that site has no forecast yet
    // (#286): the slice is exactly right for every site that has one.
    const { deps, logged } = harness({
      rows: [row(DUBLIN, [RANELAGH], partial({ acPowerKw: 5 }))],
    });

    const points = pointsOf(await read(deps, [RANELAGH, NEWCOMER]));

    expect(points.map((point) => point.acPowerKw)).toEqual([5]);
    expect(logged).toEqual([]);
  });

  it('sums locations written by different runs, each from one run', async () => {
    // Fresh, and the case that keeps vintage per location: ingestion visits locations with no
    // end-of-run event, so a fleet-wide vintage test would flag every cycle (ADR 0009).
    const { deps, logged } = harness({
      rows: [
        row(DUBLIN, [RANELAGH], partial({ acPowerKw: 5 }), ISSUED_AT),
        row(BRISTOL, [BRISTOL_SITE], partial({ acPowerKw: 3 }), EARLIER_RUN),
      ],
    });

    expect(pointsOf(await read(deps, [RANELAGH, BRISTOL_SITE])).map((p) => p.acPowerKw)).toEqual([
      8,
    ]);
    expect(logged).toEqual([]);
  });
});

describe('a short partition', () => {
  it('serves an untouched partition as no points and says it is absent', async () => {
    const { deps, logged } = harness();

    expect(pointsOf(await read(deps, [RANELAGH]))).toEqual([]);
    expect(logged).toEqual([
      {
        event: fleetRollupShortEvent,
        reason: 'absent',
        expectedLocations: 1,
        presentLocations: 0,
        staleLocations: 0,
        hours: 0,
      },
    ]);
  });

  it('sums the locations that have written and names the missing count', async () => {
    // Eleven of twelve locations sums to a plausible-looking fleet with nothing visibly missing, so
    // the response is labelled twice: `contributingSiteCount` on each point, and this line.
    const { deps, logged } = harness({
      rows: [row(DUBLIN, [RANELAGH], partial({ acPowerKw: 5, contributingSiteCount: 2 }))],
    });

    const points = pointsOf(await read(deps, [RANELAGH, BRISTOL_SITE]));

    expect(points.map((point) => [point.acPowerKw, point.contributingSiteCount])).toEqual([[5, 2]]);
    expect(logged).toEqual([
      {
        event: fleetRollupShortEvent,
        reason: 'incomplete',
        expectedLocations: 2,
        presentLocations: 1,
        staleLocations: 0,
        hours: 1,
      },
    ]);
  });

  it('reports a missing location as incomplete even when another is stale, and counts both', async () => {
    // Dublin's slice still sums Rathmines, which has gone; Bristol has not written at all.
    const { deps, logged } = harness({ rows: [row(DUBLIN, [RANELAGH, RATHMINES])] });

    expect(pointsOf(await read(deps, [RANELAGH, BRISTOL_SITE]))).toEqual([]);
    expect(logged[0]).toMatchObject({
      reason: 'incomplete',
      expectedLocations: 2,
      presentLocations: 1,
      staleLocations: 1,
    });
  });

  it('refuses with the deadline response when the roll-up Query stopped short', async () => {
    // A window missing its tail is labelled by no count, so unlike a short partition it is a 500.
    const { deps, logged } = harness({
      rows: [row(DUBLIN, [RANELAGH], partial())],
      rollupComplete: false,
    });

    const result = await read(deps, [RANELAGH]);

    expect(result).toEqual({
      complete: false,
      response: errorResponse('internal', 'the request could not be completed in time'),
    });
    expect(logged).toEqual([{ event: DEADLINE_EVENT, rowsRead: 1 }]);
  });
});

describe('the runs behind the sum', () => {
  const issuedAtsOf = (result: Awaited<ReturnType<typeof read>>) => {
    if (!result.complete) {
      throw new Error('expected a complete read');
    }
    return result.issuedAtsByGroup;
  };

  it('groups the roll-up by location, each with the run that wrote it', async () => {
    const { deps } = harness({
      rows: [
        row(DUBLIN, [RANELAGH], partial(), ISSUED_AT),
        row(BRISTOL, [BRISTOL_SITE], partial(), EARLIER_RUN),
      ],
    });

    const groups = issuedAtsOf(await read(deps, [RANELAGH, BRISTOL_SITE]));

    expect(groups).toEqual([[ISSUED_AT], [EARLIER_RUN]]);
  });

  it('has no group for a location left out of the sum', async () => {
    const { deps } = harness({ rows: [row(DUBLIN, [RANELAGH], partial(), ISSUED_AT)] });

    const groups = issuedAtsOf(await read(deps, [RANELAGH, BRISTOL_SITE]));

    expect(groups).toEqual([[ISSUED_AT]]);
  });

  it('has no group for a stale location', async () => {
    const { deps } = harness({
      rows: [
        row(DUBLIN, [RANELAGH, RATHMINES], partial(), ISSUED_AT),
        row(BRISTOL, [BRISTOL_SITE], partial(), EARLIER_RUN),
      ],
    });

    const groups = issuedAtsOf(await read(deps, [RANELAGH, BRISTOL_SITE]));

    expect(groups).toEqual([[EARLIER_RUN]]);
  });

  it('has no group for an empty fleet', async () => {
    const { deps } = harness();

    expect(issuedAtsOf(await read(deps, []))).toEqual([]);
  });
});
