import {
  FLEET_ROLLUP_ACTUALS_KIND,
  FLEET_ROLLUP_FORECAST_KIND,
  fleetActualsRollupPartials,
  fleetRollupMembers,
  forecastSchema,
  generationReadingSchema,
  type FleetRollupPartial,
  type GenerationReading,
  type SeriesKind,
  type SitePhysics,
} from '@cumulo/shared';
import type { BatchWriteOutcome, SeriesPoint } from '@cumulo/storage';
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
  sitePhysics,
} from './forecast-fixtures';
import {
  fleetActualsRollupWriteEvent,
  reportFleetActualsRollupWrite,
  writeFleetActualsRollup,
  type FleetRollupWriteDeps,
} from './fleet-rollup-write';

/** The actuals half of the producer (#506): the module alone, then inside one message. */

const LOCATION = '53.32,-6.26';

const sites: readonly SitePhysics[] = [
  sitePhysics({ id: RANELAGH_ID, capacityKw: 4.2 }),
  sitePhysics({ id: RATHMINES_ID, capacityKw: 6 }),
];

const readingAt = (siteId: string, hour: string, acPowerKw: number): GenerationReading =>
  generationReadingSchema.parse({ siteId, validTime: `2026-07-31T${hour}:00:00Z`, acPowerKw });

const settled: readonly GenerationReading[] = [
  readingAt(RANELAGH_ID, '10', 2),
  readingAt(RATHMINES_ID, '10', 3),
  readingAt(RANELAGH_ID, '11', 2.5),
];

interface WriteCall {
  readonly kind: SeriesKind;
  readonly partials: readonly FleetRollupPartial[];
}

const harness = (
  outcome: BatchWriteOutcome = { status: 'complete' },
): {
  readonly deps: FleetRollupWriteDeps;
  readonly calls: WriteCall[];
  readonly entries: Record<string, unknown>[];
} => {
  const calls: WriteCall[] = [];
  const entries: Record<string, unknown>[] = [];
  return {
    calls,
    entries,
    deps: {
      series: {
        putFleetRollupPartials: (kind, _locationId, _provenance, partials) => {
          calls.push({ kind, partials: [...partials] });
          return Promise.resolve(outcome);
        },
      },
      log: (entry) => entries.push(entry),
    },
  };
};

describe('writeFleetActualsRollup', () => {
  it('writes the settled hours under the actuals kind, summed by the shared arithmetic', async () => {
    const { deps: rollupDeps, calls } = harness();

    const outcome = await writeFleetActualsRollup(rollupDeps, LOCATION, ISSUED_AT, settled, sites);

    expect(outcome).toEqual({ locationId: LOCATION, status: 'written', hourCount: 2 });
    expect(calls).toEqual([
      { kind: FLEET_ROLLUP_ACTUALS_KIND, partials: fleetActualsRollupPartials(settled, sites) },
    ]);
  });

  it('writes nothing when a site’s window is unknown, and says so', async () => {
    const { deps: rollupDeps, calls } = harness();

    const outcome = await writeFleetActualsRollup(
      rollupDeps,
      LOCATION,
      ISSUED_AT,
      undefined,
      sites,
    );

    expect(outcome).toEqual({ locationId: LOCATION, status: 'inputs-incomplete' });
    expect(calls).toEqual([]);
  });

  it('writes nothing for a window that holds no readings', async () => {
    const { deps: rollupDeps, calls } = harness();

    expect(await writeFleetActualsRollup(rollupDeps, LOCATION, ISSUED_AT, [], sites)).toEqual({
      locationId: LOCATION,
      status: 'nothing-to-roll-up',
    });
    expect(calls).toEqual([]);
  });

  it('reports a partial drain with its count', async () => {
    const { deps: rollupDeps } = harness({ status: 'partial', unprocessedCount: 1 });

    expect(await writeFleetActualsRollup(rollupDeps, LOCATION, ISSUED_AT, settled, sites)).toEqual({
      locationId: LOCATION,
      status: 'store-partial',
      unprocessedCount: 1,
    });
  });
});

describe('reportFleetActualsRollupWrite', () => {
  it('logs one entry under its own event', async () => {
    const { deps: rollupDeps, entries } = harness();

    await reportFleetActualsRollupWrite(rollupDeps, LOCATION, ISSUED_AT, settled, sites);

    expect(entries).toEqual([
      {
        event: fleetActualsRollupWriteEvent,
        locationId: LOCATION,
        status: 'written',
        hourCount: 2,
      },
    ]);
  });
});

describe('the actuals roll-up inside one message', () => {
  const trailingForecast = forecastSchema.parse({
    siteId: RANELAGH_ID,
    model: 'physics',
    validTime: '2026-07-31T10:00:00Z',
    issuedAt: ISSUED_AT,
    weatherSource: 'open-meteo',
    poaIrradianceWm2: 600,
    acPowerKw: 2,
  });
  const storedReading = readingAt(RATHMINES_ID, '09', 3);
  const trailingPointsBySite: Record<string, readonly SeriesPoint[]> = {
    [RANELAGH_ID]: [{ type: 'forecast', forecast: trailingForecast }],
    [RATHMINES_ID]: [{ type: 'generation', reading: storedReading }],
  };
  const bothSites = [sitePhysics(), sitePhysics({ id: RATHMINES_ID })];

  it('rolls up the readings the simulation wrote and those it found, stamped like the forecast', async () => {
    const recorder = emptyRecorder();

    await consumeMessage(
      deps({ recorder, sites: bothSites, trailingPointsBySite }),
      recordOf('m-1', [reading()]),
    );

    expect(recorder.rolledUp.filter((call) => call.kind.kind === 'generation')).toEqual([
      {
        kind: FLEET_ROLLUP_ACTUALS_KIND,
        locationId: LOCATION,
        provenance: { members: fleetRollupMembers(bothSites), issuedAt: ISSUED_AT },
        // 09:00 was stored before the run and 10:00 was written by it: dropping either is one hour.
        hourCount: 2,
      },
    ]);
    expect(recorder.rolledUp.map((call) => call.kind)).toEqual([
      FLEET_ROLLUP_FORECAST_KIND,
      FLEET_ROLLUP_ACTUALS_KIND,
    ]);
  });

  it('writes no actuals slice when a trailing read failed, and leaves the message stored', async () => {
    const recorder = emptyRecorder();

    const outcome = await consumeMessage(
      deps({ recorder, trailingRejectsWith: new Error('throttled') }),
      recordOf('m-1', [reading()]),
    );

    expect(outcome.status).toBe('stored');
    expect(recorder.rolledUp.map((call) => call.kind)).toEqual([FLEET_ROLLUP_FORECAST_KIND]);
    expect(
      recorder.entries.find((entry) => entry.event === fleetActualsRollupWriteEvent),
    ).toMatchObject({ status: 'inputs-incomplete' });
  });
});
