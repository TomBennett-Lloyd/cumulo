import { describe, expect, it } from 'vitest';

import {
  ensureArchiveCoverage,
  type ArchiveCoverageOutcome,
  type ArchiveDayStore,
  type FetchArchiveRun,
} from './archive-cache';
import type { UtcDay } from './archive-days';
import { DUBLIN, InMemoryArchiveStore, consecutiveDays, wholeDay } from './archive-fixtures';
import type { ArchiveFetchResult } from './open-meteo-archive';

/**
 * Coverage is exercised against the `Map`-backed store in `archive-fixtures.ts`,
 * which implements {@link ArchiveDayStore} for real — it refuses a marker
 * without readings and refuses readings dated to another day, exactly as
 * `putArchiveDay` does — and a fetch stub that records what it was asked
 * (`docs/standards/testing.md` rule 3: a contract, not a mock whose calls are
 * asserted for their own sake).
 *
 * The stub rejects any request past the end of its script, so "no further
 * request was made" is proven by the test passing rather than by an assertion
 * that could be deleted. That is what makes the fetch-at-most-once criterion
 * mechanical: the second run over a populated store simply has no answer left to
 * be given.
 */

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
const storeHolding = async (days: readonly UtcDay[]): Promise<InMemoryArchiveStore> => {
  const store = new InMemoryArchiveStore();
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
      DUBLIN,
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
    const store = new InMemoryArchiveStore();
    // One scripted response for both runs — a second request would reject.
    const stub = stubArchiveRuns([okRun(days)]);
    const deps = { weatherAdapter: store, fetchArchiveRun: stub.fetchArchiveRun };

    const first = await ensureArchiveCoverage(deps, DUBLIN, days);
    const second = await ensureArchiveCoverage(deps, DUBLIN, days);

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
    expect(store.storedHours(DUBLIN, '2026-06-02')).toBe(24);
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
      DUBLIN,
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
    const store = new InMemoryArchiveStore();
    const stub = stubArchiveRuns([okRun(days.slice(0, 31)), okRun(days.slice(31))]);

    const outcome = await ensureArchiveCoverage(
      { weatherAdapter: store, fetchArchiveRun: stub.fetchArchiveRun },
      DUBLIN,
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
    const store = new InMemoryArchiveStore();
    const stub = stubArchiveRuns([okRun([...days, '2026-06-09'])]);

    const outcome = await ensureArchiveCoverage(
      { weatherAdapter: store, fetchArchiveRun: stub.fetchArchiveRun },
      DUBLIN,
      days,
    );

    expect(readyOutcome(outcome).fetched).toEqual(days);
    expect(store.storedHours(DUBLIN, '2026-06-09')).toBe(0);
  });
});

