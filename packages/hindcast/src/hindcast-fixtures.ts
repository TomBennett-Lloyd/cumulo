import {
  generationReadingSchema,
  locationId,
  siteSchema,
  utcIsoTimestampSchema,
  type ErrorMetrics,
  type GenerationReading,
  type GeoCoordinates,
  type MetricsPeriod,
  type UtcIsoTimestamp,
  type WeatherReading,
} from '@cumulo/shared';

import type { ArchiveDayCoverage, FetchArchiveRun } from './archive-cache';
import type { UtcDay } from './archive-days';
import type { HindcastDeps, HindcastWeatherStore, MetricsSink } from './hindcast';
import type { ArchiveWeatherReading } from './open-meteo-archive';

/**
 * The world `hindcast.test.ts` runs a hindcast in: one site, one two-day period,
 * synthetic weather and actuals, and in-memory implementations of the three
 * ports `runHindcast` takes.
 *
 * Split out of the test file rather than inlined, on the same principle as
 * `packages/storage/src/adapters/weather/weather-fixtures.ts`: a builder set is the shared
 * *setup*, and keeping it here is what leaves each test short enough to read as
 * a statement about behaviour (`docs/standards/structure.md` rule 4).
 *
 * The fakes implement the ports for real rather than recording calls: the store
 * refuses a marker with no readings, and `queryArchiveRange` honours the
 * half-open window exactly as the adapter's `BETWEEN` does. A mock asserted for
 * its own sake would prove nothing (`docs/standards/testing.md` rule 3).
 */

export const DUBLIN: GeoCoordinates = { latitude: 53.35, longitude: -6.26 };

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

export const PERIOD: MetricsPeriod = {
  startInclusive: stamp('2026-06-01T00:00:00Z'),
  endExclusive: stamp('2026-06-03T00:00:00Z'),
};

/** Weeks after the period: a hindcast issues its forecast long after the fact. */
export const ISSUED_AT = stamp('2026-07-01T09:00:00Z');

export const HOURS_PER_DAY = 24;

const MS_PER_DAY = 86_400_000;

/** A crude but strictly positive daylight curve: zero before 05:00 and from 19:00. */
const daylight = (hour: number): number => Math.max(0, Math.sin(((hour - 5) / 14) * Math.PI));

export const hourOf = (day: UtcDay, hour: number): UtcIsoTimestamp =>
  stamp(`${day}T${String(hour).padStart(2, '0')}:00:00Z`);

const archiveHour = (day: UtcDay, hour: number): ArchiveWeatherReading => {
  const sun = daylight(hour);
  return {
    ...DUBLIN,
    validTime: hourOf(day, hour),
    kind: 'archive',
    source: 'open-meteo',
    shortwaveRadiationWm2: 700 * sun,
    directRadiationWm2: 500 * sun,
    diffuseRadiationWm2: 200 * sun,
    directNormalIrradianceWm2: 800 * sun,
    temperature2mC: 15,
    windSpeed10mMs: 4,
    cloudCoverPct: 40,
  };
};

const wholeDay = (day: UtcDay): ArchiveWeatherReading[] =>
  Array.from({ length: HOURS_PER_DAY }, (_, hour) => archiveHour(day, hour));

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

const daysBetween = (firstDay: UtcDay, lastDay: UtcDay): UtcDay[] => {
  const firstMs = Date.parse(`${firstDay}T00:00:00Z`);
  const count = (Date.parse(`${lastDay}T00:00:00Z`) - firstMs) / MS_PER_DAY + 1;
  return Array.from({ length: count }, (_, offset) =>
    new Date(firstMs + offset * MS_PER_DAY).toISOString().slice(0, 10),
  );
};

export interface StoreOptions {
  /** Days the store answers `undetermined` for, as DynamoDB declining a key would. */
  readonly undeterminedDays?: readonly UtcDay[];
}

export class InMemoryWeatherStore implements HindcastWeatherStore {
  private readonly storedDays = new Map<string, readonly ArchiveWeatherReading[]>();
  private readonly undeterminedDays: ReadonlySet<UtcDay>;

  constructor(options: StoreOptions = {}) {
    this.undeterminedDays = new Set(options.undeterminedDays ?? []);
  }

  listFetchedArchiveDays(
    coords: GeoCoordinates,
    days: readonly UtcDay[],
  ): Promise<ArchiveDayCoverage> {
    const partition = locationId(coords);
    const undetermined = days.filter((day) => this.undeterminedDays.has(day));
    const fetched = new Set(days.filter((day) => this.storedDays.has(`${partition}#${day}`)));
    return Promise.resolve(
      undetermined.length === 0
        ? { status: 'complete', fetched }
        : { status: 'incomplete', fetched, undeterminedDays: undetermined },
    );
  }

  putArchiveDay(day: UtcDay, readings: readonly ArchiveWeatherReading[]): Promise<void> {
    const [first] = readings;
    if (first === undefined) {
      return Promise.reject(new Error(`refusing to mark ${day} with no readings`));
    }
    this.storedDays.set(`${locationId(first)}#${day}`, readings);
    return Promise.resolve();
  }

  queryArchiveRange(
    coords: GeoCoordinates,
    fromInclusive: UtcIsoTimestamp,
    toExclusive: UtcIsoTimestamp,
  ): Promise<WeatherReading[]> {
    const prefix = `${locationId(coords)}#`;
    const readings = [...this.storedDays]
      .filter(([key]) => key.startsWith(prefix))
      .flatMap(([, day]) => day)
      .filter((reading) => reading.validTime >= fromInclusive && reading.validTime < toExclusive);
    return Promise.resolve(readings);
  }
}

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

/** The three ports wired together, with the store exposed for a two-run test. */
export const harness = (fetches: FetchStub, store = new InMemoryWeatherStore()): Harness => {
  const sink = new RecordingMetricsSink();
  return {
    deps: { weatherAdapter: store, fetchArchiveRun: fetches.fetchArchiveRun, metricsAdapter: sink },
    sink,
    fetches,
  };
};
