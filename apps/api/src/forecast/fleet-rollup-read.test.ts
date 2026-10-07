import type { FleetSite } from '@cumulo/shared';
import type { FleetRollupRow } from '@cumulo/storage';
import { describe, expect, it } from 'vitest';

import { fleetSite, forecast, generationPoint, RANELAGH_ID, RATHMINES_ID } from '../api-fixtures';

import {
  BRISTOL,
  BRISTOL_SITE,
  DUBLIN,
  EARLIER_RUN,
  harness,
  ISSUED_AT,
  partial,
  pointsOf,
  RANELAGH,
  RATHMINES,
  read,
  row,
} from './fleet-rollup-fixtures';
import { fleetRollupFallbackEvent } from './fleet-rollup-read';

/**
 * Which partition states answer from the roll-up and which fall back — the decision ADR 0009's
 * fallback *is*, tested where it lives rather than through the route.
 *
 * Through `readFleetForecastAggregate` directly because the route adds nothing to this question: it
 * chooses a window and parses an envelope, and `get-fleet-forecast.test.ts` owns both.
 */

describe('the roll-up answers', () => {
  it('sums the partition when every expected location has written', async () => {
    const { deps, siteReads, logged } = harness({
      rows: [
        row(DUBLIN, [RANELAGH], partial({ acPowerKw: 5 })),
        row(BRISTOL, [BRISTOL_SITE], partial({ acPowerKw: 3 })),
      ],
    });

    const points = pointsOf(await read(deps, [RANELAGH, BRISTOL_SITE]));

    expect(points.map((point) => point.acPowerKw)).toEqual([8]);
    expect(siteReads).toEqual([]);
    expect(logged).toEqual([]);
  });

  it('counts two sites in one bucket as one expected partial', async () => {
    // `locationId` is what the producer's messages are keyed by (ADR 0004), so a fleet of sixty
    // sites in twelve buckets expects twelve partials. Expecting one per *site* would fall back for
    // ever.
    const { deps, siteReads } = harness({
      rows: [row(DUBLIN, [RANELAGH, RATHMINES], partial())],
    });

    await read(deps, [RANELAGH, RATHMINES]);

    expect(siteReads).toEqual([]);
  });

  it('never sums a location the fleet no longer has active sites at', async () => {
    // The partials of a decommissioned location are written under keys nothing rewrites once
    // ingestion stops publishing for it, and they outlive its last site by the whole horizon. Summed
    // blind, that is a ghost site generating for about two days — and a difference from the fan-out
    // arm, which cannot do it because it iterates the site list.
    const { deps, siteReads, logged } = harness({
      rows: [
        row(DUBLIN, [RANELAGH], partial({ acPowerKw: 5, contributingSiteCount: 2 })),
        row(BRISTOL, [BRISTOL_SITE], partial({ acPowerKw: 3, contributingSiteCount: 1 })),
      ],
    });

    const points = pointsOf(await read(deps, [RANELAGH]));

    expect(points.map((point) => point.acPowerKw)).toEqual([5]);
    expect(points[0]?.contributingSiteCount).toBe(2);
    // An unexpected location is not a reason to fall back either: the fleet it is asked about is
    // complete, and the extra row is answered by ignoring it rather than by a fan-out.
    expect(siteReads).toEqual([]);
    expect(logged).toEqual([]);
  });

  it('expects nothing from a location whose every site is deactivated', async () => {
    // `listFleetSites` returns the fleet active *and* inactive, while ingestion publishes only for
    // locations holding an active site. Counting an all-inactive location as expected would pin the
    // route on `incomplete` for ever, logging a line that means the opposite of what it says.
    const { deps, siteReads, logged } = harness({
      rows: [row(DUBLIN, [RANELAGH], partial())],
    });

    await read(deps, [RANELAGH, { ...BRISTOL_SITE, active: false }]);

    expect(siteReads).toEqual([]);
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
    const { deps, siteReads, logged } = harness({
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
    expect(siteReads).toEqual([]);
    expect(logged).toEqual([]);
  });

  it('answers an empty fleet without reading anything at all', async () => {
    const { deps, rollupReads, siteReads, logged } = harness();

    expect(pointsOf(await read(deps, []))).toEqual([]);
    expect(rollupReads).toBe(0);
    expect(siteReads).toEqual([]);
    expect(logged).toEqual([]);
  });
});

/**
 * Membership and vintage (#602, ADR 0009's 2026-10-07 entry): a location that has written is
 * summed only if its slices were summed from the sites active there now, by one forecast run. Each
 * stale case below sums on the pre-#602 code — the location-set check alone passes every one.
 */
describe('a stale slice', () => {
  const NEWCOMER = fleetSite({ id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', name: 'Newcomer' });
  const ranelaghForecast = {
    [RANELAGH_ID]: [{ type: 'forecast' as const, forecast: forecast({ acPowerKw: 2.8 }) }],
  };

  const staleRead = async (rows: readonly FleetRollupRow[], sites: readonly FleetSite[]) => {
    const { deps, siteReads, logged } = harness({ rows, pointsBySite: ranelaghForecast });
    const points = pointsOf(await read(deps, sites));
    return { points, siteReads, logged };
  };

  it('falls back when a site at a surviving location has gone', async () => {
    // #579: the slice still carries the deleted site's kilowatts, count and capacity.
    const { points, siteReads, logged } = await staleRead(
      [row(DUBLIN, [RANELAGH, RATHMINES], partial({ acPowerKw: 5, contributingSiteCount: 2 }))],
      [RANELAGH],
    );

    expect(points.map((point) => [point.acPowerKw, point.contributingSiteCount])).toEqual([
      [2.8, 1],
    ]);
    expect(siteReads).toEqual([RANELAGH_ID]);
    expect(logged).toEqual([
      {
        event: fleetRollupFallbackEvent,
        reason: 'stale',
        expectedLocations: 1,
        presentLocations: 1,
        staleLocations: 1,
        hours: 1,
      },
    ]);
  });

  it('falls back when one site left and another joined the same bucket', async () => {
    // Same count, possibly the same capacity: only the membership itself tells these apart.
    const { logged } = await staleRead(
      [row(DUBLIN, [RANELAGH, RATHMINES])],
      [RANELAGH, { ...NEWCOMER, capacityKw: RATHMINES.capacityKw }],
    );

    expect(logged[0]).toMatchObject({ reason: 'stale', staleLocations: 1 });
  });

  it('falls back when a site’s physics were edited in place', async () => {
    // `PUT /v1/sites/{siteId}` keeps the id; the slice's capacity divisor and kilowatts do not move.
    const { logged } = await staleRead([row(DUBLIN, [RANELAGH])], [{ ...RANELAGH, capacityKw: 5 }]);

    expect(logged[0]).toMatchObject({ reason: 'stale', staleLocations: 1 });
  });

  it('falls back when one location’s slices come from two forecast runs', async () => {
    // A `store-partial` roll-up drain, or a replayed message, leaves part of the horizon on another run.
    const { logged } = await staleRead(
      [
        row(DUBLIN, [RANELAGH], partial(), ISSUED_AT),
        row(DUBLIN, [RANELAGH], partial({ validTime: '2026-07-31T14:00:00Z' }), EARLIER_RUN),
      ],
      [RANELAGH],
    );

    expect(logged[0]).toMatchObject({ reason: 'stale', staleLocations: 1, hours: 2 });
  });

  it('falls back on a slice written before provenance existed', async () => {
    const { logged } = await staleRead(
      [{ locationId: DUBLIN, provenance: undefined, partial: partial() }],
      [RANELAGH],
    );

    expect(logged[0]).toMatchObject({ reason: 'stale', staleLocations: 1 });
  });

  it('sums locations written by different runs, each from one run', async () => {
    // Fresh, and the case that keeps vintage per location: ingestion visits locations with no
    // end-of-run event, so a fleet-wide vintage test would fall back on every cycle (ADR 0009).
    const { deps, siteReads, logged } = harness({
      rows: [
        row(DUBLIN, [RANELAGH], partial({ acPowerKw: 5 }), ISSUED_AT),
        row(BRISTOL, [BRISTOL_SITE], partial({ acPowerKw: 3 }), EARLIER_RUN),
      ],
    });

    expect(pointsOf(await read(deps, [RANELAGH, BRISTOL_SITE])).map((p) => p.acPowerKw)).toEqual([
      8,
    ]);
    expect(siteReads).toEqual([]);
    expect(logged).toEqual([]);
  });
});

describe('the fallback', () => {
  it('reports an untouched partition as absent and aggregates the fan-out', async () => {
    const { deps, siteReads, logged } = harness({
      pointsBySite: {
        [RANELAGH_ID]: [
          // Readings share the partition with forecasts (ADR 0002); only one kind is this answer.
          generationPoint({ acPowerKw: 0.9 }),
          { type: 'forecast', forecast: forecast({ acPowerKw: 2.8 }) },
        ],
        [RATHMINES_ID]: [
          { type: 'forecast', forecast: forecast({ siteId: RATHMINES_ID, acPowerKw: 1.6 }) },
        ],
      },
    });

    const points = pointsOf(await read(deps, [RANELAGH, RATHMINES]));

    expect(points.map((point) => point.acPowerKw)).toEqual([4.4]);
    expect(points[0]?.contributingSiteCount).toBe(2);
    expect(siteReads).toEqual([RANELAGH_ID, RATHMINES_ID]);
    expect(logged).toEqual([
      {
        event: fleetRollupFallbackEvent,
        reason: 'absent',
        expectedLocations: 1,
        presentLocations: 0,
        staleLocations: 0,
        hours: 0,
      },
    ]);
  });

  it('reports a partition missing one location as incomplete, with the counts', async () => {
    // Eleven of twelve locations sums to a plausible-looking fleet with nothing visibly missing —
    // the missing site does not read as missing, it reads as less generation. So a partly-written
    // partition is treated exactly like an absent one.
    const { deps, siteReads, logged } = harness({
      rows: [row(DUBLIN, [RANELAGH], partial())],
    });

    await read(deps, [RANELAGH, BRISTOL_SITE]);

    expect(logged).toEqual([
      {
        event: fleetRollupFallbackEvent,
        reason: 'incomplete',
        expectedLocations: 2,
        presentLocations: 1,
        staleLocations: 0,
        hours: 1,
      },
    ]);
    expect(siteReads).toEqual([RANELAGH_ID, BRISTOL_SITE.id]);
  });

  it('reports a missing location as incomplete even when another is stale, and counts both', async () => {
    // Dublin's slice still sums Rathmines, which has gone; Bristol has not written at all.
    const { deps, logged } = harness({ rows: [row(DUBLIN, [RANELAGH, RATHMINES])] });

    await read(deps, [RANELAGH, BRISTOL_SITE]);

    expect(logged[0]).toMatchObject({ reason: 'incomplete', staleLocations: 1 });
  });

  it('treats a roll-up Query that stopped short as incomplete', async () => {
    // A read that ran out of page budget and a partition that was never fully written have
    // different causes and the same consequence for the answer, so they share an arm.
    const { deps, siteReads, logged } = harness({
      rows: [row(DUBLIN, [RANELAGH], partial())],
      rollupComplete: false,
    });

    await read(deps, [RANELAGH]);

    expect(logged[0]).toMatchObject({ event: fleetRollupFallbackEvent, reason: 'incomplete' });
    expect(siteReads).toEqual([RANELAGH_ID]);
  });

  it('sums one model only, so the two arms cannot answer differently', async () => {
    // The fan-out reads whatever the partition holds, an ML row for the same site-hour included;
    // the roll-up arm only ever sums the rolled-up model. Unfiltered, this arm would read 3.1 here
    // rather than 2.8 — not twice the fleet but the *other model's* fleet, this fixture's ML row
    // taking the `issuedAt` tie by being listed last. That a model wins is the point, rather than
    // which one does: `seriesSortKey` puts `FC#ml` before `FC#physics`, so an ascending Query hands
    // the tie to physics and production survives by sort-key luck (ADR 0009's 2026-10-05 entry).
    const physics = forecast({ acPowerKw: 2.8 });
    const { deps } = harness({
      pointsBySite: {
        [RANELAGH_ID]: [
          { type: 'forecast', forecast: physics },
          { type: 'forecast', forecast: { ...physics, model: 'ml' as const, acPowerKw: 3.1 } },
        ],
      },
    });

    const points = pointsOf(await read(deps, [RANELAGH]));

    expect(points.map((point) => point.acPowerKw)).toEqual([2.8]);
    expect(points[0]?.contributingSiteCount).toBe(1);
  });

  it('carries the per-hour capacity the percent view divides by', async () => {
    const { deps } = harness({
      pointsBySite: {
        [RANELAGH_ID]: [{ type: 'forecast', forecast: forecast({ acPowerKw: 2.8 }) }],
      },
    });

    // The fixture site's nameplate, evidenced from the site list rather than re-derived in the
    // browser from rows this route no longer sends.
    expect(pointsOf(await read(deps, [RANELAGH]))[0]?.contributingCapacityKw).toBe(
      RANELAGH.capacityKw,
    );
  });

  it('answers an unforecast fleet with no points rather than an hour of zeroes', async () => {
    const { deps, logged } = harness();

    expect(pointsOf(await read(deps, [RANELAGH]))).toEqual([]);
    expect(logged[0]).toMatchObject({ reason: 'absent' });
  });
});
