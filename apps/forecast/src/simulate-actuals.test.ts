import {
  forecastSchema,
  generationReadingSchema,
  simulatedActualFromForecast,
  utcIsoTimestampSchema,
  type Forecast,
  type ForecastModel,
  type GenerationReading,
  type UtcIsoTimestamp,
} from '@cumulo/shared';
import type { BatchWriteOutcome, SeriesPoint, SeriesRangeResult } from '@cumulo/storage';
import { describe, expect, it } from 'vitest';

import { RANELAGH_ID, RATHMINES_ID, rejectedWith } from './forecast-fixtures';
import {
  TRAILING_ACTUALS_HOURS,
  planSimulatedActuals,
  simulateTrailingActuals,
  simulatedActualsOutcomeEvent,
  utcHoursBefore,
  type SimulateActualsDeps,
  type SiteActualsOutcome,
} from './simulate-actuals';

/**
 * The trailing simulated-actuals producer, exercised through its three exported surfaces: the
 * window arithmetic, the pure plan, and the run that reads, plans and writes.
 *
 * The plan gets the dense tests (`docs/standards/testing.md` rule 2) because it holds every
 * decision — which model, which hours, which hours are already taken. The run's tests are about
 * conversion only: which adapter answer becomes which outcome, and that one site's failure does
 * not take its siblings with it.
 */

/** The run's clock. Every window in this file is the `TRAILING_ACTUALS_HOURS` ending here. */
const NOW: UtcIsoTimestamp = utcIsoTimestampSchema.parse('2026-07-31T12:00:00Z');

const at = (hour: string): UtcIsoTimestamp => utcIsoTimestampSchema.parse(`2026-07-31T${hour}Z`);

interface ForecastFixture {
  readonly siteId?: string;
  readonly validTime?: UtcIsoTimestamp;
  readonly model?: ForecastModel;
  readonly acPowerKw?: number;
}

const aForecast = ({
  siteId = RANELAGH_ID,
  validTime = at('11:00:00'),
  model = 'physics',
  acPowerKw = 2.4,
}: ForecastFixture = {}): Forecast =>
  forecastSchema.parse({
    siteId,
    model,
    validTime,
    issuedAt: '2026-07-31T10:00:00Z',
    weatherSource: 'open-meteo',
    poaIrradianceWm2: 480.5,
    acPowerKw,
  });

const forecastPoint = (fixture: ForecastFixture = {}): SeriesPoint => ({
  type: 'forecast',
  forecast: aForecast(fixture),
});

const generationPoint = (validTime: UtcIsoTimestamp, siteId = RANELAGH_ID): SeriesPoint => ({
  type: 'generation',
  reading: generationReadingSchema.parse({ siteId, validTime, acPowerKw: 1.9 }),
});

/** What the doubles saw, so a test asserts on reads and writes without a spy framework. */
interface Recorder {
  readonly windows: { readonly siteId: string; readonly from: string; readonly to: string }[];
  readonly written: GenerationReading[][];
  readonly entries: Record<string, unknown>[];
}

const emptyRecorder = (): Recorder => ({ windows: [], written: [], entries: [] });

interface DepsInput {
  readonly recorder: Recorder;
  /** The window each site's query answers with, by site id; missing means an empty window. */
  readonly pointsBySite?: Readonly<Record<string, readonly SeriesPoint[]>>;
  /** Site ids whose query rejects instead of answering. */
  readonly queryRejectsFor?: readonly string[];
  /** What the generation write answers with; defaults to a complete drain. */
  readonly storeOutcome?: BatchWriteOutcome;
  /** Rejected by the generation write instead of answering. */
  readonly storeRejectsWith?: unknown;
}

const deps = (input: DepsInput): SimulateActualsDeps => ({
  series: {
    querySeriesRange: (siteId, fromInclusive, toExclusive): Promise<SeriesRangeResult> => {
      input.recorder.windows.push({ siteId, from: fromInclusive, to: toExclusive });
      if (input.queryRejectsFor?.includes(siteId) === true) {
        return rejectedWith(new Error('the table said no'));
      }
      return Promise.resolve({ points: [...(input.pointsBySite?.[siteId] ?? [])], complete: true });
    },
    putGenerationReadings: (readings): Promise<BatchWriteOutcome> => {
      if (input.storeRejectsWith !== undefined) {
        return rejectedWith(input.storeRejectsWith);
      }
      input.recorder.written.push([...readings]);
      return Promise.resolve(input.storeOutcome ?? { status: 'complete' });
    },
  },
  log: (entry) => {
    input.recorder.entries.push(entry);
  },
  now: (): UtcIsoTimestamp => NOW,
});

