import { errorMetricsSchema, generationReadingSchema } from '@cumulo/shared';
import { describe, expect, it } from 'vitest';

import {
  HOURS_PER_DAY,
  ISSUED_AT,
  InMemoryWeatherStore,
  PERIOD,
  PERIOD_DAYS,
  RUN_UP_DAY,
  SITE,
  archiveFetchStub,
  harness,
  hourOf,
  observationsOver,
  rateLimitedFetchStub,
} from './hindcast-fixtures';
import { runHindcast, type HindcastDeps, type HindcastOutcome } from './hindcast';

/**
 * What a hindcast has to get right, in the order the run does it: cover the
 * archive, replay the physics, score the alignment, publish once.
 *
 * The fixtures (`hindcast-fixtures.ts`) implement the three ports for real
 * against a `Map`, so nothing here mocks an adapter and asserts the mock. The
 * fetch stub's call *budget* is what makes the cache criterion mechanical: it
 * rejects a request past its budget, so "the second run spent no quota" is
 * proven by the test passing at all rather than by an expectation somebody could
 * delete.
 */

const completeOutcome = (
  outcome: HindcastOutcome,
): Extract<HindcastOutcome, { status: 'complete' }> => {
  if (outcome.status !== 'complete') {
    throw new Error(`expected a complete hindcast, got ${outcome.status}`);
  }
  return outcome;
};

/** The standard run: the two-day period, with the day before it in the actuals. */
const scoreFixturePeriod = (deps: HindcastDeps): Promise<HindcastOutcome> =>
  runHindcast(deps, {
    site: SITE,
    period: PERIOD,
    observations: observationsOver([RUN_UP_DAY, ...PERIOD_DAYS]),
    issuedAt: ISSUED_AT,
  });

describe('runHindcast over a covered period', () => {
  it('publishes one storable metrics row scored against the persistence baseline', async () => {
    const { deps, sink } = harness(archiveFetchStub(1));

    const outcome = completeOutcome(await scoreFixturePeriod(deps));

    expect(outcome.metrics.baseline).toBe('persistence-24h');
    expect(outcome.metrics.model).toBe('physics');
    expect(outcome.metrics.siteId).toBe(SITE.id);
    expect(outcome.metrics.period).toEqual(PERIOD);
    expect(outcome.metrics.computedAt).toBe(ISSUED_AT);
    // Every hour of the two-day period aligned: 24 archive hours per day, each
    // matched by an observation.
    expect(outcome.metrics.sampleCount).toBe(HOURS_PER_DAY * PERIOD_DAYS.length);
    expect(Number.isFinite(outcome.metrics.maeKw)).toBe(true);
    expect(outcome.metrics.maeKw).toBeGreaterThan(0);
    // RMSE ≥ MAE always; equal only if every hour missed by the same amount.
    expect(outcome.metrics.rmseKw).toBeGreaterThanOrEqual(outcome.metrics.maeKw);
    expect(outcome.metrics.skillScore).toEqual(expect.any(Number));

    expect(sink.published).toHaveLength(1);
    // The row the sink received is storable as it stands, not merely
    // metrics-shaped: `MetricsAdapter.putMetrics` takes exactly this contract.
    expect(() => errorMetricsSchema.parse(sink.published[0])).not.toThrow();
  });

  it('reports what the run cost: days cached, days fetched and requests issued', async () => {
    const { deps } = harness(archiveFetchStub(1));

    const outcome = completeOutcome(await scoreFixturePeriod(deps));

    expect(outcome.coverage).toEqual({
      alreadyCached: 0,
      fetched: PERIOD_DAYS.length,
      unavailableDays: [],
      apiCallCount: 1,
    });
  });

  it('spends no archive quota on a second run over the same period', async () => {
    // One request for both runs: a second would exceed the budget and reject.
    const { deps, fetches } = harness(archiveFetchStub(1));

    await scoreFixturePeriod(deps);
    const second = completeOutcome(await scoreFixturePeriod(deps));

    expect(fetches.calls).toEqual(['2026-06-01..2026-06-02']);
    expect(second.coverage).toEqual({
      alreadyCached: PERIOD_DAYS.length,
      fetched: 0,
      unavailableDays: [],
      apiCallCount: 0,
    });
  });

  it('replays identically from the cache: the second run reproduces the first row exactly', async () => {
    const { deps, sink } = harness(archiveFetchStub(1));

    const first = completeOutcome(await scoreFixturePeriod(deps));
    const second = completeOutcome(await scoreFixturePeriod(deps));

    // Bit-identical, not merely close: the chain is pure and both runs saw the
    // same archive hours, so drift here would mean a hidden clock or a hidden
    // order dependency, not floating-point noise.
    expect(second.metrics).toEqual(first.metrics);
    expect(Object.is(second.metrics.rmseKw, first.metrics.rmseKw)).toBe(true);
    expect(sink.published).toHaveLength(2);
  });

  it('draws the first day of the period from observations made before it', async () => {
    const withRunUp = completeOutcome(await scoreFixturePeriod(harness(archiveFetchStub(1)).deps));

    const { deps } = harness(archiveFetchStub(1));
    const withoutRunUp = completeOutcome(
      await runHindcast(deps, {
        site: SITE,
        period: PERIOD,
        observations: observationsOver(PERIOD_DAYS),
        issuedAt: ISSUED_AT,
      }),
    );

    // The model scored the same hours either way — only the baseline changed,
    // because without the run-up day the period's first day has nothing to
    // persist from.
    expect(withoutRunUp.metrics.rmseKw).toBe(withRunUp.metrics.rmseKw);
    expect(withoutRunUp.metrics.skillScore).not.toBe(withRunUp.metrics.skillScore);
  });
});

