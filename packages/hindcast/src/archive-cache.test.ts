import { locationId, utcIsoTimestampSchema, type GeoCoordinates } from '@cumulo/shared';
import { describe, expect, it } from 'vitest';

import type { UtcDay } from './archive-days';
import {
  ensureArchiveCoverage,
  type ArchiveCoverageOutcome,
  type ArchiveDayCoverage,
  type ArchiveDayStore,
  type FetchArchiveRun,
} from './archive-cache';
import type { ArchiveFetchResult, ArchiveWeatherReading } from './open-meteo-archive';

/**
 * Coverage is exercised against a `Map`-backed store that implements
 * {@link ArchiveDayStore} for real — it refuses a marker without readings and
 * refuses readings dated to another day, exactly as `putArchiveDay` does — and a
 * fetch stub that records what it was asked (`docs/standards/testing.md` rule 3:
 * a contract, not a mock whose calls are asserted for their own sake).
 *
 * The stub rejects any request past the end of its script, so "no further
 * request was made" is proven by the test passing rather than by an assertion
 * that could be deleted. That is what makes the fetch-at-most-once criterion
 * mechanical: the second run over a populated store simply has no answer left to
 * be given.
 */
const dublin: GeoCoordinates = { latitude: 53.35, longitude: -6.26 };

const dayKey = (partition: string, day: UtcDay): string => `${partition}#${day}`;

const hourReading = (day: UtcDay, hour: number): ArchiveWeatherReading => ({
  latitude: dublin.latitude,
  longitude: dublin.longitude,
  // Parsed, not cast: `validTime` is a branded UTC stamp, and the fixture builder
  // has to earn the brand the same way the response parser does.
  validTime: utcIsoTimestampSchema.parse(`${day}T${String(hour).padStart(2, '0')}:00:00Z`),
  kind: 'archive',
  source: 'open-meteo',
  shortwaveRadiationWm2: 120,
  directRadiationWm2: 70,
  diffuseRadiationWm2: 50,
  directNormalIrradianceWm2: 90,
  temperature2mC: 14,
  windSpeed10mMs: 4,
  cloudCoverPct: 55,
});

/** The 24 hour-ending readings of one whole day, as the parser would hand them over. */
const wholeDay = (day: UtcDay): ArchiveWeatherReading[] =>
  Array.from({ length: 24 }, (_, hour) => hourReading(day, hour));

const MS_PER_DAY = 86_400_000;

const consecutiveDays = (firstDay: UtcDay, count: number): UtcDay[] => {
  const startMs = Date.parse(`${firstDay}T00:00:00Z`);
  return Array.from({ length: count }, (_, offset) =>
    new Date(startMs + offset * MS_PER_DAY).toISOString().slice(0, 10),
  );
};

interface StoreOptions {
  /** Days the store answers `undetermined` for, as DynamoDB declining a key would. */
  readonly undeterminedDays?: readonly UtcDay[];
}

class InMemoryArchiveDayStore implements ArchiveDayStore {
  private readonly markedDays = new Map<string, readonly ArchiveWeatherReading[]>();
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
    const fetched = new Set(
      days.filter(
        (day) => this.markedDays.has(dayKey(partition, day)) && !this.undeterminedDays.has(day),
      ),
    );
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
    const misdated = readings.find((reading) => !reading.validTime.startsWith(`${day}T`));
    if (misdated !== undefined) {
      return Promise.reject(new Error(`${day} was given a reading at ${misdated.validTime}`));
    }
    this.markedDays.set(dayKey(locationId(first), day), readings);
    return Promise.resolve();
  }

  /**
   * Hours stored under a day's marker — `0` when the day carries no marker at
   * all. One accessor rather than a separate `hasMarker`, because marker and
   * readings land together: "is it marked?" and "is the whole day there?" are
   * the same question, and asking it as a count catches a marker vouching for a
   * partial day.
   */
  storedHours(coords: GeoCoordinates, day: UtcDay): number {
    return this.markedDays.get(dayKey(locationId(coords), day))?.length ?? 0;
  }
}

interface ArchiveRunCall {
  readonly firstDay: UtcDay;
  readonly lastDay: UtcDay;
}

interface FetchStub {
  readonly fetchArchiveRun: FetchArchiveRun;
  readonly calls: readonly ArchiveRunCall[];
}

const stubArchiveRuns = (results: readonly ArchiveFetchResult[]): FetchStub => {
  const calls: ArchiveRunCall[] = [];
  const fetchArchiveRun: FetchArchiveRun = (_coords, firstDay, lastDay) => {
    const result = results[calls.length];
    calls.push({ firstDay, lastDay });
    return result === undefined
      ? Promise.reject(new Error(`unexpected archive request #${String(calls.length)}`))
      : Promise.resolve(result);
  };
  return { fetchArchiveRun, calls };
};

