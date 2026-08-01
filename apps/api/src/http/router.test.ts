import { apiErrorSchema } from '@cumulo/shared';
import { describe, expect, it } from 'vitest';

import { apiRequest, jsonBodyOf } from '../api-fixtures';

import type { ApiResponse } from './response';
import { matchRoute, routeRequest, type Route, type RouteRequest } from './router';

/** Records what the router handed the handler, and answers 200. */
const recordingRoute = (
  method: string,
  segments: Route['segments'],
  seen: RouteRequest[],
): Route => ({
  method,
  segments,
  handle: (request) => {
    seen.push(request);
    return Promise.resolve({ statusCode: 200, headers: {} } satisfies ApiResponse);
  },
});

const siteIdSegments: Route['segments'] = ['v1', 'sites', { param: 'siteId' }];

describe('matchRoute', () => {
  it('matches a literal path and captures nothing', () => {
    const routes = [recordingRoute('GET', ['v1', 'sites'], [])];

    expect(matchRoute(routes, apiRequest({ path: '/v1/sites' }))?.params).toEqual({});
  });

  it('captures a path parameter under its declared name', () => {
    const routes = [recordingRoute('GET', siteIdSegments, [])];

    const match = matchRoute(routes, apiRequest({ path: '/v1/sites/abc-123' }));

    expect(match?.params).toEqual({ siteId: 'abc-123' });
  });

  it('does not match a trailing slash, which the gateway throttles differently', () => {
    // Not pedantry — gateway parity. `infra/api/gateway.tf` declares
    // `POST /v1/sites` as a route key so the stage can throttle it at 2 rps
    // instead of 10, and API Gateway matches that key against the raw path.
    // A router that normalised `/v1/sites/` into the same resource would let a
    // caller opt into the 5× looser limit with one character.
    const routes = [recordingRoute('GET', ['v1', 'sites'], [])];

    expect(matchRoute(routes, apiRequest({ path: '/v1/sites/' }))).toBeUndefined();
  });

  it('does not match doubled or leading empty segments', () => {
    const routes = [recordingRoute('GET', ['v1', 'sites'], [])];

    expect(matchRoute(routes, apiRequest({ path: '//v1//sites' }))).toBeUndefined();
    expect(matchRoute(routes, apiRequest({ path: '/v1//sites' }))).toBeUndefined();
  });

  it('still matches the canonical path, and captures from the canonical form', () => {
    // The other half of the change: tightening matching must not cost the
    // spelling every real client actually sends.
    const routes = [recordingRoute('GET', ['v1', 'sites'], [])];

    expect(matchRoute(routes, apiRequest({ path: '/v1/sites' }))).toBeDefined();
    expect(
      matchRoute([recordingRoute('GET', siteIdSegments, [])], apiRequest({ path: '/v1/sites/abc' }))
        ?.params,
    ).toEqual({ siteId: 'abc' });
  });

  it('does not match a longer or shorter path', () => {
    const routes = [recordingRoute('GET', ['v1', 'sites'], [])];

    expect(matchRoute(routes, apiRequest({ path: '/v1' }))).toBeUndefined();
    expect(matchRoute(routes, apiRequest({ path: '/v1/sites/abc' }))).toBeUndefined();
  });

  it('does not match a different method', () => {
    const routes = [recordingRoute('GET', ['v1', 'sites'], [])];

    expect(matchRoute(routes, apiRequest({ method: 'POST', path: '/v1/sites' }))).toBeUndefined();
  });

  it('takes the first route whose method and pattern both match', () => {
    const seenFirst: RouteRequest[] = [];
    const routes = [
      recordingRoute('POST', ['v1', 'sites'], seenFirst),
      recordingRoute('GET', ['v1', 'sites'], []),
      recordingRoute('GET', siteIdSegments, []),
    ];

    const match = matchRoute(routes, apiRequest({ method: 'GET', path: '/v1/sites' }));

    expect(match?.route.method).toBe('GET');
    expect(match?.route.segments).toEqual(['v1', 'sites']);
  });
});

describe('routeRequest', () => {
  it('hands the handler the query, the params and the parsed body', async () => {
    const seen: RouteRequest[] = [];
    const routes = [recordingRoute('PUT', siteIdSegments, seen)];

    await routeRequest(
      routes,
      apiRequest({
        method: 'PUT',
        path: '/v1/sites/abc-123',
        query: { hours: '48' },
        rawBody: '{"name":"Ranelagh"}',
      }),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]?.params).toEqual({ siteId: 'abc-123' });
    expect(seen[0]?.query).toEqual({ hours: '48' });
    expect(seen[0]?.body).toEqual({ name: 'Ranelagh' });
  });

  it('a request with no body reaches the handler with no body', async () => {
    const seen: RouteRequest[] = [];
    const routes = [recordingRoute('GET', ['v1', 'sites'], seen)];

    await routeRequest(routes, apiRequest({ rawBody: '   ' }));

    expect(seen[0]?.body).toBeUndefined();
  });

  it('answers 404 not_found when nothing matches', async () => {
    const response = await routeRequest([], apiRequest({ path: '/v2/sites' }));

    expect(response.statusCode).toBe(404);
    expect(apiErrorSchema.parse(jsonBodyOf(response)).code).toBe('not_found');
  });

  it('answers 404 rather than 405 for a known path with an unsupported method', async () => {
    // One code for "there is nothing here": a 405 would tell an unauthenticated
    // caller which methods a path supports.
    const routes = [recordingRoute('GET', ['v1', 'sites'], [])];

    const response = await routeRequest(routes, apiRequest({ method: 'PATCH' }));

    expect(response.statusCode).toBe(404);
  });

  it('answers 400 validation_failed for a body that is not JSON, without calling the handler', async () => {
    const seen: RouteRequest[] = [];
    const routes = [recordingRoute('POST', ['v1', 'sites'], seen)];

    const response = await routeRequest(
      routes,
      apiRequest({ method: 'POST', rawBody: '{"name": ' }),
    );

    expect(response.statusCode).toBe(400);
    expect(apiErrorSchema.parse(jsonBodyOf(response)).code).toBe('validation_failed');
    expect(seen).toHaveLength(0);
  });

  it('answers 404 for a write to a trailing-slash path, without calling the handler', async () => {
    // The end-to-end shape of the gateway-parity rule: `POST /v1/sites/` does
    // not match API Gateway's `POST /v1/sites` route key, so it arrives via
    // `$default` carrying the stage's looser throttle. It must not create a
    // site. Confirmed live against the deployed API by issue #29's E2 run.
    const seen: RouteRequest[] = [];
    const routes = [recordingRoute('POST', ['v1', 'sites'], seen)];

    const response = await routeRequest(
      routes,
      apiRequest({ method: 'POST', path: '/v1/sites/', rawBody: '{"name":"Ranelagh"}' }),
    );

    expect(response.statusCode).toBe(404);
    expect(apiErrorSchema.parse(jsonBodyOf(response)).code).toBe('not_found');
    expect(seen).toHaveLength(0);
  });

  it('does not report a malformed body on a request that matched nothing', async () => {
    // Order matters: an unmatched path is 404 even when its body is garbage,
    // because "there is no such route" is the more useful answer.
    const response = await routeRequest([], apiRequest({ rawBody: 'not json' }));

    expect(response.statusCode).toBe(404);
  });
});
