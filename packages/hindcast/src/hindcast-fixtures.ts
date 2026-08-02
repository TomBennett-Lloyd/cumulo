import {
  generationReadingSchema,
  siteSchema,
  utcIsoTimestampSchema,
  type ErrorMetrics,
  type GenerationReading,
  type UtcIsoTimestamp,
  type UtcWindow,
} from '@cumulo/shared';

import type { FetchArchiveRun } from './archive-cache';
import type { UtcDay } from './archive-days';
import {
  DUBLIN,
  HOURS_PER_DAY,
  InMemoryArchiveStore,
  daylight,
  daysBetween,
  hourOf,
  wholeDay,
} from './archive-fixtures';
import type { HindcastDeps, MetricsSink } from './hindcast';

/**
 * The world `hindcast.test.ts` runs a hindcast in: one site, one two-day period,
 * synthetic actuals, and the three ports `runHindcast` takes wired together.
 *
 * Split out of the test file rather than inlined, on the same principle as
 * `packages/storage/src/adapters/weather/weather-fixtures.ts`: a builder set is
 * the shared *setup*, and keeping it here is what leaves each test short enough
 * to read as a statement about behaviour (`docs/standards/structure.md` rule 4).
 *
 * The archive half — the store, and what a day of weather looks like — comes
 * from `archive-fixtures.ts`, shared with the coverage tests because both stand
 * in for the same real `WeatherAdapter`.
 */

const stamp = (value: string): UtcIsoTimestamp => utcIsoTimestampSchema.parse(value);

export const SITE = siteSchema.parse({
  id: '3f6d5f2a-1c4b-4e8a-9d77-0b2c8a5e1f04',
  name: 'hindcast fixture site',
  ...DUBLIN,
  tiltDegrees: 35,
  azimuthDegrees: 180,
  capacityKw: 4,
});

/** The day before the period, so the baseline has something to persist from. */
export const RUN_UP_DAY = '2026-05-31';
export const PERIOD_DAYS: readonly UtcDay[] = ['2026-06-01', '2026-06-02'];

export const PERIOD: UtcWindow = {
  startInclusive: stamp('2026-06-01T00:00:00Z'),
  endExclusive: stamp('2026-06-03T00:00:00Z'),
};

/** Weeks after the period: a hindcast issues its forecast long after the fact. */
export const ISSUED_AT = stamp('2026-07-01T09:00:00Z');

export { HOURS_PER_DAY, InMemoryArchiveStore, hourOf };

/**
 * Actuals with a per-day yield factor, so no day repeats the day before it.
 *
 * That is what gives the 24-hour persistence baseline a non-zero error to be
 * scored against — identical days would make it perfect and the skill score
 * `null`, which is a different test. The curve is also deliberately not the
 * model's own output: observations derived from the forecast would score a
 * perfect zero and prove nothing about the alignment or the skill arithmetic.
 */
const YIELD_BY_DAY: Record<string, number> = {
  [RUN_UP_DAY]: 0.55,
  '2026-06-01': 0.95,
  '2026-06-02': 0.7,
};

const observedDay = (day: UtcDay): GenerationReading[] =>
  Array.from({ length: HOURS_PER_DAY }, (_, hour) =>
    generationReadingSchema.parse({
      siteId: SITE.id,
      validTime: hourOf(day, hour),
      acPowerKw: SITE.capacityKw * daylight(hour) * (YIELD_BY_DAY[day] ?? 1),
    }),
  );

export const observationsOver = (days: readonly UtcDay[]): GenerationReading[] =>
  days.flatMap(observedDay);

/** One reading at an arbitrary instant, for the cases that need a stray point. */
export const observationAt = (validTime: UtcIsoTimestamp, acPowerKw: number): GenerationReading =>
  generationReadingSchema.parse({ siteId: SITE.id, validTime, acPowerKw });

class RecordingMetricsSink implements MetricsSink {
  readonly published: ErrorMetrics[] = [];

  putMetrics(metrics: ErrorMetrics): Promise<void> {
    this.published.push(metrics);
    return Promise.resolve();
  }
}

export interface FetchStub {
  readonly fetchArchiveRun: FetchArchiveRun;
  /** Every range requested, as `first..last` — the quota an operator would have spent. */
  readonly calls: readonly string[];
}

/**
 * Serves whole days for any range asked of it, up to `callBudget` requests —
 * and rejects the request after that, so an over-fetch fails the test rather
 * than passing unnoticed. A budget of zero means "any request at all is a bug".
 */
export const archiveFetchStub = (callBudget: number): FetchStub => {
  const calls: string[] = [];
  const fetchArchiveRun: FetchArchiveRun = (_coords, firstDay, lastDay) => {
    calls.push(`${firstDay}..${lastDay}`);
    return calls.length > callBudget
      ? Promise.reject(new Error(`unexpected archive request #${String(calls.length)}`))
      : Promise.resolve({
          status: 'ok',
          completeDays: new Map(daysBetween(firstDay, lastDay).map((day) => [day, wholeDay(day)])),
          incompleteDays: [],
        });
  };
  return { fetchArchiveRun, calls };
};

/** Open-Meteo's quota already spent: every request comes back rate-limited. */
export const rateLimitedFetchStub = (): FetchStub => {
  const calls: string[] = [];
  const fetchArchiveRun: FetchArchiveRun = (_coords, firstDay, lastDay) => {
    calls.push(`${firstDay}..${lastDay}`);
    return Promise.resolve({ status: 'rate-limited' });
  };
  return { fetchArchiveRun, calls };
};

export interface Harness {
  readonly deps: HindcastDeps;
  readonly sink: RecordingMetricsSink;
  readonly fetches: FetchStub;
}

/** The three ports wired together, with the store injectable for a two-run test. */
export const harness = (fetches: FetchStub, store = new InMemoryArchiveStore()): Harness => {
  const sink = new RecordingMetricsSink();
  return {
    deps: { weatherAdapter: store, fetchArchiveRun: fetches.fetchArchiveRun, metricsAdapter: sink },
    sink,
    fetches,
  };
};