const okRun = (days: readonly UtcDay[], incompleteDays: UtcDay[] = []): ArchiveFetchResult => ({
  status: 'ok',
  completeDays: new Map(days.map((day) => [day, wholeDay(day)])),
  incompleteDays,
});

const readyOutcome = (
  outcome: ArchiveCoverageOutcome,
): Extract<ArchiveCoverageOutcome, { status: 'ready' }> => {
  if (outcome.status !== 'ready') {
    throw new Error(`expected a ready outcome, got ${outcome.status}`);
  }
  return outcome;
};

/** A store already holding whole days, as a completed earlier backfill would leave it. */
const storeHolding = async (days: readonly UtcDay[]): Promise<InMemoryArchiveDayStore> => {
  const store = new InMemoryArchiveDayStore();
  for (const day of days) {
    await store.putArchiveDay(day, wholeDay(day));
  }
  return store;
};

describe('ensureArchiveCoverage quota guard', () => {
  it('issues no request at all when every requested day already carries a marker', async () => {
    const days = consecutiveDays('2026-06-01', 3);
    const store = await storeHolding(days);
    const stub = stubArchiveRuns([]);

    const outcome = await ensureArchiveCoverage(
      { weatherAdapter: store, fetchArchiveRun: stub.fetchArchiveRun },
      dublin,
      days,
    );

    expect(outcome).toEqual({
      status: 'ready',
      alreadyCached: days,
      fetched: [],
      unavailableDays: [],
      apiCallCount: 0,
    });
    expect(stub.calls).toHaveLength(0);
  });

  it('fetches a day at most once: a second run over the same window asks for nothing', async () => {
    const days = consecutiveDays('2026-06-01', 3);
    const store = new InMemoryArchiveDayStore();
    // One scripted response for both runs — a second request would reject.
    const stub = stubArchiveRuns([okRun(days)]);
    const deps = { weatherAdapter: store, fetchArchiveRun: stub.fetchArchiveRun };

    const first = await ensureArchiveCoverage(deps, dublin, days);
    const second = await ensureArchiveCoverage(deps, dublin, days);

    expect(readyOutcome(first).fetched).toEqual(days);
    expect(readyOutcome(first).apiCallCount).toBe(1);
    expect(second).toEqual({
      status: 'ready',
      alreadyCached: days,
      fetched: [],
      unavailableDays: [],
      apiCallCount: 0,
    });
    expect(stub.calls).toHaveLength(1);
    expect(store.storedHours(dublin, '2026-06-02')).toBe(24);
  });

  it('requests only the missing contiguous runs, at their exact bounds', async () => {
    const store = await storeHolding(['2026-06-03', '2026-06-04']);
    const stub = stubArchiveRuns([
      okRun(['2026-06-01', '2026-06-02']),
      okRun(['2026-06-05', '2026-06-06']),
    ]);

    // Reversed and with a repeat: the day list is whatever the caller's scan
    // produced, and neither order nor a duplicate may split a run.
    const requestedDays = [...consecutiveDays('2026-06-01', 6).reverse(), '2026-06-01'];

    const outcome = await ensureArchiveCoverage(
      { weatherAdapter: store, fetchArchiveRun: stub.fetchArchiveRun },
      dublin,
      requestedDays,
    );

    expect(stub.calls).toEqual([
      { firstDay: '2026-06-01', lastDay: '2026-06-02' },
      { firstDay: '2026-06-05', lastDay: '2026-06-06' },
    ]);
    expect(readyOutcome(outcome).alreadyCached).toEqual(['2026-06-03', '2026-06-04']);
    expect(readyOutcome(outcome).fetched).toEqual([
      '2026-06-01',
      '2026-06-02',
      '2026-06-05',
      '2026-06-06',
    ]);
    expect(outcome).toMatchObject({ apiCallCount: 2 });
  });

  it("splits a gap longer than the provider's range limit rather than asking for it whole", async () => {
    const days = consecutiveDays('2026-06-01', 40);
    const store = new InMemoryArchiveDayStore();
    const stub = stubArchiveRuns([okRun(days.slice(0, 31)), okRun(days.slice(31))]);

    const outcome = await ensureArchiveCoverage(
      { weatherAdapter: store, fetchArchiveRun: stub.fetchArchiveRun },
      dublin,
      days,
    );

    expect(stub.calls).toEqual([
      { firstDay: '2026-06-01', lastDay: '2026-07-01' },
      { firstDay: '2026-07-02', lastDay: '2026-07-10' },
    ]);
    expect(readyOutcome(outcome).fetched).toHaveLength(40);
  });

  it('ignores a complete day the provider returned outside the requested run', async () => {
    const days = consecutiveDays('2026-06-01', 2);
    const store = new InMemoryArchiveDayStore();
    const stub = stubArchiveRuns([okRun([...days, '2026-06-09'])]);

    const outcome = await ensureArchiveCoverage(
      { weatherAdapter: store, fetchArchiveRun: stub.fetchArchiveRun },
      dublin,
      days,
    );

    expect(readyOutcome(outcome).fetched).toEqual(days);
    expect(store.storedHours(dublin, '2026-06-09')).toBe(0);
  });
});

