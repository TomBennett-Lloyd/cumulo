import type { Forecast, Site } from '@cumulo/shared';
import { useCallback, useEffect, useState } from 'react';

import type { ForecastViewState } from '../dashboard/forecast-view-state';
import type { FleetSourceResult, FleetDataSource } from './fleet-data-source';

const MS_PER_SECOND = 1_000;

/**
 * Gap between forecast polls.
 *
 * Two constraints meet here. The ticket promises a first forecast visible about
 * a minute after the visitor adds a site, and the client can only guarantee
 * "within one poll of the forecast existing" — so the interval is the slack the
 * pipeline does not get. Five seconds on top of the demo pipeline's 45 leaves
 * the promise intact with room to spare.
 *
 * The other constraint is read capacity. Each poll reads one site's own
 * partition (~0.5 read units, per ADR 0002's review of this ticket); the fleet
 * fan-out `listSites` costs ~25, so a loop that re-listed the fleet every five
 * seconds would let three open tabs saturate the table's provisioned capacity
 * on their own — and would arrive as a bill rather than a throttle under
 * on-demand. This loop therefore calls `getSiteForecast` and nothing else.
 */
const POLL_INTERVAL_MS = 5_000;

/**
 * Floor under a rate-limit backoff.
 *
 * `retryAfterSeconds` is the server's number and is honoured whenever it is
 * larger; the floor exists for the case where it is absent or small, so that a
 * "not now" can never make the loop poll *faster* than its ordinary cadence
 * (`error-handling.md` rule 3: back off, never hot-retry).
 */
const MIN_RATE_LIMIT_BACKOFF_SECONDS = 5;

/**
 * How long a first forecast is worth waiting for.
 *
 * Twice the demo pipeline's 45-second latency: long enough that an ordinarily
 * slow pipeline is not called broken, short enough that a visitor is not left
 * watching a spinner with no ending. Reaching it is a product event — the panel
 * says the wait ended and offers a retry — not a silent stall.
 */
const FIRST_FORECAST_DEADLINE_MS = 90_000;

/**
 * The state every watch starts in.
 *
 * A module constant rather than a fresh object per run: re-entering it is then
 * a no-op for React (it bails out of re-rendering on an identical value), which
 * matters because every effect run begins by resetting to it.
 */
const WATCH_START_STATE: ForecastViewState = { status: 'pending', elapsedSeconds: 0 };

/**
 * What one poll's answer means for the loop.
 *
 * `fault` separates the two ways of not having a forecast yet: `null` is the
 * ordinary "the pipeline has not finished" (a `not-found`, or an empty series),
 * while a message means the fleet actually answered with a fault. Only that
 * distinction decides whether hitting the deadline is reported as a timeout or
 * as an error, so it is carried per-poll rather than recovered afterwards.
 *
 * `halt` is the third answer, and the one that makes waiting pointless: the
 * fleet has said something that the next ninety seconds cannot change, so the
 * loop stops now and reports it now.
 */
type PollDecision =
  | { readonly kind: 'ready'; readonly forecasts: readonly Forecast[] }
  | {
      readonly kind: 'keep-waiting';
      readonly delayMs: number;
      readonly fault: string | null;
    }
  | { readonly kind: 'halt'; readonly message: string };

const rateLimitBackoffMs = (retryAfterSeconds: number | undefined): number =>
  Math.max(retryAfterSeconds ?? 0, MIN_RATE_LIMIT_BACKOFF_SECONDS) * MS_PER_SECOND;

/**
 * The whole policy of the loop, as a pure function of one answer.
 *
 * An `ok` carrying no forecasts is treated as "not yet" rather than as success:
 * a `ready` state with an empty series would render a panel with a forecast
 * table and no rows, which reads as "this site produces nothing" instead of
 * "this site is still waiting".
 */
const decidePoll = (result: FleetSourceResult<readonly Forecast[]>): PollDecision => {
  if (result.kind === 'ok') {
    return result.value.length > 0
      ? { kind: 'ready', forecasts: result.value }
      : { kind: 'keep-waiting', delayMs: POLL_INTERVAL_MS, fault: null };
  }

  const { error } = result;
  switch (error.code) {
    case 'not-found':
      // The normal answer for a site created seconds ago — not a failure.
      return { kind: 'keep-waiting', delayMs: POLL_INTERVAL_MS, fault: null };
    case 'rate-limited':
      return {
        kind: 'keep-waiting',
        delayMs: rateLimitBackoffMs(error.retryAfterSeconds),
        fault: error.message,
      };
    case 'network':
    case 'invalid-response':
    case 'invalid-request':
      // A dropped connection comes back and a payload this client could not
      // read can be a record the pipeline is still writing, so waiting is worth
      // something for those two. `invalid-request` is grouped with them rather
      // than halted deliberately: halting is reserved for the one arm whose
      // recourse is unambiguous, and a fault the loop cannot classify that
      // confidently is better given the full wait than cut short. All three
      // therefore keep the cadence and let the deadline decide when to stop —
      // and the message is remembered, so a deadline reached this way is
      // reported as an error rather than as a wait.
      return { kind: 'keep-waiting', delayMs: POLL_INTERVAL_MS, fault: error.message };
    case 'forbidden':
      // The arm's own contract: what is wrong is *who is asking*, and its
      // recourse is a deployment change (`CUMULO_WEB_ORIGINS`). Nothing the
      // loop can do changes the answer, so waiting out ninety seconds before
      // saying so buys the visitor nothing — and a view that then rendered it
      // as "try again" would be telling them to do the one thing that cannot
      // work (the anti-pattern #150's review named).
      return { kind: 'halt', message: error.message };
  }
  // Every code is enumerated and there is no catch-all arm, so the declared
  // return type makes a seventh `FleetDataError` code a compile error here —
  // rather than letting it fall silently into "keep waiting", which is how
  // `invalid-request` and `forbidden` inherited a policy nobody chose for them.
};

