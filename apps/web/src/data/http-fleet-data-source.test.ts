import { openMeteoAttribution } from '@cumulo/shared';
import { describe, expect, it } from 'vitest';

import type { FleetDataError, FleetSourceResult } from './fleet-data-source';
import { HttpFleetDataSource } from './http-fleet-data-source';

const BASE_URL = 'https://api.example.test';

/** 2026-08-01T12:00:00Z — the instant every window in these tests is measured from. */
const NOW_MS = Date.UTC(2026, 7, 1, 12, 0, 0);

const SITE_A = '11111111-1111-4111-8111-111111111111';
const SITE_B = '22222222-2222-4222-8222-222222222222';

const fleetSite = (id: string, name: string): unknown => ({
  id,
  name,
  latitude: 51.5,
  longitude: -0.12,
  tiltDegrees: 35,
  azimuthDegrees: 180,
  capacityKw: 4.2,
  origin: 'seed',
  createdAt: '2026-07-01T00:00:00Z',
  active: true,
});

const forecastPoint = (siteId: string, acPowerKw: number): unknown => ({
  siteId,
  model: 'physics',
  validTime: '2026-08-01T13:00:00Z',
  issuedAt: '2026-08-01T12:00:00Z',
  weatherSource: 'open-meteo',
  poaIrradianceWm2: 800,
  acPowerKw,
});

const jsonResponse = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status });

interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/** `fetch` accepts three input shapes; the source only ever passes the first. */
const requestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
};

/** The request body as the object it was serialised from, or a failed test. */
const sentJson = (init: RequestInit | undefined): unknown => {
  const body = init?.body;
  if (typeof body !== 'string') {
    throw new Error(`expected a JSON string body, received ${typeof body}`);
  }
  return JSON.parse(body);
};

/**
 * A `fetch` stand-in that answers from a URL-keyed responder and records what
 * it was asked for.
 *
 * A class rather than a factory returning functions (`structure.md` rule 2):
 * the recorder and the transport share the call log, and `this.` is what says
 * so. `calls.length` is the frugality assertion these tests are built around —
 * how many requests a UI interaction costs is behaviour, not mock theatre.
 */
class FetchRecorder {
  readonly calls: RecordedCall[] = [];
  private readonly respond: (url: string) => Response | Promise<Response>;

  constructor(respond: (url: string) => Response | Promise<Response>) {
    this.respond = respond;
  }

  readonly fetchFn: typeof fetch = (input, init) => {
    const url = requestUrl(input);
    this.calls.push({ url, init });
    return Promise.resolve(this.respond(url));
  };
}

const sourceAnswering = (
  respond: (url: string) => Response | Promise<Response>,
): { source: HttpFleetDataSource; recorder: FetchRecorder } => {
  const recorder = new FetchRecorder(respond);
  return {
    recorder,
    source: new HttpFleetDataSource({
      baseUrl: BASE_URL,
      fetchFn: recorder.fetchFn,
      now: () => NOW_MS,
    }),
  };
};

const expectFailure = (result: FleetSourceResult<unknown>): FleetDataError => {
  if (result.kind !== 'error') {
    throw new Error(`expected a failure result, received ${JSON.stringify(result)}`);
  }
  return result.error;
};

const expectValue = <T>(result: FleetSourceResult<T>): T => {
  if (result.kind !== 'ok') {
    throw new Error(`expected a success result, received ${JSON.stringify(result)}`);
  }
  return result.value;
};

