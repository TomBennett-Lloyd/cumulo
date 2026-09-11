import {
  FLEET_ROLLUP_FORECAST_KIND,
  fleetForecastAggregate,
  forecastSchema,
  sumFleetRollupPartials,
  type FleetRollupPartial,
  type Forecast,
  type SeriesKind,
  type SiteCapacity,
} from '@cumulo/shared';
import type { BatchWriteOutcome } from '@cumulo/storage';
import { describe, expect, it } from 'vitest';

import { consumeMessage } from './consume-message';
import {
  ISSUED_AT,
  RANELAGH_ID,
  RATHMINES_ID,
  deps,
  emptyRecorder,
  reading,
  recordOf,
  rejectedWith,
  sitePhysics,
} from './forecast-fixtures';
import {
  fleetRollupWriteEvent,
  reportFleetRollupWrite,
  writeFleetRollup,
  type FleetRollupWriteDeps,
} from './fleet-rollup-write';

/**
 * The producer's half of ADR 0009, tested at two altitudes: the module on its own, and — for the
 * one claim only the caller can make good — through `consumeMessage`.
 *
 * The claim that needs the second altitude is the failure policy. "A roll-up that cannot be written
 * does not fail the record" is a statement about what `consumeMessage` returns, and a unit test of
 * this module can only show that it returns a `failed` *outcome value*; whether that value then
 * fails a record is the caller's doing. So that one is exercised end to end.
 */

interface WriteCall {
  readonly kind: SeriesKind;
  readonly locationId: string;
  readonly partials: readonly FleetRollupPartial[];
}

interface Harness {
  readonly deps: FleetRollupWriteDeps;
  readonly calls: WriteCall[];
  readonly entries: Record<string, unknown>[];
}

const harness = (input: { outcome?: BatchWriteOutcome; rejectsWith?: unknown } = {}): Harness => {
  const calls: WriteCall[] = [];
  const entries: Record<string, unknown>[] = [];

  return {
    calls,
    entries,
    deps: {
      series: {
        putFleetRollupPartials: (kind, locationId, partials): Promise<BatchWriteOutcome> => {
          if (input.rejectsWith !== undefined) {
            return rejectedWith(input.rejectsWith);
          }
          calls.push({ kind, locationId, partials: [...partials] });
          return Promise.resolve(input.outcome ?? { status: 'complete' });
        },
      },
      log: (entry) => {
        entries.push(entry);
      },
    },
  };
};

const LOCATION = '53.32,-6.26';

const sites: readonly SiteCapacity[] = [
  { id: RANELAGH_ID, capacityKw: 4.2 },
  { id: RATHMINES_ID, capacityKw: 6 },
];

const forecastAt = (siteId: string, hour: string, acPowerKw: number): Forecast =>
  forecastSchema.parse({
    siteId,
    model: 'physics',
    validTime: `2026-07-31T${hour}:00:00Z`,
    issuedAt: ISSUED_AT,
    weatherSource: 'open-meteo',
    poaIrradianceWm2: 600,
    acPowerKw,
    uncertainty: { p10AcPowerKw: acPowerKw * 0.8, p90AcPowerKw: acPowerKw * 1.2 },
  });

const twoSitesTwoHours: readonly Forecast[] = [
  forecastAt(RANELAGH_ID, '11', 3),
  forecastAt(RATHMINES_ID, '11', 4),
  forecastAt(RANELAGH_ID, '12', 3.5),
  forecastAt(RATHMINES_ID, '12', 4.5),
];

