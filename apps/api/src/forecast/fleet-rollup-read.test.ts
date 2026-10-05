import {
  fleetRollupPartialSchema,
  utcIsoTimestampSchema,
  type FleetRollupPartial,
  type FleetSite,
} from '@cumulo/shared';
import type { FleetRollupRow, SeriesPoint } from '@cumulo/storage';
import { describe, expect, it } from 'vitest';

import {
  fleetSite,
  forecast,
  fullBudgetDeadline,
  generationPoint,
  RANELAGH_ID,
  RATHMINES_ID,
} from '../api-fixtures';

import {
  fleetRollupFallbackEvent,
  readFleetForecastAggregate,
  type FleetForecastAggregateRead,
  type FleetRollupReadDeps,
} from './fleet-rollup-read';

/**
 * Which partition states answer from the roll-up and which fall back — the decision ADR 0009's
 * fallback *is*, tested where it lives rather than through the route.
 *
 * Through `readFleetForecastAggregate` directly because the route adds nothing to this question: it
 * chooses a window and parses an envelope, and `get-fleet-forecast.test.ts` owns both. What matters
 * here is that a partition missing a whole *location* is never summed — the dimension the check
 * works in, and the one ADR 0009's 2026-10-05 amendment entry records it as working in — and that
 * every fallback leaves one line an operator can count while a deployment settles.
 */

const FROM = utcIsoTimestampSchema.parse('2026-07-31T12:00:00Z');
const TO = utcIsoTimestampSchema.parse('2026-08-02T12:00:00Z');
const DEADLINE_EVENT = 'api.fleet-forecast.read-deadline-reached';

const RANELAGH = fleetSite();
const RATHMINES = fleetSite({ id: RATHMINES_ID, name: 'Rathmines terrace' });
/** Both Dublin fixtures round into one weather bucket — the unit the producer writes a partial for. */
const DUBLIN = '53.32,-6.26';

const BRISTOL = '51.45,-2.59';
const BRISTOL_SITE = fleetSite({
  id: '7c9e6679-7425-40de-944b-e07fc1f90111',
  name: 'Bristol terrace',
  latitude: 51.4545,
  longitude: -2.5879,
});

const partial = (
  overrides: Partial<Record<keyof FleetRollupPartial, unknown>> = {},
): FleetRollupPartial =>
  fleetRollupPartialSchema.parse({
    validTime: '2026-07-31T13:00:00Z',
    acPowerKw: 5,
    p10AcPowerKw: 4,
    p90AcPowerKw: 6,
    hasUncertainty: true,
    contributingSiteCount: 2,
    contributingCapacityKw: 8.4,
    ...overrides,
  });

interface Harness {
  readonly deps: FleetRollupReadDeps;
  readonly rollupReads: number;
  readonly siteReads: string[];
  readonly logged: Record<string, unknown>[];
}

interface HarnessInput {
  readonly rows?: readonly FleetRollupRow[];
  readonly rollupComplete?: boolean;
  readonly pointsBySite?: Readonly<Record<string, readonly SeriesPoint[]>>;
}

const harness = (input: HarnessInput = {}): Harness => {
  const siteReads: string[] = [];
  const logged: Record<string, unknown>[] = [];
  const state = { rollupReads: 0 };

  return {
    siteReads,
    logged,
    get rollupReads(): number {
      return state.rollupReads;
    },
    deps: {
      series: {
        queryFleetRollup: () => {
          state.rollupReads += 1;
          return Promise.resolve({
            rows: [...(input.rows ?? [])],
            complete: input.rollupComplete ?? true,
          });
        },
        querySeriesRange: (siteId) => {
          siteReads.push(siteId);
          return Promise.resolve({
            points: [...(input.pointsBySite?.[siteId] ?? [])],
            complete: true,
          });
        },
      },
      log: (entry) => logged.push(entry),
    },
  };
};

const read = async (
  deps: FleetRollupReadDeps,
  sites: readonly FleetSite[],
): Promise<FleetForecastAggregateRead> =>
  readFleetForecastAggregate(deps, fullBudgetDeadline, sites, FROM, TO, DEADLINE_EVENT);

const pointsOf = (result: FleetForecastAggregateRead) => {
  if (!result.complete) {
    throw new Error('expected a complete read');
  }
  return result.points;
};

describe('the roll-up answers', () => {
  it('sums the partition when every expected location has written', async () => {
    const { deps, siteReads, logged } = harness({
      rows: [
        { locationId: DUBLIN, partial: partial({ acPowerKw: 5 }) },
        { locationId: BRISTOL, partial: partial({ acPowerKw: 3 }) },
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
    const { deps, siteReads } = harness({ rows: [{ locationId: DUBLIN, partial: partial() }] });

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
        { locationId: DUBLIN, partial: partial({ acPowerKw: 5, contributingSiteCount: 2 }) },
        { locationId: BRISTOL, partial: partial({ acPowerKw: 3, contributingSiteCount: 1 }) },
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
      rows: [{ locationId: DUBLIN, partial: partial() }],
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
        { locationId: DUBLIN, partial: partial({ acPowerKw: 5, contributingSiteCount: 2 }) },
        {
          locationId: DUBLIN,
          partial: partial({ validTime: twoPm, acPowerKw: 6, contributingSiteCount: 2 }),
        },
        { locationId: BRISTOL, partial: partial({ acPowerKw: 3, contributingSiteCount: 1 }) },
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
        hours: 0,
      },
    ]);
  });

  it('reports a partition missing one location as incomplete, with the counts', async () => {
    // Eleven of twelve locations sums to a plausible-looking fleet with nothing visibly missing —
    // the missing site does not read as missing, it reads as less generation. So a partly-written
    // partition is treated exactly like an absent one.
    const { deps, siteReads, logged } = harness({
      rows: [{ locationId: DUBLIN, partial: partial() }],
    });

    await read(deps, [RANELAGH, BRISTOL_SITE]);

    expect(logged).toEqual([
      {
        event: fleetRollupFallbackEvent,
        reason: 'incomplete',
        expectedLocations: 2,
        presentLocations: 1,
        hours: 1,
      },
    ]);
    expect(siteReads).toEqual([RANELAGH_ID, BRISTOL_SITE.id]);
  });

  it('treats a roll-up Query that stopped short as incomplete', async () => {
    // A read that ran out of page budget and a partition that was never fully written have
    // different causes and the same consequence for the answer, so they share an arm.
    const { deps, siteReads, logged } = harness({
      rows: [{ locationId: DUBLIN, partial: partial() }],
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
    // taking the `issuedAt` tie by being listed last. Which model wins is the point rather than
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
