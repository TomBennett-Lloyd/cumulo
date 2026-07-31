import { z } from 'zod';

import { parseForecastResponse, type ForecastWeatherReading } from './response';
import { buildForecastUrl, type ForecastLocation } from './url';

/**
 * The HTTP adapter for Open-Meteo: the one module in this service allowed to
 * touch the network (architecture.md rule 3). Request construction and response
 * normalization stay in `url.ts` / `response.ts`, so what is left here is purely
 * the failure policy — timeout, retry, and how each provider answer maps onto an
 * outcome the caller must handle.
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

export interface OpenMeteoClientDeps {
  /** Defaults to the global `fetch`; tests pass a stub so no test hits the network. */
  readonly fetchFn?: typeof fetch;
  /** Per-attempt deadline. Defaults to {@link defaultTimeoutMs}. */
  readonly timeoutMs?: number;
  /** Retry delay. Injectable so tests assert the delay instead of waiting it out. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Jitter source, uniform over [0, 1). Defaults to `Math.random`. */
  readonly random?: () => number;
}

export interface OpenMeteoClient {
  fetchForecast(location: ForecastLocation): Promise<FetchForecastOutcome>;
}

/**
 * Generous relative to Open-Meteo's typical sub-second response, because the cost
 * of a premature abort is a wasted call against a hard daily quota, while the cost
 * of waiting is a slower hourly batch.
 */
export const defaultTimeoutMs = 10_000;

/** Upper bound of the full-jitter window before the single retry. */
export const retryBaseDelayMs = 1_000;

/** Longest provider text carried in a `detail`; an HTML error page must not flood the logs. */
const maxDetailLength = 200;

/** Open-Meteo answers a rejected request with `{"error":true,"reason":…}`. */
const openMeteoErrorSchema = z.object({ error: z.literal(true), reason: z.string() });

/**
 * A transient attempt result. Kept out of {@link FetchForecastOutcome} because
 * "worth one more try" is an internal state of this module, never something the
 * caller sees: by the time `fetchForecast` returns, retrying is over.
 */
type AttemptOutcome = FetchForecastOutcome | { outcome: 'transient'; detail: string };

function truncate(text: string): string {
  return text.length <= maxDetailLength ? text : `${text.slice(0, maxDetailLength)}…`;
}

function describeThrown(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : `non-Error thrown (${typeof error})`;
}

/**
 * Whatever the provider put in a rejected request's body, as a log-safe string:
 * its `reason` when the body is the documented error envelope, the raw text when
 * it is anything else. Both are useful; guessing between them is not, so the
 * shape is parsed rather than assumed (typing.md rule 3).
 */
async function describeErrorBody(response: Response): Promise<string> {
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
}

/**
 * An Open-Meteo client with its failure policy fixed at construction.
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
export function createOpenMeteoClient(deps: OpenMeteoClientDeps = {}): OpenMeteoClient {
  const {
    fetchFn = fetch,
    timeoutMs = defaultTimeoutMs,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    random = () => Math.random(),
  } = deps;

  async function attempt(location: ForecastLocation, url: string): Promise<AttemptOutcome> {
    let response: Response;
    try {
      response = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
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

    const parsed = parseForecastResponse(location, body);
    return parsed.ok
      ? { outcome: 'ok', readings: parsed.readings, droppedHours: parsed.droppedHours }
      : { outcome: 'malformed', detail: parsed.detail };
  }

  return {
    async fetchForecast(location: ForecastLocation): Promise<FetchForecastOutcome> {
      const url = buildForecastUrl(location);

      const first = await attempt(location, url);
      if (first.outcome !== 'transient') {
        return first;
      }

      // Full jitter (AWS "Exponential Backoff and Jitter"): a uniform draw, not a
      // fixed delay, so a fleet whose sites all fail in the same cycle does not
      // re-converge on one instant. No exponent — there is only ever one retry.
      await sleep(random() * retryBaseDelayMs);

      const second = await attempt(location, url);
      if (second.outcome !== 'transient') {
        return second;
      }
      return {
        outcome: 'unreachable',
        detail: `2 attempts failed; last: ${second.detail}`,
      };
    },
  };
}
