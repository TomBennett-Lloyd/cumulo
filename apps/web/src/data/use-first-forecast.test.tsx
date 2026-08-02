// @vitest-environment jsdom

import { type Site } from '@cumulo/shared';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  advanceBy,
  alwaysAnswering,
  answerCall,
  deferredAnswer,
  forecastAfterMs,
  forecastReady,
  networkDown,
  notFound,
  rateLimitedFirst,
  ScriptedFleetDataSource,
  settle,
  SITE_ID,
  type ForecastResolver,
} from './first-forecast-test-fixture';
import { useFirstForecast } from './use-first-forecast';

/**
 * A second site, for the one test about moving on from the first.
 *
 * It stays here rather than in the fixture because nothing in the fixture knows
 * it: {@link ScriptedFleetDataSource} answers whatever site it is asked about,
 * and only this suite ever needs two of them.
 */
const OTHER_SITE_ID = '3c3d3e3f-0000-4000-8000-000000000002';

/** The instant every fake-timer test starts from, so elapsed time is readable. */
const START_MS = Date.UTC(2026, 6, 31, 9, 0, 0);

/**
 * A 403 as `fleet-api-result.ts` renders it, quoted rather than derived.
 *
 * The recourse named in the text is the whole reason this code halts the loop,
 * so the test asserts on the message a real refusal would carry.
 */
const FORBIDDEN_MESSAGE =
  "getSiteForecast: refused by the API's access policy — 403. This deployment's origin has to be in the API's CUMULO_WEB_ORIGINS; retrying cannot help.";

/** A 400 as the same module renders it: the request was wrong, not the client. */
const INVALID_REQUEST_MESSAGE = 'getSiteForecast: the API rejected the request — bad site id';

/** Simulated milliseconds since the watch began. */
const simulatedElapsedMs = (): number => Date.now() - START_MS;

interface WatchProps {
  readonly siteId: Site['id'] | null;
}

