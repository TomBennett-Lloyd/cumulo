import { apiErrorSchema, utcIsoTimestampSchema, type FleetSite } from '@cumulo/shared';
import type { SeriesPoint, SeriesRangeResult } from '@cumulo/storage';
import { describe, expect, it } from 'vitest';

import {
  countdownDeadline,
  fleetOfSize,
  fleetSite,
  forecastPoint,
  fullBudgetDeadline,
  jsonBodyOf,
  RANELAGH_ID,
  RATHMINES_ID,
} from '../api-fixtures';
import type { ApiResponse } from '../http/response';

import {
  FLEET_READ_CONCURRENCY,
  readFleetSeries,
  type FleetSeriesRead,
  type FleetSeriesReadDeps,
} from './fleet-series-read';

/**
 * The fan-out's own tests, asking the questions the two route test files
 * cannot: not *what* comes back, but how many Queries are in flight at once and
 * what the fan-out does between batches.
 *
 * Those questions need a `querySeriesRange` that does not answer until the test
 * says so — a stub returning an already-resolved promise makes every batch look
 * sequential, because each read has finished before the next is started and a
 * whole batch at once and one site at a time record identically. So the stub
 * hands back promises it holds open, and "in flight" becomes a number the test
 * can read directly.
 *
 * Everything here is asserted through the module's exported surface —
 * `readFleetSeries` and {@link FLEET_READ_CONCURRENCY}
 * (`docs/standards/testing.md` rule 1) — and the width is referred to by name
 * rather than as `8`, so these tests keep biting if the width is retuned.
 */
class DeferredSeriesReads {
  /** One entry per Query the fan-out started, in dispatch order. */
  readonly dispatched: string[] = [];

  private readonly waiting: { siteId: string; settle: (result: SeriesRangeResult) => void }[] = [];

  /**
   * Narrower than `SeriesAdapter.querySeriesRange` on purpose: the window and
   * the pagination bound are the route tests' subject, and a parameter this
   * file never asserts on would only invite one.
   */
  querySeriesRange = (siteId: string): Promise<SeriesRangeResult> => {
    this.dispatched.push(siteId);
    return new Promise((settle) => {
      this.waiting.push({ siteId, settle });
    });
  };

  /** Dispatched and not yet answered — the number the concurrency claim is about. */
  get inFlight(): number {
    return this.waiting.length;
  }

  settleAll(resultFor: (siteId: string) => SeriesRangeResult): void {
    for (const { siteId, settle } of this.waiting.splice(0, this.waiting.length)) {
      settle(resultFor(siteId));
    }
  }

  settleOne(siteId: string, result: SeriesRangeResult): void {
    const index = this.waiting.findIndex((entry) => entry.siteId === siteId);
    const entry = this.waiting[index];
    if (!entry) {
      throw new Error(`settleOne: no read is in flight for ${siteId}`);
    }
    this.waiting.splice(index, 1);
    entry.settle(result);
  }
}

interface Harness {
  readonly deps: FleetSeriesReadDeps;
  readonly series: DeferredSeriesReads;
  readonly logged: Record<string, unknown>[];
}

const harness = (): Harness => {
  const series = new DeferredSeriesReads();
  const logged: Record<string, unknown>[] = [];

  return { series, logged, deps: { series, log: (entry) => logged.push(entry) } };
};

/** One window for every test here: which window is the route files' question. */
const FROM = utcIsoTimestampSchema.parse('2026-07-31T12:00:00Z');
const TO = utcIsoTimestampSchema.parse('2026-08-01T12:00:00Z');

/** A caller's event name, so a test can tell the logged line came from its argument. */
const READ_DEADLINE_EVENT = 'api.test-fan-out.read-deadline-reached';