describe('HttpFleetDataSource reads', () => {
  it('unwraps the sites envelope and drops a trailing slash from the base URL', async () => {
    const recorder = new FetchRecorder(() =>
      jsonResponse({ sites: [fleetSite(SITE_A, 'Sunny Roof')] }, 200),
    );
    const source = new HttpFleetDataSource({
      baseUrl: `${BASE_URL}/`,
      fetchFn: recorder.fetchFn,
    });

    const sites = expectValue(await source.listSites());

    expect(sites).toEqual([fleetSite(SITE_A, 'Sunny Roof')]);
    expect(recorder.calls.map((call) => call.url)).toEqual([`${BASE_URL}/v1/sites`]);
  });

  it('asks the forecast route for no explicit horizon and unwraps its forecasts', async () => {
    const { source, recorder } = sourceAnswering(() =>
      jsonResponse(
        { forecasts: [forecastPoint(SITE_A, 3.1)], attribution: openMeteoAttribution },
        200,
      ),
    );

    const forecasts = expectValue(await source.getSiteForecast(SITE_A));

    expect(forecasts).toEqual([forecastPoint(SITE_A, 3.1)]);
    expect(recorder.calls[0]?.url).toBe(`${BASE_URL}/v1/sites/${SITE_A}/forecast`);
  });

  it('maps a 404 from the forecast route to not-found', async () => {
    const { source } = sourceAnswering(() =>
      jsonResponse({ code: 'not_found', message: 'no such site' }, 404),
    );

    expect(expectFailure(await source.getSiteForecast(SITE_A)).code).toBe('not-found');
  });

  it('maps a 429 carrying Retry-After to rate-limited with the stated wait', async () => {
    const { source } = sourceAnswering(
      () =>
        new Response(JSON.stringify({ code: 'rate_limited', message: 'slow down' }), {
          status: 429,
          headers: { 'Retry-After': '17' },
        }),
    );

    const error = expectFailure(await source.siteForecasts(SITE_A, 24));
    expect(error.code).toBe('rate-limited');
    expect(error.retryAfterSeconds).toBe(17);
  });

  it('maps a 403 to forbidden', async () => {
    const { source } = sourceAnswering(() =>
      jsonResponse({ code: 'forbidden', message: 'origin not allowed' }, 403),
    );

    expect(expectFailure(await source.listSites()).code).toBe('forbidden');
  });

  it('maps a 500 to network', async () => {
    const { source } = sourceAnswering(() =>
      jsonResponse({ code: 'internal', message: 'the request could not be completed' }, 500),
    );

    expect(expectFailure(await source.listSites()).code).toBe('network');
  });

  it('maps a rejecting transport to network without letting the rejection escape', async () => {
    const { source } = sourceAnswering(() => Promise.reject(new TypeError('Failed to fetch')));

    const error = expectFailure(await source.listSites());
    expect(error.code).toBe('network');
    expect(error.message).toContain('Failed to fetch');
  });

  it('reports a 200 whose body fails the domain schema as invalid-response', async () => {
    const { source } = sourceAnswering(() => jsonResponse({ sites: [{ id: 'nope' }] }, 200));

    expect(expectFailure(await source.listSites()).code).toBe('invalid-response');
  });
});