/** The outcome for one site, or a failure naming what came back instead of it. */
const outcomeFor = (
  outcomes: readonly SiteActualsOutcome[],
  siteId: string,
): SiteActualsOutcome => {
  const found = outcomes.find((outcome) => outcome.siteId === siteId);
  if (found === undefined) {
    throw new Error(`no outcome for site ${siteId} in ${JSON.stringify(outcomes)}`);
  }
  return found;
};

/**
 * The `detail` of a failed outcome. A typed narrowing rather than a `stringContaining` matcher
 * inside an object assertion, which types as `any` and would let a wrong-shaped outcome pass.
 */
const detailOf = (outcome: SiteActualsOutcome): string => {
  if (outcome.status !== 'failed') {
    throw new Error(`expected a failed outcome, got '${outcome.status}'`);
  }
  return outcome.detail;
};

describe('utcHoursBefore', () => {
  it('subtracts whole hours and keeps the fixed-width form the range queries rely on', () => {
    expect(utcHoursBefore(NOW, TRAILING_ACTUALS_HOURS)).toBe('2026-07-31T09:00:00Z');
  });

  it('carries the subtraction across a date boundary rather than clamping at midnight', () => {
    expect(utcHoursBefore(at('01:00:00'), 3)).toBe('2026-07-30T22:00:00Z');
  });
});

describe('planning a site’s missing actuals', () => {
  it('plans one simulated actual per settled physics-forecast hour', () => {
    const planned = planSimulatedActuals(
      [forecastPoint({ validTime: at('10:00:00') }), forecastPoint({ validTime: at('11:00:00') })],
      NOW,
    );

    expect(planned.map((reading) => reading.validTime)).toEqual([
      '2026-07-31T10:00:00Z',
      '2026-07-31T11:00:00Z',
    ]);
  });

  it('plans only physics-model hours, so the ML error metric measures the model', () => {
    const planned = planSimulatedActuals(
      [
        forecastPoint({ validTime: at('11:00:00'), model: 'ml' }),
        forecastPoint({ validTime: at('10:00:00'), model: 'physics' }),
      ],
      NOW,
    );

    expect(planned.map((reading) => reading.validTime)).toEqual(['2026-07-31T10:00:00Z']);
  });

  it('plans no simulated actual for an hour still in the future', () => {
    // `validTime` is hour-ending: the hour ending at 13:00 has not happened at 12:00, and nothing
    // that has not happened has an actual to simulate.
    const planned = planSimulatedActuals([forecastPoint({ validTime: at('13:00:00') })], NOW);

    expect(planned).toEqual([]);
  });

  it('plans the hour ending exactly now — an hour-ending instant that has arrived is settled', () => {
    const planned = planSimulatedActuals([forecastPoint({ validTime: NOW })], NOW);

    expect(planned.map((reading) => reading.validTime)).toEqual(['2026-07-31T12:00:00Z']);
  });

  it('leaves an hour that already holds a generation row alone', () => {
    // Real metering would arrive as exactly such a row; a simulated reading must never displace it.
    const planned = planSimulatedActuals(
      [
        forecastPoint({ validTime: at('10:00:00') }),
        generationPoint(at('10:00:00')),
        forecastPoint({ validTime: at('11:00:00') }),
      ],
      NOW,
    );

    expect(planned.map((reading) => reading.validTime)).toEqual(['2026-07-31T11:00:00Z']);
  });

  it('plans exactly what simulatedActualFromForecast derives from the source forecast', () => {
    const forecast = aForecast({ validTime: at('10:00:00'), acPowerKw: 3.3 });

    const planned = planSimulatedActuals([{ type: 'forecast', forecast }], NOW);

    expect(planned).toEqual([simulatedActualFromForecast(forecast)]);
  });

  it('plans nothing for an empty window', () => {
    expect(planSimulatedActuals([], NOW)).toEqual([]);
  });
});

