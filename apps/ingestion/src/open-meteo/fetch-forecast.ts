import { z } from 'zod';

import { describeThrown } from '../thrown-detail';
import { parseForecastResponse, type ForecastWeatherReading } from './response';
import { buildForecastUrl, type ForecastLocation } from './url';

/**
 * The HTTP adapter for Open-Meteo: the one module in this service allowed to
 * touch the network (architecture.md rule 3). Request construction and response
 * normalization stay in `url.ts` / `response.ts`, so what is left here is purely
 * the failure policy — timeout, retry, and how each provider answer maps onto an
 * outcome the caller must handle.
 *
 * Standalone functions over an explicit policy, rather than a client object: there
 * is no state here that outlives a call — a resolved timeout, a `fetch` and a
 * jitter source are configuration, not shared mutable state — so every step is a
 * function of its arguments alone, and `attemptFetch`, the piece that carries the
 * whole mapping from provider answer to outcome, is legible without tracing what
 * some enclosing scope captured.
 */

/**
 * Every way a forecast fetch can end, as a value rather than a throw
 * (error-handling.md rule 1). The four cases exist because the caller's action
 * differs for each: `ok` stores readings, `rate-limited` backs off until the next
 * hourly cycle, `malformed` alerts (the provider contract moved), `unreachable`
 * is logged and left for the next cycle.
 */
export type FetchForecastOutcome =
  | { outcome: 'ok'; readings: ForecastWeatherReading[]; droppedHours: number }
  | { outcome: 'rate-limited' }
  | { outcome: 'malformed'; detail: string }
  | { outcome: 'unreachable'; detail: string };

/**
 * The parts of the failure policy a caller may override. Every field is optional
 * because production overrides none of them — the defaults *are* the shipped
 * policy — and a test replaces exactly the pieces that would otherwise reach the
 * network or the wall clock.
 */
export interface ForecastFetchDeps {
  /** Defaults to the global `fetch`; tests pass a stub so no test hits the network. */
  readonly fetchFn?: typeof fetch;
  /** Per-attempt deadline. Defaults to {@link defaultTimeoutMs}. */
  readonly timeoutMs?: number;
  /** Retry delay. Injectable so tests assert the delay instead of waiting it out. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Jitter source, uniform over [0, 1). Defaults to `Math.random`. */
  readonly random?: () => number;
}

/**
 * The same policy with nothing left to default, which is what every step below
 * takes. Resolving once at the entry point keeps the defaults in one place and
 * leaves the steps under it free of `??`, so a retry cannot run under a policy that
 * differs from the attempt before it.
 */
export interface ForecastFetchPolicy {
  readonly fetchFn: typeof fetch;
  readonly timeoutMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
}

/**
 * One attempt's whole input: the resolved policy, the location the readings will be
 * keyed by, and the URL to request. The URL is built once per call rather than once
 * per attempt — a retry has to repeat the same request, not a freshly derived one.
 */
export interface ForecastAttempt {
  readonly policy: ForecastFetchPolicy;
  readonly location: ForecastLocation;
  readonly url: string;
}

/**
 * The adapter as its consumer holds it: one location in, one outcome out, with the
 * policy already applied by the composition root. `cycle.ts` depends on this and on
 * nothing else here, so a cycle cannot reach past its one call.
 */
export type FetchForecastForLocation = (
  location: ForecastLocation,
) => Promise<FetchForecastOutcome>;

/**
 * Generous relative to Open-Meteo's typical sub-second response, because the cost
 * of a premature abort is a wasted call against a hard daily quota, while the cost
 * of waiting is a slower hourly batch.
 */
export const defaultTimeoutMs = 10_000;

/** Upper bound of the full-jitter window before the single retry. */
export const retryBaseDelayMs = 1_000;

/**
 * Requests one location's fetch may cost: the initial attempt plus the single
 * retry {@link fetchForecast} makes on a transient failure.
 *
 * Exported because it is a term in `cycle-budget.ts`'s worst-case arithmetic,
 * and a budget that hard-codes `2` there is a *model* of this module rather
 * than a reading of it (#115). It is load-bearing rather than decorative in
 * two ways: the `unreachable` detail below is rendered from it, and
 * `fetch-forecast.test.ts` asserts the request count against it on a
 * persistently-failing fetch — so a third attempt could not be added without
 * this number moving with it.
 */
export const FETCH_MAX_ATTEMPTS = 2;

/** Longest provider text carried in a `detail`; an HTML error page must not flood the logs. */
const maxDetailLength = 200;

/** Open-Meteo answers a rejected request with `{"error":true,"reason":…}`. */
const openMeteoErrorSchema = z.object({ error: z.literal(true), reason: z.string() });