describe('ensureArchiveCoverage failure policy', () => {
  it('fetches nothing when storage cannot say which days are cached', async () => {
    const days = consecutiveDays('2026-06-01', 3);
    const store = new InMemoryArchiveDayStore({ undeterminedDays: ['2026-06-02'] });
    const stub = stubArchiveRuns([okRun(days)]);

    const outcome = await ensureArchiveCoverage(
      { weatherAdapter: store, fetchArchiveRun: stub.fetchArchiveRun },
      dublin,
      days,
    );

    // Not even '2026-06-01', which is known to be absent: half a backfill against
    // an unknown cache is how a day gets fetched twice.
    expect(outcome).toEqual({ status: 'coverage-unknown', undeterminedDays: ['2026-06-02'] });
    expect(stub.calls).toHaveLength(0);
    expect(store.storedHours(dublin, '2026-06-01')).toBe(0);
  });

  it('reports a day the provider could not complete as unavailable and marks nothing for it', async () => {
    const days = consecutiveDays('2026-06-01', 3);
    const store = new InMemoryArchiveDayStore();
    const stub = stubArchiveRuns([
      okRun(['2026-06-01', '2026-06-02'], ['2026-06-03']),
      okRun(['2026-06-03']),
    ]);
    const deps = { weatherAdapter: store, fetchArchiveRun: stub.fetchArchiveRun };

    const outcome = await ensureArchiveCoverage(deps, dublin, days);

    expect(readyOutcome(outcome).unavailableDays).toEqual(['2026-06-03']);
    expect(readyOutcome(outcome).fetched).toEqual(['2026-06-01', '2026-06-02']);
    expect(store.storedHours(dublin, '2026-06-03')).toBe(0);

    // No marker means a later run retries it — the un-marked day is a retry, not
    // a permanent hole recorded by omission.
    const retry = await ensureArchiveCoverage(deps, dublin, days);
    expect(stub.calls[1]).toEqual({ firstDay: '2026-06-03', lastDay: '2026-06-03' });
    expect(readyOutcome(retry).fetched).toEqual(['2026-06-03']);
  });

  it('stops at a rate limit with everything before it stored and the rest reported', async () => {
    const days = ['2026-06-01', '2026-06-02', '2026-06-04', '2026-06-05', '2026-06-07'];
    const store = new InMemoryArchiveDayStore();
    // Three runs, an answer for two: a third request would reject, so "stopped
    // immediately" is proven by the test not blowing up.
    const stub = stubArchiveRuns([okRun(['2026-06-01', '2026-06-02']), { status: 'rate-limited' }]);

    const outcome = await ensureArchiveCoverage(
      { weatherAdapter: store, fetchArchiveRun: stub.fetchArchiveRun },
      dublin,
      days,
    );

    expect(outcome).toEqual({
      status: 'rate-limited',
      fetched: ['2026-06-01', '2026-06-02'],
      remainingDays: ['2026-06-04', '2026-06-05', '2026-06-07'],
      apiCallCount: 2,
    });
    expect(stub.calls).toHaveLength(2);
    expect(store.storedHours(dublin, '2026-06-01')).toBe(24);
    expect(store.storedHours(dublin, '2026-06-04')).toBe(0);
  });

  it('throws with the location, range and provider reason when a request is refused', async () => {
    const days = consecutiveDays('2026-06-01', 2);
    const store = new InMemoryArchiveDayStore();
    const stub = stubArchiveRuns([
      { status: 'rejected', httpStatus: 400, reason: 'start_date is out of allowed range' },
    ]);

    await expect(
      ensureArchiveCoverage(
        { weatherAdapter: store, fetchArchiveRun: stub.fetchArchiveRun },
        dublin,
        days,
      ),
    ).rejects.toThrow(
      'Open-Meteo archive refused the backfill request for 53.35,-6.26 2026-06-01..2026-06-02 with HTTP 400: start_date is out of allowed range',
    );
  });

  it('propagates a storage failure rather than reporting the day as covered', async () => {
    const days = consecutiveDays('2026-06-01', 2);
    const store = new InMemoryArchiveDayStore();
    const outage = new Error('StorageError: putArchiveDay failed');
    const failingAdapter: ArchiveDayStore = {
      listFetchedArchiveDays: (coords, requested) =>
        store.listFetchedArchiveDays(coords, requested),
      putArchiveDay: () => Promise.reject(outage),
    };
    const stub = stubArchiveRuns([okRun(days)]);

    await expect(
      ensureArchiveCoverage(
        { weatherAdapter: failingAdapter, fetchArchiveRun: stub.fetchArchiveRun },
        dublin,
        days,
      ),
    ).rejects.toThrow(outage);
  });
});
