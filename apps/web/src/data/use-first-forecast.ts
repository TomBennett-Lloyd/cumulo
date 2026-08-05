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
 * watching a spinner with no ending. Reaching it is a product event — the site's
 * card says the wait ended and offers a retry — not a silent stall.
 */
const FIRST_FORECAST_DEADLINE_MS = 90_000;

/**
 * The deadline as the diagnostic messages spell it.
 *
 * Derived once rather than in each sentence: both deadline messages are about
 * the same timer, so a second derivation would be a place for them to disagree
 * about the number the visitor actually waited out.
 */
const DEADLINE_SECONDS_TEXT = String(FIRST_FORECAST_DEADLINE_MS / MS_PER_SECOND);

/**
 * The state every watch starts in, and stays in until the fleet answers.
 *
 * A module constant rather than a fresh object per run: re-entering it is then
 * a no-op for React (it bails out of re-rendering on an identical value), which
 * matters because every effect run begins by resetting to it — and because
 * every fault-poll before absence is confirmed re-enters it too, so a fleet
 * that is failing repeatedly re-renders the card zero times.
 */
const WATCH_START_STATE: ForecastViewState = { status: 'checking' };

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
 * An `ok` carrying no forecasts is treated as "not yet" rather than as success,
 * and what a premature `ready` costs moved with the surfaces in #265. It used to
 * be a per-site table drawn with no rows in it. Now `ready` is the state that
 * retires the card's visible wait *and* releases `FleetPanel`'s overlay request
 * (`selectionReady`), so an empty series would take the count off the screen and
 * put a named-but-empty line in the fleet chart's legend and table — the reader
 * is told the answer arrived and shown a gap where it should be. "Still
 * waiting" and "this site produces nothing" are different sentences, and only
 * one of them is true here.
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
    case 'server-fault':
      // A dropped connection comes back and a payload this client could not
      // read can be a record the pipeline is still writing, so waiting is worth
      // something for those two. `server-fault` joins them for the same reason
      // its own arm states: a fleet that answered "I am broken" can be working
      // again before the deadline, and the visitor has nothing else to do
      // meanwhile. `invalid-request` is grouped with them rather than halted
      // deliberately: halting is reserved for the one arm whose recourse is
      // unambiguous, and a fault the loop cannot classify that confidently is
      // better given the full wait than cut short. All four therefore keep the
      // cadence and let the deadline decide when to stop — and the message is
      // remembered, so a deadline reached this way is reported as an error
      // rather than as a wait.
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
  // return type makes an eighth `FleetDataError` code a compile error here —
  // rather than letting it fall silently into "keep waiting", which is how
  // `invalid-request` and `forbidden` inherited a policy nobody chose for them.
};

const generatingSince = (startedAtMs: number, nowMs: number): ForecastViewState => ({
  status: 'generating',
  elapsedSeconds: Math.floor((nowMs - startedAtMs) / MS_PER_SECOND),
});

/**
 * What the card is told when the deadline passes.
 *
 * Three outcomes, because the run can reach ninety seconds having learned three
 * different things — and the card has a different sentence for each:
 *
 * - a fault was seen, so the deadline is an `error` carrying the fleet's own
 *   account of it;
 * - absence was confirmed, so the wait really was the pipeline's first-forecast
 *   wait and running out of it is a `timeout`;
 * - neither, so no poll ever came back at all: the run spent the whole deadline
 *   in `checking` and `unanswered` is the only honest reason. Claiming a
 *   timeout here would assert the pipeline is behind on a site whose forecast
 *   may well already exist (#177's review; the tech-debt entry this consumes).
 *
 * `absenceConfirmed` is a parameter rather than something read from the
 * enclosing run, so this stays legible on its own (`structure.md` rule 1).
 * Both messages carry the site the wait was about (`error-handling.md` rule 4)
 * so a screenshot of a failed card is diagnosable on its own.
 */
const deadlineState = (
  siteId: Site['id'],
  lastFault: string | null,
  absenceConfirmed: boolean,
): ForecastViewState => {
  if (lastFault !== null) {
    return { status: 'failed', reason: 'error', message: lastFault };
  }
  if (absenceConfirmed) {
    return {
      status: 'failed',
      reason: 'timeout',
      message: `No forecast for site ${siteId} after ${DEADLINE_SECONDS_TEXT} seconds`,
    };
  }
  return {
    status: 'failed',
    reason: 'unanswered',
    message: `No answer for site ${siteId} within ${DEADLINE_SECONDS_TEXT} seconds`,
  };
};

export interface FirstForecastWatch {
  /**
   * The selection's forecast state, for the two surfaces that read it: the site's
   * card on the map renders the wait, the failure and the halt
   * (`map/SitePopoverCard.tsx`), and `FleetPanel` reads `ready` as permission to
   * fetch that site's own hours for the chart's overlay.
   */
  readonly state: ForecastViewState;
  /** Abandons the current wait and starts a fresh one, deadline included. */
  readonly retry: () => void;
}

/**
 * Watches one site until its first forecast exists.
 *
 * `siteId` is the site created moments ago whose forecast the visitor is
 * waiting for — `null` while nothing is being watched, which reports the
 * neutral `checking` state and starts no timers. The id must be the
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
    /** The last fault seen this run; picks the `error` arm at the deadline. */
    let lastFault: string | null = null;
    /**
     * Whether the fleet has told this run the forecast does not exist yet.
     *
     * `decidePoll` already encodes exactly that: a `keep-waiting` with
     * `fault === null` is a `not-found`, or an `ok` carrying an empty series —
     * both of which are the fleet answering "there is nothing here", which is
     * the only evidence a client has that a first forecast is genuinely being
     * generated. A `keep-waiting` *with* a fault is the fleet failing to
     * answer, and says nothing about existence, so it must not promote the
     * watch out of `checking` (#177). Latched rather than recomputed per poll:
     * once absence is confirmed, a later network blip does not un-confirm it.
     *
     * The deadline asks the same question at the end: ninety seconds reached
     * without this ever being set means no poll established anything, which is
     * `unanswered` rather than a pipeline timeout.
     */
    let absenceConfirmed = false;

    const stopPolling = (): void => {
      stopped = true;
      if (pollTimer !== undefined) {
        clearTimeout(pollTimer);
        pollTimer = undefined;
      }
    };

    // Both bindings are read when the timer fires, not when it is registered:
    // they are this run's own `let`s, so the deadline is decided on everything
    // the run had learned by the ninetieth second.
    const deadlineTimer = setTimeout(() => {
      stopPolling();
      setState(deadlineState(siteId, lastFault, absenceConfirmed));
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
      // so the deadline has nothing left to decide and the card is told now
      // rather than in ninety seconds. It reports in its own arm rather than as
      // a failure, so the card can drop the retry no retry can change.
      if (decision.kind === 'halt') {
        stopWatching();
        setState({ status: 'halted', message: decision.message });
        return;
      }

      if (decision.fault === null) {
        absenceConfirmed = true;
      }
      lastFault = decision.fault ?? lastFault;
      setState(absenceConfirmed ? generatingSince(startedAtMs, Date.now()) : WATCH_START_STATE);
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
    // reset so the card leaves its failed rendering in the same commit the
    // visitor clicked in, and the token bump so the effect starts a new run.
    setState(WATCH_START_STATE);
    setAttempt((previous) => previous + 1);
  }, []);

  return { state, retry };
};
