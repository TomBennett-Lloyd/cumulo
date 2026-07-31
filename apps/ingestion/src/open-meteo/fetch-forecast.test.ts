import { describe, expect, it } from 'vitest';

import {
  fetchForecast,
  retryBaseDelayMs,
  type FetchForecastOutcome,
  type ForecastFetchDeps,
} from './fetch-forecast';
import fixture from './fixtures/dublin-forecast.json';
import { buildForecastUrl, type ForecastLocation } from './url';

/**
 * The adapter is exercised against a stubbed `fetch` returning the same captured
 * Open-Meteo bodies the parser tests use (testing.md rule 3), so the assertions are
 * about the failure policy — attempt counts, retry delays — rather than about a
 * mock having been called. Nothing here touches the network or the wall clock: the
 * retry delay is asserted from an injected `sleep` that resolves instantly.
 */
const dublin: ForecastLocation = { latitude: 53.35, longitude: -6.26 };

type FetchResponder = () => Promise<Response>;

interface RecordedRequest {
  readonly url: string;
  readonly signal: AbortSignal | undefined;
}

interface FetchStub {
  readonly fetchFn: typeof fetch;
  readonly requests: readonly RecordedRequest[];
}

const requestUrl = (input: Parameters<typeof fetch>[0]): string => {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
};

/**
 * A `fetch` that answers with `responders` in order and records what it was asked.
 * A request past the end of the list rejects loudly rather than repeating the last
 * response, so a policy that retried more than the test expects cannot pass by
 * quietly getting another success.
 */
const stubFetch = (responders: readonly FetchResponder[]): FetchStub => {
  const requests: RecordedRequest[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    const responder = responders[requests.length];
    requests.push({ url: requestUrl(input), signal: init?.signal ?? undefined });
    return responder === undefined
      ? Promise.reject(new Error(`unexpected request #${String(requests.length)}`))
      : responder();
  };
  return { fetchFn, requests };
};

const respondsWith =
  (body: unknown, status: number): FetchResponder =>
  () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );

/** What Node's `fetch` throws when the connection never gets off the ground. */
const networkFailure = (): FetchResponder => () => Promise.reject(new TypeError('fetch failed'));

interface SleepSpy {
  readonly sleep: (ms: number) => Promise<void>;
  readonly delays: readonly number[];
}

const spyOnSleep = (): SleepSpy => {
  const delays: number[] = [];
  return {
    delays,
    sleep: (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
};

const expectOk = (
  result: FetchForecastOutcome,
): Extract<FetchForecastOutcome, { outcome: 'ok' }> => {
  if (result.outcome !== 'ok') {
    return expect.fail(
      `expected ok, got ${result.outcome}${'detail' in result ? `: ${result.detail}` : ''}`,
    );
  }
  return result;
};

const detailOf = (result: FetchForecastOutcome): string =>
  'detail' in result ? result.detail : '';

const fetchWith = (
  deps: ForecastFetchDeps,
  location: ForecastLocation = dublin,
): Promise<FetchForecastOutcome> => fetchForecast(deps, location);

describe('fetchForecast', () => {
  it('a 200 fixture response yields ok readings', async () => {
    // No timeout or sleep injected: this test runs the shipped defaults.
    const stub = stubFetch([respondsWith(fixture, 200)]);

    const result = expectOk(await fetchWith({ fetchFn: stub.fetchFn }));

    expect(result.readings).toHaveLength(fixture.hourly.time.length);
    expect(result.droppedHours).toBe(0);
    expect(result.readings.every((reading) => reading.latitude === dublin.latitude)).toBe(true);
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]?.url).toBe(buildForecastUrl(dublin));
    // The deadline is part of the policy, so its absence must fail a test.
    expect(stub.requests[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('429 returns rate-limited after exactly one request', async () => {
    const stub = stubFetch([
      respondsWith({ error: true, reason: 'Hourly request limit exceeded' }, 429),
    ]);
    const sleeps = spyOnSleep();

    const result = await fetchWith({ fetchFn: stub.fetchFn, sleep: sleeps.sleep });

    expect(result.outcome).toBe('rate-limited');
    // Hot-retrying a rate limit spends the exhausted quota — a hard CLAUDE.md
    // constraint, and the reason this count is asserted rather than assumed.
    expect(stub.requests).toHaveLength(1);
    expect(sleeps.delays).toEqual([]);
  });

  it('a 503 then 200 succeeds after one retry', async () => {
    const stub = stubFetch([
      respondsWith({ error: true, reason: 'busy' }, 503),
      respondsWith(fixture, 200),
    ]);
    const sleeps = spyOnSleep();

    const result = expectOk(
      await fetchWith({ fetchFn: stub.fetchFn, sleep: sleeps.sleep, random: () => 0.5 }),
    );

    expect(result.readings).toHaveLength(fixture.hourly.time.length);
    expect(stub.requests).toHaveLength(2);
    expect(sleeps.delays).toEqual([0.5 * retryBaseDelayMs]);
  });

  it('persistent network failure returns unreachable after exactly two attempts', async () => {
    const stub = stubFetch([networkFailure(), networkFailure()]);
    const sleeps = spyOnSleep();

    const result = await fetchWith({ fetchFn: stub.fetchFn, sleep: sleeps.sleep });

    expect(result.outcome).toBe('unreachable');
    expect(detailOf(result)).toContain('fetch failed');
    expect(stub.requests).toHaveLength(2);
    expect(sleeps.delays).toHaveLength(1);
  });

  it('a non-429 4xx returns malformed with the provider reason', async () => {
    const reason = 'Latitude must be in range of -90 to 90°. Given: 99.9.';
    const stub = stubFetch([respondsWith({ error: true, reason }, 400)]);
    const sleeps = spyOnSleep();

    const result = await fetchWith({ fetchFn: stub.fetchFn, sleep: sleeps.sleep });

    expect(result.outcome).toBe('malformed');
    expect(detailOf(result)).toContain(reason);
    expect(detailOf(result)).toContain('400');
    // A bad request repeated verbatim can only fail again.
    expect(stub.requests).toHaveLength(1);
    expect(sleeps.delays).toEqual([]);
  });

  it('a 200 body that is not a forecast response is malformed, not ok', async () => {
    const stub = stubFetch([respondsWith({ error: true, reason: 'No data is available' }, 200)]);

    const result = await fetchWith({ fetchFn: stub.fetchFn, sleep: spyOnSleep().sleep });

    expect(result.outcome).toBe('malformed');
    expect(detailOf(result)).toContain('hourly');
    expect(stub.requests).toHaveLength(1);
  });

  it('draws the retry delay from the production jitter source when random is not injected', async () => {
    const stub = stubFetch([networkFailure(), respondsWith(fixture, 200)]);
    const sleeps = spyOnSleep();

    expectOk(await fetchWith({ fetchFn: stub.fetchFn, sleep: sleeps.sleep }));

    expect(sleeps.delays).toHaveLength(1);
    expect(sleeps.delays[0]).toBeGreaterThanOrEqual(0);
    expect(sleeps.delays[0]).toBeLessThan(retryBaseDelayMs);
  });

  it('retries through the production sleep when none is injected', async () => {
    // The jitter draw is pinned to 0 so the real `setTimeout` path runs without
    // spending wall-clock time: the default sleep ships untested otherwise.
    const stub = stubFetch([networkFailure(), respondsWith(fixture, 200)]);

    const result = expectOk(await fetchWith({ fetchFn: stub.fetchFn, random: () => 0 }));

    expect(result.readings).toHaveLength(fixture.hourly.time.length);
    expect(stub.requests).toHaveLength(2);
  });
});