/**
 * A fleet size, fixed rather than derived from {@link FLEET_READ_CONCURRENCY}.
 *
 * It has to be *bigger* than two batches at the shipped width for the tests
 * below to have a third batch to talk about — but it must not be written as a
 * multiple of the width, or the concurrency assertions become tautologies: a
 * fleet that grows with the batch is a fleet that is always exactly one batch,
 * and a widened width would then be provably invisible. Measured against a
 * fleet this size, `toHaveLength(FLEET_READ_CONCURRENCY)` is a real claim.
 */
const MANY_SITES = 20;

/** Distinct per site, so an out-of-order answer landing in the wrong slot is visible. */
const pointsFor = (siteId: string): SeriesPoint[] => [forecastPoint({ siteId })];

const wholeWindow = (siteId: string): SeriesRangeResult => ({
  points: pointsFor(siteId),
  complete: true,
});

const stoppedShort = (siteId: string): SeriesRangeResult => ({
  points: pointsFor(siteId),
  complete: false,
});

/**
 * Let every promise that is ready to settle settle.
 *
 * A `setTimeout` rather than a chain of `await Promise.resolve()`: the queue
 * drains before any timer fires, so one of these is enough however many
 * microtask hops the fan-out takes internally, and the test does not have to
 * know that number.
 */