/**
 * A transient attempt result. Kept out of {@link FetchForecastOutcome} because
 * "worth one more try" is an internal state of this module, never something the
 * caller sees: by the time {@link fetchForecast} returns, retrying is over.
 */
type AttemptOutcome = FetchForecastOutcome | { outcome: 'transient'; detail: string };

const truncate = (text: string): string =>
  text.length <= maxDetailLength ? text : `${text.slice(0, maxDetailLength)}…`;

/**
 * Whatever the provider put in a rejected request's body, as a log-safe string:
 * its `reason` when the body is the documented error envelope, the raw text when
 * it is anything else. Both are useful; guessing between them is not, so the
 * shape is parsed rather than assumed (typing.md rule 3).
 */
const describeErrorBody = async (response: Response): Promise<string> => {
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    // Not swallowed: the read failure *is* the description we return.
    return `unreadable body — ${describeThrown(error)}`;
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return truncate(text);
  }

  const envelope = openMeteoErrorSchema.safeParse(body);
  return truncate(envelope.success ? envelope.data.reason : text);
};

/** The shipped defaults, applied to whatever a caller left unstated. */
const resolvePolicy = (deps: ForecastFetchDeps): ForecastFetchPolicy => ({
  fetchFn: deps.fetchFn ?? fetch,
  timeoutMs: deps.timeoutMs ?? defaultTimeoutMs,
  sleep: deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
  random: deps.random ?? ((): number => Math.random()),
});

/**
 * One request, and the mapping from what the provider answered onto an outcome.
 * Every case but `transient` is final — {@link fetchForecast} states why each
 * status ends where it does.
 */
const attemptFetch = async (attempt: ForecastAttempt): Promise<AttemptOutcome> => {
  const { policy } = attempt;

  let response: Response;
  try {
    response = await policy.fetchFn(attempt.url, {
      signal: AbortSignal.timeout(policy.timeoutMs),
    });
  } catch (error) {
    // DNS failure, connection reset and the abort raised by the deadline all land
    // here, and all mean the same thing to the policy: nothing was learned about
    // the provider's state, so one more attempt is warranted.
    return { outcome: 'transient', detail: describeThrown(error) };
  }

  if (response.status === 429) {
    return { outcome: 'rate-limited' };
  }
  if (response.status >= 500) {
    return { outcome: 'transient', detail: `HTTP ${String(response.status)}` };
  }
  if (!response.ok) {
    return {
      outcome: 'malformed',
      detail: `HTTP ${String(response.status)} — ${await describeErrorBody(response)}`,
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return { outcome: 'malformed', detail: `body was not JSON — ${describeThrown(error)}` };
  }

  const parsed = parseForecastResponse(attempt.location, body);
  return parsed.ok
    ? { outcome: 'ok', readings: parsed.readings, droppedHours: parsed.droppedHours }
    : { outcome: 'malformed', detail: parsed.detail };
};

/**
 * Fetch one location's forecast under `deps`, as a value and never a throw.
 *
 * Policy (error-handling.md rule 3 — visible at the call site, not inherited from
 * library defaults):
 * - every attempt carries a {@link defaultTimeoutMs} deadline;
 * - HTTP 429 → `rate-limited` with **zero** retries. The next hourly cycle is the
 *   retry. Hot-retrying a rate limit spends the very quota that is exhausted, and
 *   free-tier frugality is a hard constraint in CLAUDE.md;
 * - 5xx, network error or timeout → exactly one retry after a full-jitter delay
 *   (uniform over [0, {@link retryBaseDelayMs})), then `unreachable`. One retry
 *   absorbs a single-instance blip; more would turn a provider outage into a
 *   fleet-wide burst against the quota;
 * - any other non-2xx → `malformed`. A 400 means our request is wrong, so
 *   repeating it verbatim can only fail again;
 * - 200 → `parseForecastResponse` decides, since a body we cannot trust is
 *   indistinguishable, to the caller, from a wire-format break.
 */
export const fetchForecast = async (
  deps: ForecastFetchDeps,
  location: ForecastLocation,
): Promise<FetchForecastOutcome> => {
  const policy = resolvePolicy(deps);
  const attempt: ForecastAttempt = { policy, location, url: buildForecastUrl(location) };

  const first = await attemptFetch(attempt);
  if (first.outcome !== 'transient') {
    return first;
  }

  // Full jitter (AWS "Exponential Backoff and Jitter"): a uniform draw, not a
  // fixed delay, so a fleet whose sites all fail in the same cycle does not
  // re-converge on one instant. No exponent — there is only ever one retry.
  await policy.sleep(policy.random() * retryBaseDelayMs);

  const second = await attemptFetch(attempt);
  if (second.outcome !== 'transient') {
    return second;
  }
  return {
    outcome: 'unreachable',
    detail: `${String(FETCH_MAX_ATTEMPTS)} attempts failed; last: ${second.detail}`,
  };
};