describe('simulating the trailing window for a run’s sites', () => {
  it('reads the trailing window ending now for each site, and writes what is missing', async () => {
    const recorder = emptyRecorder();

    const outcomes = await simulateTrailingActuals(
      deps({ recorder, pointsBySite: { [RANELAGH_ID]: [forecastPoint()] } }),
      [RANELAGH_ID],
    );

    expect(recorder.windows).toEqual([
      { siteId: RANELAGH_ID, from: '2026-07-31T09:00:00Z', to: '2026-07-31T12:00:00Z' },
    ]);
    expect(outcomes).toEqual([{ siteId: RANELAGH_ID, status: 'written', readingCount: 1 }]);
    expect(recorder.written).toEqual([[simulatedActualFromForecast(aForecast())]]);
  });

  it('reports a window that needs nothing as up-to-date, without issuing a write', async () => {
    const recorder = emptyRecorder();

    const outcomes = await simulateTrailingActuals(
      deps({
        recorder,
        pointsBySite: { [RANELAGH_ID]: [forecastPoint(), generationPoint(at('11:00:00'))] },
      }),
      [RANELAGH_ID],
    );

    expect(outcomes).toEqual([{ siteId: RANELAGH_ID, status: 'up-to-date' }]);
    expect(recorder.written).toEqual([]);
  });

  it('reports an incomplete drain as store-partial, with the count', async () => {
    const outcomes = await simulateTrailingActuals(
      deps({
        recorder: emptyRecorder(),
        pointsBySite: { [RANELAGH_ID]: [forecastPoint()] },
        storeOutcome: { status: 'partial', unprocessedCount: 2 },
      }),
      [RANELAGH_ID],
    );

    expect(outcomes).toEqual([
      { siteId: RANELAGH_ID, status: 'store-partial', unprocessedCount: 2 },
    ]);
  });

  it('converts a rejected write into a failed outcome naming that operation', async () => {
    const outcomes = await simulateTrailingActuals(
      deps({
        recorder: emptyRecorder(),
        pointsBySite: { [RANELAGH_ID]: [forecastPoint()] },
        storeRejectsWith: 'the table is on fire',
      }),
      [RANELAGH_ID],
    );

    expect(detailOf(outcomeFor(outcomes, RANELAGH_ID))).toContain('putGenerationReadings threw');
  });

  it('lets one site fail without abandoning its siblings', async () => {
    const recorder = emptyRecorder();

    const outcomes = await simulateTrailingActuals(
      deps({
        recorder,
        queryRejectsFor: [RANELAGH_ID],
        pointsBySite: { [RATHMINES_ID]: [forecastPoint({ siteId: RATHMINES_ID })] },
      }),
      [RANELAGH_ID, RATHMINES_ID],
    );

    expect(detailOf(outcomeFor(outcomes, RANELAGH_ID))).toContain('querySeriesRange threw');
    expect(outcomeFor(outcomes, RATHMINES_ID)).toEqual({
      siteId: RATHMINES_ID,
      status: 'written',
      readingCount: 1,
    });
  });

  it('logs every outcome under the one event an operator greps for', async () => {
    const recorder = emptyRecorder();

    await simulateTrailingActuals(
      deps({
        recorder,
        queryRejectsFor: [RATHMINES_ID],
        pointsBySite: { [RANELAGH_ID]: [forecastPoint()] },
      }),
      [RANELAGH_ID, RATHMINES_ID],
    );

    // The failing site is logged too, and under the same event: a run that only reported its
    // successes would read as a healthy fleet with fewer sites in it.
    expect(recorder.entries.map((entry) => entry.event)).toEqual([
      simulatedActualsOutcomeEvent,
      simulatedActualsOutcomeEvent,
    ]);
    expect(recorder.entries.map((entry) => entry.siteId)).toEqual([RANELAGH_ID, RATHMINES_ID]);
    expect(recorder.entries.map((entry) => entry.status)).toEqual(['written', 'failed']);
    expect(recorder.entries[0]).toEqual({
      event: simulatedActualsOutcomeEvent,
      siteId: RANELAGH_ID,
      status: 'written',
      readingCount: 1,
    });
  });

  it('does nothing at all for an empty site list', async () => {
    const recorder = emptyRecorder();

    const outcomes = await simulateTrailingActuals(deps({ recorder }), []);

    expect(outcomes).toEqual([]);
    expect(recorder.windows).toEqual([]);
  });
});