describe('ensureArchiveCoverage failure policy', () => {
  it('fetches nothing when storage cannot say which days are cached', async () => {
    const days = consecutiveDays('2026-06-01', 3);
    const store = new InMemoryArchiveStore({ undeterminedDays: ['2026-06-02'] });
    const stub = stubArchiveRuns([okRun(days)]);

    const outcome = await ensureArchiveCoverage(
      { weatherAdapter: store, fetchArchiveRun: stub.fetchArchiveRun },
      DUBLIN,
      days,
    );

    // Not even '2026-06-01', which is known to be absent: half a backfill against
    // an unknown cache is how a day gets fetched twice.
    expect(outcome).toEqual({ status: 'coverage-unknown', undeterminedDays: ['2026-06-02'] });
    expect(stub.calls).toHaveLength(0);
    expect(store.storedHours(DUBLIN, '2026-06-01')).toBe(0);
  });

  it('reports a day the provider could not complete as unavailable and marks nothing for it', async () => {
    const days = consecutiveDays('2026-06-01', 3);
    const store = new InMemoryArchiveStore();
    const stub = stubArchiveRuns([
      okRun(['2026-06-01', '2026-06-02'], ['2026-06-03']),
      okRun(['2026-06-03']),
    ]);
    const deps = { weatherAdapter: store, fetchArchiveRun: stub.fetchArchiveRun };

    const outcome = await ensureArchiveCoverage(deps, DUBLIN, days);

    expect(readyOutcome(outcome).unavailableDays).toEqual(['2026-06-03']);
    expect(readyOutcome(outcome).fetched).toEqual(['2026-06-01', '2026-06-02']);
    expect(store.storedHours(DUBLIN, '2026-06-03')).toBe(0);

    // No marker means a later run retries it — the un-marked day is a retry, not
    // a permanent hole recorded by omission.
    const retry = await ensureArchiveCoverage(deps, DUBLIN, days);
    expect(stub.calls[1]).toEqual({ firstDay: '2026-06-03', lastDay: '2026-06-03' });
    expect(readyOutcome(retry).fetched).toEqual(['2026-06-03']);
  });

  it('reports a requested day the response never mentioned at all as unavailable', async () => {
    const days = consecutiveDays('2026-06-01', 3);
    const store = new InMemoryArchiveStore();
    // A truncated payload: 36 hours answered for a three-day request, so 06-01
    // arrives whole, 06-02 arrives short, and 06-03 is simply absent from the
    // response — named in neither list the provider hands back.
    const stub = stubArchiveRuns([okRun(['2026-06-01'], ['2026-06-02'])]);

    const outcome = await ensureArchiveCoverage(
      { weatherAdapter: store, fetchArchiveRun: stub.fetchArchiveRun },
      DUBLIN,
      days,
    );

    // 06-03 has to appear somewhere. It is not cached and it was not fetched, so
    // an outcome that omitted it entirely would still call itself `ready` and let
    // a hindcast score a window with a hole nothing in the answer reports.
    expect(readyOutcome(outcome).unavailableDays).toEqual(['2026-06-02', '2026-06-03']);
    expect(readyOutcome(outcome).fetched).toEqual(['2026-06-01']);
    expect(store.storedHours(DUBLIN, '2026-06-03')).toBe(0);
  });

  it('stops at a rate limit with everything before it stored and the rest reported', async () => {
    const days = ['2026-06-01', '2026-06-02', '2026-06-04', '2026-06-05', '2026-06-07'];
    const store = new InMemoryArchiveStore();
    // Three runs, an answer for two: a third request would reject, so "stopped
    // immediately" is proven by the test not blowing up.
    const stub = stubArchiveRuns([okRun(['2026-06-01', '2026-06-02']), { status: 'rate-limited' }]);

    const outcome = await ensureArchiveCoverage(
      { weatherAdapter: store, fetchArchiveRun: stub.fetchArchiveRun },
      DUBLIN,
      days,
    );

    expect(outcome).toEqual({
      status: 'rate-limited',
      fetched: ['2026-06-01', '2026-06-02'],
      remainingDays: ['2026-06-04', '2026-06-05', '2026-06-07'],
      apiCallCount: 2,
    });
    expect(stub.calls).toHaveLength(2);
    expect(store.storedHours(DUBLIN, '2026-06-01')).toBe(24);
    expect(store.storedHours(DUBLIN, '2026-06-04')).toBe(0);
  });

  it('throws with the location, range and provider reason when a request is refused', async () => {
    const days = consecutiveDays('2026-06-01', 2);
    const store = new InMemoryArchiveStore();
    const stub = stubArchiveRuns([
      { status: 'rejected', httpStatus: 400, reason: 'start_date is out of allowed range' },
    ]);

    await expect(
      ensureArchiveCoverage(
        { weatherAdapter: store, fetchArchiveRun: stub.fetchArchiveRun },
        DUBLIN,
        days,
      ),
    ).rejects.toThrow(
      'Open-Meteo archive refused the backfill request for 53.35,-6.26 2026-06-01..2026-06-02 with HTTP 400: start_date is out of allowed range',
    );
  });

  it('propagates a storage failure rather than reporting the day as covered', async () => {
    const days = consecutiveDays('2026-06-01', 2);
    const store = new InMemoryArchiveStore();
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
        DUBLIN,
        days,
      ),
    ).rejects.toThrow(outage);
  });
});