const pendingSince = (startedAtMs: number, nowMs: number): ForecastViewState => ({
  status: 'pending',
  elapsedSeconds: Math.floor((nowMs - startedAtMs) / MS_PER_SECOND),
});

/**
 * What the panel is told when the deadline passes.
 *
 * The message carries the site the wait was about (`error-handling.md` rule 4)
 * so a screenshot of a failed panel is diagnosable on its own.
 */
const deadlineState = (siteId: Site['id'], lastFault: string | null): ForecastViewState =>
  lastFault === null
    ? {
        status: 'failed',
        reason: 'timeout',
        message: `No forecast for site ${siteId} after ${String(
          FIRST_FORECAST_DEADLINE_MS / MS_PER_SECOND,
        )} seconds`,
      }
    : { status: 'failed', reason: 'error', message: lastFault };

export interface FirstForecastWatch {
  /** What the site detail panel should render right now. */
  readonly state: ForecastViewState;
  /** Abandons the current wait and starts a fresh one, deadline included. */
  readonly retry: () => void;
}

/**
 * Watches one site until its first forecast exists.
 *
 * `siteId` is the site created moments ago whose forecast the visitor is
 * waiting for — `null` while nothing is being watched, which reports the
 * neutral pending state and starts no timers. The id must be the
 * server-assigned one returned by `createSite`: polling a locally predicted id
 * addresses a site that does not exist, and this loop would wait out its whole
 * deadline on it.
 *
 * The polling loop is the external system this hook synchronizes with
 * (`react.md` rule 1) — timers and in-flight requests are set up by the effect
 * and torn down by its cleanup, so an unmount, a change of site, or a `retry()`
 * all end the current run rather than leaving it writing to state it no longer
 * owns.
 */
export const useFirstForecast = (
  dataSource: FleetDataSource,
  siteId: Site['id'] | null,
): FirstForecastWatch => {
  const [state, setState] = useState<ForecastViewState>(WATCH_START_STATE);
  /**
   * A run token, not a value the run reads: bumping it is how `retry` asks
   * React to tear down the current run and start a fresh one. It belongs in the
   * dependency array because it genuinely is part of the effect's identity —
   * "which attempt is this" — and the array stays honest as a result.
   */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setState(WATCH_START_STATE);
    if (siteId === null) {
      return;
    }

    const startedAtMs = Date.now();
    let stopped = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    /** The last fault seen this run; decides timeout-vs-error at the deadline. */
    let lastFault: string | null = null;

    const stopPolling = (): void => {
      stopped = true;
      if (pollTimer !== undefined) {
        clearTimeout(pollTimer);
        pollTimer = undefined;
      }
    };

    const deadlineTimer = setTimeout(() => {
      stopPolling();
      setState(deadlineState(siteId, lastFault));
    }, FIRST_FORECAST_DEADLINE_MS);

    const stopWatching = (): void => {
      stopPolling();
      clearTimeout(deadlineTimer);
    };

    const poll = async (): Promise<void> => {
      const result = await dataSource.getSiteForecast(siteId);

      // The answer to a superseded poll — unmounted, site changed, retried, or
      // the deadline passed while this request was in flight — is discarded.
      // It describes a run that no longer owns this state.
      if (stopped) {
        return;
      }

      const decision = decidePoll(result);
      if (decision.kind === 'ready') {
        stopWatching();
        setState({ status: 'ready', forecasts: decision.forecasts });
        return;
      }

      // A halt ends the run exactly like an arrival does — the answer is final,
      // so the deadline has nothing left to decide and the panel is told now
      // rather than in ninety seconds.
      if (decision.kind === 'halt') {
        stopWatching();
        setState({ status: 'failed', reason: 'error', message: decision.message });
        return;
      }

      lastFault = decision.fault ?? lastFault;
      setState(pendingSince(startedAtMs, Date.now()));
      pollTimer = setTimeout(() => {
        void poll();
      }, decision.delayMs);
    };

    // Immediately, then on the cadence above: a site whose forecast already
    // exists (any site but a brand-new one) is ready without waiting a tick.
    void poll();

    return stopWatching;
  }, [dataSource, siteId, attempt]);

  const retry = useCallback(() => {
    // Both halves belong to the interaction (`react.md` rule 1): the state
    // reset so the panel leaves its failed rendering in the same commit the
    // visitor clicked in, and the token bump so the effect starts a new run.
    setState(WATCH_START_STATE);
    setAttempt((previous) => previous + 1);
  }, []);

  return { state, retry };
};
