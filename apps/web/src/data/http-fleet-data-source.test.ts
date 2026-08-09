import { openMeteoAttribution } from '@cumulo/shared';
import { describe, expect, it, vi } from 'vitest';

import { HttpFleetDataSource } from './http-fleet-data-source';
import {
  BASE_URL,
  clockReading,
  expectFailure,
  expectValue,
  FetchRecorder,
  fleetSite,
  forecastPoint,
  jsonResponse,
  sentJson,
  SITE_A,
  SITE_B,
  sourceAnswering,
} from './http-fleet-data-source-fixtures';

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
    expect(error.code === 'rate-limited' && error.retryAfterSeconds).toBe(17);
  });

  it('maps a 403 to forbidden', async () => {
    const { source } = sourceAnswering(() =>
      jsonResponse({ code: 'forbidden', message: 'origin not allowed' }, 403),
    );

    expect(expectFailure(await source.listSites()).code).toBe('forbidden');
  });

  it('maps a 500 to server-fault', async () => {
    const { source } = sourceAnswering(() =>
      jsonResponse({ code: 'internal', message: 'the request could not be completed' }, 500),
    );

    expect(expectFailure(await source.listSites()).code).toBe('server-fault');
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

  /**
   * The other half of the split lives at "reports a 200 whose body fails the
   * domain schema as invalid-response" above. Together they pin that the two
   * arms are reachable from opposite directions through the real transport: a
   * server that refused what we sent can never surface as "the server sent us
   * something unreadable", which is exactly the conflation this arm was split
   * out of.
   */
  it('maps a 400 validation_failed from the API to invalid-request', async () => {
    const { source } = sourceAnswering(() =>
      jsonResponse({ code: 'validation_failed', message: 'capacityKw must be positive' }, 400),
    );

    const error = expectFailure(
      await source.createSite({
        name: 'New Roof',
        latitude: 51.5,
        longitude: -0.12,
        tiltDegrees: 35,
        azimuthDegrees: 180,
        capacityKw: 4.2,
      }),
    );

    expect(error.code).toBe('invalid-request');
    expect(error.message).toContain('capacityKw must be positive');
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

  it('clears the shared entry when building the window throws, so the next read still reaches the API', async () => {
    const { source, recorder } = sourceAnswering(
      () => jsonResponse(seriesPayload, 200),
      clockReading([Number.NaN]),
    );

    // A non-finite instant is a bug, so it throws rather than becoming a result
    // — and it throws before any request is made.
    await expect(source.siteForecasts(SITE_A, 24)).rejects.toBeInstanceOf(RangeError);
    expect(recorder.calls).toHaveLength(0);

    // The wedge this guards: with the rejected promise still in the in-flight
    // map, this second read would be handed the same RangeError forever.
    expect(expectValue(await source.siteForecasts(SITE_A, 24))).toEqual(seriesPayload.forecasts);
    expect(recorder.calls).toHaveLength(1);
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
    expect(error.code).toBe('server-fault');
    expect(error.message).toContain(SITE_A);
  });

  it('returns the listing failure without fanning out when the fleet cannot be listed', async () => {
    const { source, recorder } = sourceAnswering(() =>
      jsonResponse({ code: 'forbidden', message: 'origin not allowed' }, 403),
    );

    expect(expectFailure(await source.fleetForecasts(24)).code).toBe('forbidden');
    expect(recorder.calls).toHaveLength(1);
  });
});

describe('HttpFleetDataSource fleet actuals', () => {
  const actualsBody = {
    actuals: [{ siteId: SITE_A, validTime: '2026-08-01T11:00:00Z', acPowerKw: 2.2 }],
    attribution: openMeteoAttribution,
  };

  it('fleetActuals unwraps the actuals array from the fleet endpoint', async () => {
    const { source, recorder } = sourceAnswering(() => jsonResponse(actualsBody, 200));

    const actuals = expectValue(await source.fleetActuals(24));

    expect(actuals).toEqual(actualsBody.actuals);
    // One request, and the fleet route rather than a per-site fan-out: this is
    // the read the API's per-IP limiter meters, so its count is the behaviour.
    expect(recorder.calls.map((call) => call.url)).toEqual([
      `${BASE_URL}/v1/fleet/actuals?hours=24`,
    ]);
    expect(recorder.calls[0]?.init?.method).toBe('GET');
  });

  it('maps a 429 from the metered fleet route to rate-limited', async () => {
    const { source } = sourceAnswering(() =>
      jsonResponse({ code: 'rate_limited', message: 'slow down' }, 429),
    );

    expect(expectFailure(await source.fleetActuals(168)).code).toBe('rate-limited');
  });

  /**
   * Pinned as a whole object rather than field by field: a source that grows a
   * third capability, or quietly flips one without the endpoint that would
   * justify it, fails here rather than letting the views promise something this
   * transport cannot supply. Both halves are earned above — actuals by the
   * fleet route in this block, the disclaimed look-back by the horizon-only
   * fan-out in the block before it.
   */
  it('claims fleet actuals and disclaims the fleet look-back', () => {
    const { source } = sourceAnswering(() => jsonResponse(actualsBody, 200));

    expect(source.capabilities).toEqual({ fleetLookback: false, fleetActuals: true });
  });
});

describe('HttpFleetDataSource fan-out pacing', () => {
  /** A distinct valid site id per index, so nine of them cost one line. */
  const pacedSiteId = (index: number): string => {
    const digit = String(index);
    return `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
  };

  /**
   * One more site than the fan-out launches per second, which is the whole
   * point: at eight or fewer, pacing and firing everything at once are
   * indistinguishable, and the other fan-out tests above run two sites.
   */
  const NINE_SITES = Array.from({ length: 9 }, (_, index) =>
    fleetSite(pacedSiteId(index), `Paced ${String(index)}`),
  );

  const forecastCallCount = (recorder: FetchRecorder): number =>
    recorder.calls.filter((call) => call.url.includes('/forecast')).length;

  it('launches eight of nine fan-out forecasts within the first second and the ninth only after it', async () => {
    vi.useFakeTimers();
    try {
      const { source, recorder } = sourceAnswering((url) =>
        url.endsWith('/v1/sites')
          ? jsonResponse({ sites: NINE_SITES }, 200)
          : jsonResponse({ forecasts: [], attribution: openMeteoAttribution }, 200),
      );

      const fanOut = source.fleetForecasts(48);

      // Stops short of the one-second pacing wait, so everything that is not
      // blocked on that wait has settled. An unpaced fan-out would have spent
      // all nine requests by here — the API's shared 10/second stage throttle
      // is what that would be walking into.
      await vi.advanceTimersByTimeAsync(999);
      expect(forecastCallCount(recorder)).toBe(8);

      await vi.advanceTimersByTimeAsync(1000);
      expect(forecastCallCount(recorder)).toBe(9);
      expect(expectValue(await fanOut)).toEqual([]);
    } finally {
      // Restored in a `finally` so one failed expectation cannot leave every
      // later test in the file running on a frozen clock.
      vi.useRealTimers();
    }
  });
});