describe('useFirstForecast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  // The ticket's headline promise, measured rather than asserted by structure:
  // a pipeline that takes 48 s must be visible within one poll of finishing.
  it('shows a 48-second forecast inside the ticket’s minute, one poll after it exists', async () => {
    const source = new ScriptedFleetDataSource(forecastAfterMs(48_000, SITE_ID));
    const watch = renderHook(() => useFirstForecast(source, SITE_ID));

    await settle();
    expect(watch.result.current.state.status).toBe('pending');

    await advanceBy(45_000);
    const waiting = watch.result.current.state;
    expect(waiting.status === 'pending' && waiting.elapsedSeconds).toBe(45);

    while (watch.result.current.state.status === 'pending' && simulatedElapsedMs() < 60_000) {
      await advanceBy(1_000);
    }

    const ready = watch.result.current.state;
    expect(ready.status).toBe('ready');
    expect(ready.status === 'ready' && ready.forecasts[0]?.siteId).toBe(SITE_ID);
    expect(simulatedElapsedMs()).toBeLessThanOrEqual(53_000);
  });

  // ADR 0002's review of this ticket: a per-site read is ~0.5 read units, the
  // fleet fan-out ~25. A loop that re-listed the fleet would let three open
  // tabs exhaust the table's capacity between them.
  it('reads only the watched site’s own partition, never the fleet fan-out', async () => {
    const source = new ScriptedFleetDataSource(forecastAfterMs(48_000, SITE_ID));
    renderHook(() => useFirstForecast(source, SITE_ID));

    await advanceBy(50_000);

    expect(source.calls.length).toBeGreaterThan(1);
    expect(new Set(source.calls)).toEqual(new Set([`getSiteForecast:${SITE_ID}`]));
  });

  it('stops polling once the forecast is ready', async () => {
    const source = new ScriptedFleetDataSource(forecastAfterMs(48_000, SITE_ID));
    const watch = renderHook(() => useFirstForecast(source, SITE_ID));

    await advanceBy(50_000);
    expect(watch.result.current.state.status).toBe('ready');
    const callsAtReady = source.calls.length;
    // Both timers are gone, not just the poll: a deadline left running would
    // fire later and overwrite a forecast the visitor is already reading.
    expect(vi.getTimerCount()).toBe(0);

    await advanceBy(60_000);

    expect(source.calls.length).toBe(callsAtReady);
    expect(watch.result.current.state.status).toBe('ready');
  });

  // A `ready` state carrying no forecasts would render the panel's table with
  // no rows, which reads as "this site produces nothing" rather than "still
  // waiting" — so an empty series is a wait, not an arrival.
  it('keeps waiting when the fleet answers with an empty forecast series', async () => {
    const source = new ScriptedFleetDataSource(alwaysAnswering({ kind: 'ok', value: [] }));
    const watch = renderHook(() => useFirstForecast(source, SITE_ID));

    await advanceBy(10_000);

    expect(watch.result.current.state.status).toBe('pending');
    expect(source.calls.length).toBeGreaterThan(1);
  });

  it('gives up at the 90-second deadline as a timeout, naming the site it waited for', async () => {
    const source = new ScriptedFleetDataSource(alwaysAnswering(notFound(SITE_ID)));
    const watch = renderHook(() => useFirstForecast(source, SITE_ID));

    await advanceBy(89_000);
    expect(watch.result.current.state.status).toBe('pending');

    await advanceBy(1_000);

    const failed = watch.result.current.state;
    expect(failed.status).toBe('failed');
    expect(failed.status === 'failed' && failed.reason).toBe('timeout');
    expect(failed.status === 'failed' && failed.message).toContain(SITE_ID);
  });

  it('resumes polling when the visitor retries a wait that timed out', async () => {
    const source = new ScriptedFleetDataSource(alwaysAnswering(notFound(SITE_ID)));
    const watch = renderHook(() => useFirstForecast(source, SITE_ID));

    await advanceBy(90_000);
    const callsAtDeadline = source.calls.length;
    await advanceBy(30_000);
    expect(source.calls.length).toBe(callsAtDeadline);

    act(() => {
      watch.result.current.retry();
    });
    await settle();

    expect(watch.result.current.state.status).toBe('pending');
    expect(source.calls.length).toBeGreaterThan(callsAtDeadline);
  });

  // A fault is not a wait: the panel says something different for each, so the
  // reason has to reflect what was actually seen (`forecast-view-state.ts`).
  it('reports a deadline reached through faults as an error carrying the last message', async () => {
    const source = new ScriptedFleetDataSource(alwaysAnswering(networkDown()));
    const watch = renderHook(() => useFirstForecast(source, SITE_ID));

    await advanceBy(90_000);

    const failed = watch.result.current.state;
    expect(failed.status === 'failed' && failed.reason).toBe('error');
    expect(failed.status === 'failed' && failed.message).toBe('The fleet did not answer');
    // It kept polling through the faults rather than giving up on the first one.
    expect(source.calls.length).toBeGreaterThan(1);
  });

  it('waits out a stated rate-limit backoff before polling again', async () => {
    const source = new ScriptedFleetDataSource(rateLimitedFirst(12, SITE_ID));
    renderHook(() => useFirstForecast(source, SITE_ID));

    await settle();
    expect(source.calls).toHaveLength(1);

    await advanceBy(11_999);
    expect(source.calls).toHaveLength(1);

    await advanceBy(1);
    expect(source.calls).toHaveLength(2);
  });

  // A server saying "wait 1 second" must not make the loop poll five times
  // faster than its own cadence (`error-handling.md` rule 3).
  it('never polls faster than its own cadence when the stated backoff is shorter', async () => {
    const source = new ScriptedFleetDataSource(rateLimitedFirst(1, SITE_ID));
    renderHook(() => useFirstForecast(source, SITE_ID));

    await settle();
    await advanceBy(4_999);
    expect(source.calls).toHaveLength(1);

    await advanceBy(1);
    expect(source.calls).toHaveLength(2);
  });

  /*
   * The one refusal waiting cannot outlast. `forbidden` is about *who is
   * asking*, and its recourse is a deployment change — so the ninety seconds
   * the loop would otherwise spend are ninety seconds of telling the visitor
   * nothing, ending in a panel offering a retry that cannot work.
   */
  it('stops the wait immediately when the fleet forbids this client', async () => {
    const source = new ScriptedFleetDataSource(
      alwaysAnswering({ kind: 'error', error: { code: 'forbidden', message: FORBIDDEN_MESSAGE } }),
    );
    const watch = renderHook(() => useFirstForecast(source, SITE_ID));

    await settle();

    const failed = watch.result.current.state;
    expect(failed.status).toBe('failed');
    expect(failed.status === 'failed' && failed.reason).toBe('error');
    expect(failed.status === 'failed' && failed.message).toBe(FORBIDDEN_MESSAGE);

    // The deadline is torn down with the poll: nothing is still due to fire,
    // and the whole ninety seconds passes without a second attempt.
    await advanceBy(90_000);

    expect(source.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  // The halt belongs to `forbidden` alone. `invalid-request` is about the bytes
  // we sent, which a later poll can find already fixed upstream — so it keeps
  // the ordinary cadence and only the deadline ends the wait.
  it('keeps polling through an invalid-request fault and reports it at the deadline', async () => {
    const source = new ScriptedFleetDataSource(
      alwaysAnswering({
        kind: 'error',
        error: { code: 'invalid-request', message: INVALID_REQUEST_MESSAGE },
      }),
    );
    const watch = renderHook(() => useFirstForecast(source, SITE_ID));

    await advanceBy(90_000);

    const failed = watch.result.current.state;
    expect(failed.status).toBe('failed');
    expect(failed.status === 'failed' && failed.reason).toBe('error');
    expect(failed.status === 'failed' && failed.message).toBe(INVALID_REQUEST_MESSAGE);
    expect(source.calls.length).toBeGreaterThan(1);
  });

  // The halt ends this run, not the hook: a visitor whose deployment was fixed
  // between the two clicks gets a fresh wait, not a permanently dead panel.
  it('retry restarts polling after a forbidden halt', async () => {
    const source = new ScriptedFleetDataSource(
      alwaysAnswering({ kind: 'error', error: { code: 'forbidden', message: FORBIDDEN_MESSAGE } }),
    );
    const watch = renderHook(() => useFirstForecast(source, SITE_ID));

    await settle();
    expect(watch.result.current.state.status).toBe('failed');

    act(() => {
      watch.result.current.retry();
    });

    expect(watch.result.current.state.status).toBe('pending');
    expect(source.calls).toHaveLength(2);

    // The fresh run reaches the same verdict, because the fleet still refuses.
    await settle();
    expect(watch.result.current.state.status).toBe('failed');
  });

  it('makes no call and leaves no timer after unmount, even when a poll answers late', async () => {
    const resolvers: ForecastResolver[] = [];
    const source = new ScriptedFleetDataSource(deferredAnswer(resolvers));
    const watch = renderHook(() => useFirstForecast(source, SITE_ID));
    await settle();

    watch.unmount();
    expect(vi.getTimerCount()).toBe(0);

    // The abandoned request comes back after the component is gone, carrying
    // the ordinary "not yet". Without the stale-run guard that answer would
    // schedule the next poll from a run nobody is watching — which is what the
    // call log and timer count below catch.
    await act(async () => {
      answerCall(resolvers, 0, notFound(SITE_ID));
      await Promise.resolve();
    });
    await advanceBy(60_000);

    expect(source.calls).toEqual([`getSiteForecast:${SITE_ID}`]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('discards the answer to a poll for a site the visitor has moved on from', async () => {
    const resolvers: ForecastResolver[] = [];
    const source = new ScriptedFleetDataSource(deferredAnswer(resolvers));
    const watch = renderHook(({ siteId }: WatchProps) => useFirstForecast(source, siteId), {
      initialProps: { siteId: SITE_ID },
    });
    await settle();

    watch.rerender({ siteId: OTHER_SITE_ID });
    await settle();
    expect(source.calls).toEqual([
      `getSiteForecast:${SITE_ID}`,
      `getSiteForecast:${OTHER_SITE_ID}`,
    ]);

    // The first site's forecast lands after the watch moved to the second one.
    await act(async () => {
      answerCall(resolvers, 0, forecastReady(SITE_ID));
      await Promise.resolve();
    });

    expect(watch.result.current.state.status).toBe('pending');
  });

  it('starts no polling at all while no site is being watched', async () => {
    const source = new ScriptedFleetDataSource(alwaysAnswering(forecastReady(SITE_ID)));
    const watch = renderHook(({ siteId }: WatchProps) => useFirstForecast(source, siteId), {
      initialProps: { siteId: null },
    });

    await advanceBy(90_000);

    expect(source.calls).toEqual([]);
    expect(watch.result.current.state).toEqual({ status: 'pending', elapsedSeconds: 0 });
  });

  /*
   * `testing.md` rule 7. Every test above neuters the clock — fake timers are
   * the only way to reach a 90-second deadline in a unit suite — so one test
   * has to run the configuration that ships: the real clock, real timers, and
   * the module's own cadence and deadline constants, none of which are
   * injectable. It proves the part of the promise that needs no clock at all:
   * the first poll is issued on mount rather than one interval later, which is
   * what makes a site whose forecast already exists render immediately.
   */
  it('polls immediately on mount with the real clock and the shipped constants', async () => {
    vi.useRealTimers();
    const source = new ScriptedFleetDataSource(alwaysAnswering(forecastReady(SITE_ID)));

    const watch = renderHook(() => useFirstForecast(source, SITE_ID));
    await settle();

    expect(watch.result.current.state.status).toBe('ready');
    expect(source.calls).toEqual([`getSiteForecast:${SITE_ID}`]);
  });
});
