import {
  FLEET_ROLLUP_ACTUALS_KIND,
  TRAILING_ACTUALS_HOURS,
  fleetActualsAggregatePointSchema,
  fleetRollupMembers,
  fleetRollupPartialSchema,
  sumFleetActualsRollupPartials,
  type FleetActualsAggregatePoint,
  type SeriesKind,
  type UtcIsoTimestamp,
} from '@cumulo/shared';
import {
  SERIES_RETENTION_DAYS,
  type BatchWriteOutcome,
  type FleetRollupRow,
} from '@cumulo/storage';
import { describe, expect, it } from 'vitest';

import { consumeMessage } from './consume-message';
import {
  compactFleetActuals,
  compactionWindow,
  fleetActualsCompactionEvent,
  missingTotals,
  reportFleetActualsCompaction,
  type FleetActualsCompactionDeps,
} from './fleet-actuals-compaction';
import { fleetActualsRollupWriteEvent } from './fleet-rollup-write';
import {
  ISSUED_AT,
  deps as consumeDeps,
  emptyRecorder,
  reading,
  recordOf,
  rejectedWith,
} from './forecast-fixtures';
import { utcHoursBefore } from './simulate-actuals';

/** The fleet actuals compaction (#615): the module alone, then inside one message. */

const at = (instant: string): UtcIsoTimestamp =>
  fleetActualsAggregatePointSchema.shape.validTime.parse(instant);

const hour = (h: string): UtcIsoTimestamp => at(`2026-07-31T${h}:00:00Z`);

const SETTLED_END = hour('09');
const REACH = utcHoursBefore(SETTLED_END, SERIES_RETENTION_DAYS * 24);

const total = (validTime: UtcIsoTimestamp, acPowerKw: number): FleetActualsAggregatePoint =>
  fleetActualsAggregatePointSchema.parse({
    validTime,
    acPowerKw,
    contributingSiteCount: 2,
    contributingCapacityKw: 8,
  });

const slice = (
  locationId: string,
  validTime: UtcIsoTimestamp,
  acPowerKw: number,
): FleetRollupRow => ({
  locationId,
  provenance: { members: fleetRollupMembers([]), issuedAt: validTime },
  partial: fleetRollupPartialSchema.parse({
    validTime,
    acPowerKw,
    p10AcPowerKw: acPowerKw,
    p90AcPowerKw: acPowerKw,
    hasUncertainty: false,
    contributingSiteCount: 1,
    contributingCapacityKw: 4,
  }),
});

type EffectfulCall = 'queryLatestFleetActualsTotals' | 'queryFleetRollup' | 'putFleetActualsTotals';

interface HarnessInput {
  readonly latestTotals?: readonly FleetActualsAggregatePoint[];
  readonly slices?: readonly FleetRollupRow[];
  readonly putOutcome?: BatchWriteOutcome;
  readonly rejects?: EffectfulCall;
}

const harness = (input: HarnessInput = {}) => {
  const latestCalls: [UtcIsoTimestamp, UtcIsoTimestamp, number][] = [];
  const sliceWindows: [SeriesKind, UtcIsoTimestamp, UtcIsoTimestamp][] = [];
  const puts: FleetActualsAggregatePoint[][] = [];
  const entries: Record<string, unknown>[] = [];
  const rejectIf = <T>(call: EffectfulCall, answer: T): Promise<T> =>
    input.rejects === call ? rejectedWith<T>(new Error('throttled')) : Promise.resolve(answer);

  const deps: FleetActualsCompactionDeps = {
    series: {
      queryLatestFleetActualsTotals: (from, to, limit) => {
        latestCalls.push([from, to, limit]);
        return rejectIf('queryLatestFleetActualsTotals', [...(input.latestTotals ?? [])]);
      },
      queryFleetRollup: (kind, from, to) => {
        sliceWindows.push([kind, from, to]);
        return rejectIf('queryFleetRollup', { rows: [...(input.slices ?? [])], complete: true });
      },
      putFleetActualsTotals: (totals) => {
        puts.push([...totals]);
        return rejectIf('putFleetActualsTotals', input.putOutcome ?? { status: 'complete' });
      },
    },
    log: (entry) => {
      entries.push(entry);
    },
  };
  return { deps, latestCalls, sliceWindows, puts, entries };
};