describe('HttpFleetDataSource createSite', () => {
  it('posts the input as JSON and returns the site the server assigned', async () => {
    const { source, recorder } = sourceAnswering(() =>
      jsonResponse(fleetSite(SITE_B, 'New Roof'), 201),
    );

    const created = expectValue(
      await source.createSite({
        name: 'New Roof',
        latitude: 51.5,
        longitude: -0.12,
        tiltDegrees: 35,
        azimuthDegrees: 180,
        capacityKw: 4.2,
      }),
    );

    expect(created.id).toBe(SITE_B);
    const call = recorder.calls[0];
    expect(call?.url).toBe(`${BASE_URL}/v1/sites`);
    expect(call?.init?.method).toBe('POST');
    expect(call?.init?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(sentJson(call?.init)).toMatchObject({ name: 'New Roof', capacityKw: 4.2 });
  });
});

describe('HttpFleetDataSource series window', () => {
  const seriesPayload = {
    forecasts: [forecastPoint(SITE_A, 2.5)],
    actuals: [{ siteId: SITE_A, validTime: '2026-08-01T11:00:00Z', acPowerKw: 2.2 }],
    attribution: openMeteoAttribution,
  };

  it('serves concurrent forecasts and actuals for one site and range from a single request', async () => {
    const { source, recorder } = sourceAnswering(() => jsonResponse(seriesPayload, 200));

    const [forecasts, actuals] = await Promise.all([
      source.siteForecasts(SITE_A, 24),
      source.siteActuals(SITE_A, 24),
    ]);

    expect(recorder.calls).toHaveLength(1);
    expect(expectValue(forecasts)).toEqual(seriesPayload.forecasts);
    expect(expectValue(actuals)).toEqual(seriesPayload.actuals);
  });

  it('spans the range backwards and the forecast horizon forwards, as fixed-width UTC seconds', async () => {
    const { source, recorder } = sourceAnswering(() => jsonResponse(seriesPayload, 200));

    await source.siteForecasts(SITE_A, 168);

    const requested = new URL(String(recorder.calls[0]?.url));
    expect(requested.pathname).toBe(`/v1/sites/${SITE_A}/series`);
    expect(requested.searchParams.get('from')).toBe('2026-07-25T12:00:00Z');
    expect(requested.searchParams.get('to')).toBe('2026-08-03T12:00:00Z');
  });

  it('shares an in-flight request rather than caching a settled one', async () => {
    const { source, recorder } = sourceAnswering(() => jsonResponse(seriesPayload, 200));

    await source.siteForecasts(SITE_A, 24);
    await source.siteForecasts(SITE_A, 24);

    expect(recorder.calls).toHaveLength(2);
  });

  it('keeps distinct site/range selections on their own requests', async () => {
    const { source, recorder } = sourceAnswering(() => jsonResponse(seriesPayload, 200));

    await Promise.all([source.siteForecasts(SITE_A, 24), source.siteForecasts(SITE_A, 48)]);

    expect(recorder.calls).toHaveLength(2);
  });
});

describe('HttpFleetDataSource fleet fan-out', () => {
  const listBody = { sites: [fleetSite(SITE_A, 'A'), fleetSite(SITE_B, 'B')] };

  const fanOutAnswering = (forecastFor: (siteId: string) => Response) =>
    sourceAnswering((url) => {
      const siteId = url.includes(SITE_A) ? SITE_A : SITE_B;
      return url.endsWith('/v1/sites') ? jsonResponse(listBody, 200) : forecastFor(siteId);
    });

  it('requests the unlimited forecast route per site, never the metered series route', async () => {
    const { source, recorder } = fanOutAnswering((siteId) =>
      jsonResponse(
        { forecasts: [forecastPoint(siteId, 1)], attribution: openMeteoAttribution },
        200,
      ),
    );

    await source.fleetForecasts(48);

    expect(recorder.calls.map((call) => call.url)).toEqual([
      `${BASE_URL}/v1/sites`,
      `${BASE_URL}/v1/sites/${SITE_A}/forecast?hours=48`,
      `${BASE_URL}/v1/sites/${SITE_B}/forecast?hours=48`,
    ]);
  });

  it('returns the union of the sites that answered when only some of them fail', async () => {
    const { source } = fanOutAnswering((siteId) =>
      siteId === SITE_A
        ? jsonResponse(
            { forecasts: [forecastPoint(SITE_A, 4)], attribution: openMeteoAttribution },
            200,
          )
        : jsonResponse({ code: 'internal', message: 'boom' }, 500),
    );

    expect(expectValue(await source.fleetForecasts(24))).toEqual([forecastPoint(SITE_A, 4)]);
  });

  it('returns the first failure when every site fails', async () => {
    const { source } = fanOutAnswering(() =>
      jsonResponse({ code: 'internal', message: 'boom' }, 500),
    );

    const error = expectFailure(await source.fleetForecasts(24));
    expect(error.code).toBe('network');
    expect(error.message).toContain(SITE_A);
  });

  it('returns the listing failure without fanning out when the fleet cannot be listed', async () => {
    const { source, recorder } = sourceAnswering(() =>
      jsonResponse({ code: 'forbidden', message: 'origin not allowed' }, 403),
    );

    expect(expectFailure(await source.fleetForecasts(24)).code).toBe('forbidden');
    expect(recorder.calls).toHaveLength(1);
  });

  it('answers fleet actuals with an empty series and spends no request at all', async () => {
    const { source, recorder } = sourceAnswering(() => jsonResponse({ sites: [] }, 200));

    expect(expectValue(await source.fleetActuals(168))).toEqual([]);
    expect(recorder.calls).toHaveLength(0);
  });
});