describe('runHindcast refusals', () => {
  it('returns no-observations and writes nothing when the actuals miss the period', async () => {
    const { deps, sink } = harness(archiveFetchStub(1));

    const outcome = await runHindcast(deps, {
      site: SITE,
      period: PERIOD,
      observations: observationsOver([RUN_UP_DAY]),
      issuedAt: ISSUED_AT,
    });

    expect(outcome).toEqual({ status: 'no-observations' });
    expect(sink.published).toEqual([]);
  });

  it('returns no-observations for an empty actuals list rather than a row of zeroes', async () => {
    const { deps, sink } = harness(archiveFetchStub(1));

    const outcome = await runHindcast(deps, {
      site: SITE,
      period: PERIOD,
      observations: [],
      issuedAt: ISSUED_AT,
    });

    expect(outcome).toEqual({ status: 'no-observations' });
    expect(sink.published).toEqual([]);
  });

  it('computes nothing when storage cannot say which archive days are cached', async () => {
    const store = new InMemoryWeatherStore({ undeterminedDays: ['2026-06-02'] });
    // A budget of zero: any request at all rejects, so "fetched nothing" is
    // proven by the run completing.
    const { deps, sink, fetches } = harness(archiveFetchStub(0), store);

    const outcome = await scoreFixturePeriod(deps);

    expect(outcome).toEqual({
      status: 'archive-incomplete',
      detail: { status: 'coverage-unknown', undeterminedDays: ['2026-06-02'] },
    });
    expect(fetches.calls).toEqual([]);
    expect(sink.published).toEqual([]);
  });

  it('publishes no metrics for a period the archive fetch was rate-limited out of', async () => {
    const { deps, sink } = harness(rateLimitedFetchStub());

    const outcome = await scoreFixturePeriod(deps);

    expect(outcome).toEqual({
      status: 'archive-incomplete',
      detail: { status: 'rate-limited', fetched: [], remainingDays: PERIOD_DAYS, apiCallCount: 1 },
    });
    expect(sink.published).toEqual([]);
  });

  it('refuses observations belonging to another site rather than scoring them', async () => {
    const { deps, sink } = harness(archiveFetchStub(0));
    const foreign = generationReadingSchema.parse({
      siteId: '9c1e4d70-6a2b-4f19-8e35-7d0af6b31c82',
      validTime: hourOf('2026-06-01', 12),
      acPowerKw: 3,
    });

    await expect(
      runHindcast(deps, {
        site: SITE,
        period: PERIOD,
        observations: [...observationsOver(PERIOD_DAYS), foreign],
        issuedAt: ISSUED_AT,
      }),
    ).rejects.toThrow(`site ${SITE.id} was given an observation for site ${foreign.siteId}`);

    expect(sink.published).toEqual([]);
  });
});