describe('compactFleetActuals', () => {
  it('compacts the hours settled since the latest total and writes only those lacking one', async () => {
    const slices = [
      slice('a', hour('06'), 1),
      slice('b', hour('06'), 2),
      slice('a', hour('07'), 3),
      slice('b', hour('07'), 4),
      slice('a', hour('08'), 5),
      slice('b', hour('08'), 6),
    ];
    const summed = sumFleetActualsRollupPartials(slices.map((row) => row.partial));
    const { deps, latestCalls, sliceWindows, puts } = harness({
      latestTotals: [total(hour('07'), 5)],
      slices,
    });

    const outcome = await compactFleetActuals(deps, ISSUED_AT);

    expect(outcome).toEqual({ status: 'written', hourCount: 2 });
    expect(puts).toEqual([[summed[0], summed[2]]]);
    expect(sliceWindows).toEqual([[FLEET_ROLLUP_ACTUALS_KIND, hour('06'), hour('09')]]);
    expect(latestCalls).toEqual([[REACH, hour('09'), TRAILING_ACTUALS_HOURS]]);
  });

  it('backfills from the retention reach when no total exists', async () => {
    const { deps, sliceWindows, puts } = harness({
      slices: [slice('a', hour('06'), 1), slice('a', hour('07'), 2)],
    });

    const outcome = await compactFleetActuals(deps, ISSUED_AT);

    expect(sliceWindows[0]?.[1]).toBe(REACH);
    expect(outcome).toEqual({ status: 'written', hourCount: 2 });
    expect(puts[0]?.map((point) => point.validTime)).toEqual([hour('06'), hour('07')]);
  });

  it('catches up every settled hour after a stale latest total', async () => {
    const { deps, sliceWindows, puts } = harness({
      latestTotals: [total(at('2026-07-20T10:00:00Z'), 1)],
      slices: [slice('a', at('2026-07-20T11:00:00Z'), 1), slice('a', hour('08'), 2)],
    });

    await compactFleetActuals(deps, ISSUED_AT);

    expect(sliceWindows[0]?.[1]).toBe(at('2026-07-20T11:00:00Z'));
    expect(puts[0]).toHaveLength(2);
  });

  it('writes nothing when every settled hour already has its total', async () => {
    const { deps, puts } = harness({
      latestTotals: [total(hour('08'), 1), total(hour('07'), 1), total(hour('06'), 1)],
      slices: [slice('a', hour('06'), 1), slice('a', hour('07'), 1), slice('a', hour('08'), 1)],
    });

    const outcome = await compactFleetActuals(deps, ISSUED_AT);

    expect(outcome).toEqual({ status: 'nothing-to-compact' });
    expect(puts).toEqual([]);
  });

  it('reports a partial drain with its count', async () => {
    const { deps } = harness({
      slices: [slice('a', hour('06'), 1)],
      putOutcome: { status: 'partial', unprocessedCount: 1 },
    });

    await expect(compactFleetActuals(deps, ISSUED_AT)).resolves.toEqual({
      status: 'store-partial',
      unprocessedCount: 1,
    });
  });

  it.each<EffectfulCall>([
    'queryLatestFleetActualsTotals',
    'queryFleetRollup',
    'putFleetActualsTotals',
  ])('turns a rejected %s into a failed outcome naming it', async (rejects) => {
    const { deps } = harness({ slices: [slice('a', hour('06'), 1)], rejects });

    const outcome = await compactFleetActuals(deps, ISSUED_AT);

    expect(outcome.status).toBe('failed');
    expect('detail' in outcome ? outcome.detail : '').toMatch(new RegExp(`^${rejects} threw`, 'u'));
  });

  it('logs the outcome under the event an operator greps for', async () => {
    const { deps, entries } = harness();

    await reportFleetActualsCompaction(deps, ISSUED_AT);

    expect(entries).toEqual([{ event: fleetActualsCompactionEvent, status: 'nothing-to-compact' }]);
  });
});

describe('compactionWindow', () => {
  it('re-checks the last settled hours even when the latest total is newer', () => {
    expect(compactionWindow(hour('09'), REACH, hour('08'))).toEqual({
      startInclusive: hour('06'),
      endExclusive: hour('09'),
    });
  });

  it('resumes at the hour after a latest total older than the re-check span', () => {
    expect(compactionWindow(hour('09'), REACH, hour('02'))).toEqual({
      startInclusive: hour('03'),
      endExclusive: hour('09'),
    });
  });
});

describe('missingTotals', () => {
  it('keeps the points whose hour has no existing total', () => {
    expect(
      missingTotals([total(hour('06'), 1), total(hour('07'), 2)], [total(hour('07'), 9)]),
    ).toEqual([total(hour('06'), 1)]);
  });
});

describe('inside one message', () => {
  it('runs after the slices and never fails the record', async () => {
    const recorder = emptyRecorder();

    const outcome = await consumeMessage(
      consumeDeps({
        recorder,
        fleetSlices: [slice('a', hour('06'), 1), slice('a', hour('07'), 2)],
      }),
      recordOf('m-1', [reading()]),
    );

    const events = recorder.entries.map((entry) => entry.event);
    expect(outcome.status).toBe('stored');
    expect(recorder.compacted.map((puts) => puts.map((point) => point.validTime))).toEqual([
      [hour('06'), hour('07')],
    ]);
    expect(events.indexOf(fleetActualsCompactionEvent)).toBeGreaterThan(
      events.indexOf(fleetActualsRollupWriteEvent),
    );
  });

  it('reports a throttled compaction as failed while the record stays stored', async () => {
    const recorder = emptyRecorder();

    const outcome = await consumeMessage(
      consumeDeps({ recorder, compactionRejectsWith: new Error('throttled') }),
      recordOf('m-1', [reading()]),
    );

    expect(outcome.status).toBe('stored');
    expect(
      recorder.entries.find((entry) => entry.event === fleetActualsCompactionEvent),
    ).toMatchObject({
      status: 'failed',
    });
  });
});