describe('writeFleetRollup', () => {
  it('writes one partial per hour, summed over the location`s sites', async () => {
    const { deps: rollupDeps, calls } = harness();

    const outcome = await writeFleetRollup(rollupDeps, LOCATION, twoSitesTwoHours, sites);

    expect(outcome).toEqual({ locationId: LOCATION, status: 'written', hourCount: 2 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.locationId).toBe(LOCATION);
    expect(calls[0]?.kind).toEqual(FLEET_ROLLUP_FORECAST_KIND);
    expect(calls[0]?.partials.map((partial) => partial.acPowerKw)).toEqual([7, 8]);
    expect(calls[0]?.partials.map((partial) => partial.contributingSiteCount)).toEqual([2, 2]);
    expect(calls[0]?.partials.map((partial) => partial.contributingCapacityKw)).toEqual([
      10.2, 10.2,
    ]);
  });

  it('writes exactly what the read will sum back — the additivity claim, at this boundary', async () => {
    const { deps: rollupDeps, calls } = harness();

    await writeFleetRollup(rollupDeps, LOCATION, twoSitesTwoHours, sites);

    // One location is the whole fleet in this fixture, so summing its partials must reproduce the
    // aggregate computed straight from the raw forecasts. The general case — many locations — is
    // `packages/shared/src/fleet-rollup-additivity.test.ts`; this pins that the *producer* feeds
    // that machinery the same inputs it was proved over.
    expect(sumFleetRollupPartials(calls[0]?.partials ?? [])).toEqual(
      fleetForecastAggregate(twoSitesTwoHours, sites),
    );
  });

  it('rolls up one model only, so a second model cannot double-count the fleet', async () => {
    const { deps: rollupDeps, calls } = harness();
    const withMl = [
      ...twoSitesTwoHours,
      { ...forecastAt(RANELAGH_ID, '11', 3.1), model: 'ml' as const },
    ];

    await writeFleetRollup(rollupDeps, LOCATION, withMl, sites);

    // 7 kW, not 10.1: the ML row for the same site-hour is a second view of it, not a second site.
    expect(calls[0]?.partials[0]?.acPowerKw).toBe(7);
    expect(calls[0]?.partials[0]?.contributingSiteCount).toBe(2);
  });

  it('reports a location with nothing of the rolled-up model as a distinct success', async () => {
    const { deps: rollupDeps, calls } = harness();
    const mlOnly = twoSitesTwoHours.map((forecast) => ({ ...forecast, model: 'ml' as const }));

    const outcome = await writeFleetRollup(rollupDeps, LOCATION, mlOnly, sites);

    expect(outcome).toEqual({ locationId: LOCATION, status: 'nothing-to-roll-up' });
    expect(calls).toEqual([]);
  });

  it('writes nothing for an empty horizon rather than an empty batch', async () => {
    const { deps: rollupDeps, calls } = harness();

    expect(await writeFleetRollup(rollupDeps, LOCATION, [], sites)).toEqual({
      locationId: LOCATION,
      status: 'nothing-to-roll-up',
    });
    expect(calls).toEqual([]);
  });

  it('reports an incomplete drain as store-partial, with the count', async () => {
    const { deps: rollupDeps } = harness({
      outcome: { status: 'partial', unprocessedCount: 5 },
    });

    expect(await writeFleetRollup(rollupDeps, LOCATION, twoSitesTwoHours, sites)).toEqual({
      locationId: LOCATION,
      status: 'store-partial',
      unprocessedCount: 5,
    });
  });

  it('converts a rejected write into a failed outcome naming the operation', async () => {
    const { deps: rollupDeps } = harness({ rejectsWith: new Error('the table said no') });

    const outcome = await writeFleetRollup(rollupDeps, LOCATION, twoSitesTwoHours, sites);

    // Narrowed rather than matched loosely: `toMatchObject` with a matcher types as `any`, which
    // would let a wrong-shaped outcome through the assertion that is checking its shape.
    if (outcome.status !== 'failed') {
      throw new Error(`expected a failed outcome, got '${outcome.status}'`);
    }
    expect(outcome.detail).toContain('putFleetRollupPartials threw');
  });

  it('is deterministic in its inputs, so a redelivered message writes identical partials', async () => {
    const { deps: rollupDeps, calls } = harness();

    await writeFleetRollup(rollupDeps, LOCATION, twoSitesTwoHours, sites);
    await writeFleetRollup(rollupDeps, LOCATION, twoSitesTwoHours, sites);

    expect(calls[0]?.partials).toEqual(calls[1]?.partials);
  });

  it('does not assert capacity it cannot evidence', async () => {
    const { deps: rollupDeps, calls } = harness();

    // A forecast for a site the caller did not list: `contributingCapacityKwByHour`'s rule is that
    // unevidenced capacity contributes zero, and the divisor the `%` view reads must inherit it
    // rather than being inflated by a guess.
    await writeFleetRollup(
      rollupDeps,
      LOCATION,
      [forecastAt(RANELAGH_ID, '11', 3)],
      [{ id: RATHMINES_ID, capacityKw: 6 }],
    );

    expect(calls[0]?.partials[0]?.contributingCapacityKw).toBe(0);
  });
});

describe('reportFleetRollupWrite', () => {
  it('logs one greppable entry carrying the outcome', async () => {
    const { deps: rollupDeps, entries } = harness();

    await reportFleetRollupWrite(rollupDeps, LOCATION, twoSitesTwoHours, sites);

    expect(entries).toEqual([
      {
        event: fleetRollupWriteEvent,
        locationId: LOCATION,
        status: 'written',
        hourCount: 2,
      },
    ]);
  });

  it('logs a failure rather than rejecting', async () => {
    const { deps: rollupDeps, entries } = harness({ rejectsWith: 'the table is on fire' });

    await expect(
      reportFleetRollupWrite(rollupDeps, LOCATION, twoSitesTwoHours, sites),
    ).resolves.toBeUndefined();
    expect(entries[0]).toMatchObject({ event: fleetRollupWriteEvent, status: 'failed' });
  });
});

describe('the roll-up inside one message', () => {
  it('rolls the location up once the forecasts are stored', async () => {
    const recorder = emptyRecorder();

    await consumeMessage(
      deps({ recorder, sites: [sitePhysics(), sitePhysics({ id: RATHMINES_ID })] }),
      recordOf('m-1', [reading({ validTime: '2026-07-31T11:00:00Z' }), reading()]),
    );

    expect(recorder.rolledUp).toEqual([{ locationId: '53.32,-6.26', hourCount: 2 }]);
  });

  it('leaves the message stored when the roll-up write throws', async () => {
    const recorder = emptyRecorder();

    const outcome = await consumeMessage(
      deps({ recorder, rollupRejectsWith: new Error('the table said no') }),
      recordOf('m-1', [reading()]),
    );

    // The forecasts are the message's work and they landed. Failing the record here would
    // redeliver a whole location's horizon to retry a derived write the next cycle rewrites anyway.
    expect(outcome).toEqual({
      messageId: 'm-1',
      status: 'stored',
      siteCount: 1,
      forecastCount: 1,
    });
    expect(recorder.entries.at(-1)).toMatchObject({
      event: fleetRollupWriteEvent,
      status: 'failed',
    });
  });

  it('does not roll up a location whose sites were all deactivated', async () => {
    const recorder = emptyRecorder();

    await consumeMessage(deps({ recorder, sites: [] }), recordOf('m-1', [reading()]));

    expect(recorder.rolledUp).toEqual([]);
  });
});