const pendingWorkDone = async (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

/** Narrowing as an assertion: the wrong arm fails here rather than three lines later. */
const completedPerSite = (result: FleetSeriesRead): readonly (readonly SeriesPoint[])[] => {
  if (!result.complete) {
    throw new Error('expected the whole fleet, got a refusal');
  }
  return result.perSite;
};

const refusalOf = (result: FleetSeriesRead): ApiResponse => {
  if (result.complete) {
    throw new Error('expected a refusal, got the whole fleet');
  }
  return result.response;
};

/** `sites[index]` is `FleetSite | undefined` under `noUncheckedIndexedAccess`. */
const idAt = (sites: readonly FleetSite[], index: number): string => {
  const site = sites[index];
  if (!site) {
    throw new Error(`this fleet has no site at index ${String(index)}`);
  }
  return site.id;
};

describe('readFleetSeries', () => {
  it('never holds more than FLEET_READ_CONCURRENCY reads in flight', async () => {
    // Several batches' worth of fleet, and not one Query more than a batch is
    // started before any of them answers — the whole point of gating between
    // batches rather than dispatching the fleet.
    const { deps, series } = harness();
    const sites = fleetOfSize(MANY_SITES);

    const read = readFleetSeries(deps, fullBudgetDeadline, sites, FROM, TO, READ_DEADLINE_EVENT);
    await pendingWorkDone();

    expect(series.dispatched).toHaveLength(FLEET_READ_CONCURRENCY);
    expect(series.inFlight).toBe(FLEET_READ_CONCURRENCY);

    while (series.inFlight > 0) {
      series.settleAll(wholeWindow);
      await pendingWorkDone();
    }
    await read;
  });

  it('does not start the next batch until the previous one resolved', async () => {
    const { deps, series } = harness();
    const sites = fleetOfSize(MANY_SITES);
    const firstOfSecondBatch = idAt(sites, FLEET_READ_CONCURRENCY);

    const read = readFleetSeries(deps, fullBudgetDeadline, sites, FROM, TO, READ_DEADLINE_EVENT);
    await pendingWorkDone();

    expect(series.dispatched).not.toContain(firstOfSecondBatch);

    series.settleAll(wholeWindow);
    await pendingWorkDone();

    expect(series.dispatched).toContain(firstOfSecondBatch);
    expect(series.dispatched).toHaveLength(FLEET_READ_CONCURRENCY * 2);

    while (series.inFlight > 0) {
      series.settleAll(wholeWindow);
      await pendingWorkDone();
    }

    // Every site read once, and the fleet comes back whole.
    expect(series.dispatched).toHaveLength(sites.length);
    expect(completedPerSite(await read)).toHaveLength(sites.length);
  });

  it('preserves site order when reads resolve out of order', async () => {
    // Two sites share one batch, so the network — not the loop — decides which
    // answers first. `Promise.all` is what makes the wire order the fleet's
    // order regardless, and this is the test that says so.
    const { deps, series } = harness();
    const sites = [fleetSite(), fleetSite({ id: RATHMINES_ID, name: 'Rathmines terrace' })];

    const read = readFleetSeries(deps, fullBudgetDeadline, sites, FROM, TO, READ_DEADLINE_EVENT);
    await pendingWorkDone();

    expect(series.inFlight).toBe(2);
    series.settleOne(RATHMINES_ID, wholeWindow(RATHMINES_ID));
    series.settleOne(RANELAGH_ID, wholeWindow(RANELAGH_ID));

    expect(completedPerSite(await read)).toEqual([pointsFor(RANELAGH_ID), pointsFor(RATHMINES_ID)]);
  });

  it('refuses between batches when the budget is gone, whole-or-nothing', async () => {
    // One site more than a batch holds, and no time left: the first batch is
    // this fan-out's ungated prefix, the second is refused before it starts,
    // and the sites already read are not served as a fleet.
    const { deps, series, logged } = harness();
    const sites = fleetOfSize(FLEET_READ_CONCURRENCY + 1);

    const read = readFleetSeries(deps, countdownDeadline(0), sites, FROM, TO, READ_DEADLINE_EVENT);
    await pendingWorkDone();
    expect(series.dispatched).toHaveLength(FLEET_READ_CONCURRENCY);

    // Answering whatever is in flight until nothing is, rather than settling
    // once: a gate that stopped refusing would leave the ninth site's Query
    // hanging, and this loop turns that into a failed assertion below instead
    // of into a test that times out with nothing to say.
    while (series.inFlight > 0) {
      series.settleAll(wholeWindow);
      await pendingWorkDone();
    }

    const response = refusalOf(await read);
    expect(response.statusCode).toBe(500);
    expect(apiErrorSchema.parse(jsonBodyOf(response)).code).toBe('internal');
    expect(series.dispatched).toHaveLength(FLEET_READ_CONCURRENCY);
    expect(logged).toEqual([
      {
        event: READ_DEADLINE_EVENT,
        sitesRead: FLEET_READ_CONCURRENCY,
        fleetSize: FLEET_READ_CONCURRENCY + 1,
      },
    ]);
  });

  it('refuses when a site’s window stopped short, logging the first in site order though it answered last, and reading no further batch', async () => {
    // Two sites in one batch stop short — which a concurrent fan-out can do and
    // a one-at-a-time one could not — and the two orders that could name the
    // logged site are deliberately opposed: the *later* of them in site order
    // answers *first*, and site 0 answers last of the whole batch. So a fan-out
    // that recorded whichever short site answered soonest names site 3, and one
    // that scanned the settled batch from the back names site 3 too; only
    // judging the batch in site order names site 0. The next batch never
    // starts either: more sites cannot make a truncated answer whole.
    const { deps, series, logged } = harness();
    const sites = fleetOfSize(FLEET_READ_CONCURRENCY + 1);
    const firstShortInSiteOrder = idAt(sites, 0);
    const lastShortInSiteOrder = idAt(sites, 3);

    const read = readFleetSeries(deps, fullBudgetDeadline, sites, FROM, TO, READ_DEADLINE_EVENT);
    await pendingWorkDone();

    series.settleOne(lastShortInSiteOrder, stoppedShort(lastShortInSiteOrder));
    for (const siteId of series.dispatched.filter(
      (id) => id !== firstShortInSiteOrder && id !== lastShortInSiteOrder,
    )) {
      series.settleOne(siteId, wholeWindow(siteId));
    }
    series.settleOne(firstShortInSiteOrder, stoppedShort(firstShortInSiteOrder));

    expect(refusalOf(await read).statusCode).toBe(500);
    expect(series.dispatched).toHaveLength(FLEET_READ_CONCURRENCY);
    expect(logged).toEqual([{ event: READ_DEADLINE_EVENT, siteId: firstShortInSiteOrder }]);
  });
});
