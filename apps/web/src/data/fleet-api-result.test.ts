import { listSitesResponseSchema } from '@cumulo/shared';
import { describe, expect, it } from 'vitest';

import { parseFleetApiResponse, thrownToNetworkFailure } from './fleet-api-result';
import type { FleetDataError, FleetSourceResult } from './fleet-data-source';

const OPERATION = 'listSites (fleet)';

/** A `fleetSiteSchema`-valid site, so the envelope fixtures are real payloads. */
const fleetSite = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Sunny Roof',
  latitude: 51.5,
  longitude: -0.12,
  tiltDegrees: 35,
  azimuthDegrees: 180,
  capacityKw: 4.2,
  origin: 'seed',
  createdAt: '2026-07-01T00:00:00Z',
  active: true,
};

const jsonResponse = (body: unknown, init: ResponseInit): Response =>
  new Response(JSON.stringify(body), init);

const apiErrorBody = (code: string, message: string): unknown => ({ code, message });

/** Narrows to the failure arm, so each test asserts on the error rather than on a union. */
const expectFailure = (result: FleetSourceResult<unknown>): FleetDataError => {
  if (result.kind !== 'error') {
    throw new Error(`expected a failure result, received ${JSON.stringify(result)}`);
  }
  return result.error;
};

const parse = (response: Response): Promise<FleetSourceResult<{ sites: unknown[] }>> =>
  parseFleetApiResponse(OPERATION, listSitesResponseSchema, response);

describe('parseFleetApiResponse', () => {
  it('returns the parsed payload when a 2xx body matches its schema', async () => {
    const result = await parse(jsonResponse({ sites: [fleetSite] }, { status: 200 }));

    expect(result).toEqual({ kind: 'ok', value: { sites: [fleetSite] } });
  });

  it('reports a 2xx body that fails its schema as invalid-response naming the operation', async () => {
    const result = await parse(jsonResponse({ sites: [{ id: 'not-a-uuid' }] }, { status: 200 }));

    const error = expectFailure(result);
    expect(error.code).toBe('invalid-response');
    expect(error.message).toContain(OPERATION);
    expect(error.message).toContain('sites.0.id');
  });

  it('reports a 2xx body that is not JSON at all as invalid-response', async () => {
    const result = await parse(new Response('<html>gateway</html>', { status: 200 }));

    const error = expectFailure(result);
    expect(error.code).toBe('invalid-response');
    expect(error.message).toContain(OPERATION);
  });

  it('maps 400 to invalid-request, carrying the message the API sent', async () => {
    const response = jsonResponse(apiErrorBody('validation_failed', 'hours must be one of 24'), {
      status: 400,
    });

    const error = expectFailure(await parse(response));
    expect(error.code).toBe('invalid-request');
    expect(error.message).toContain('hours must be one of 24');
  });

  it('maps 403 to forbidden and names the deployment setting that fixes it', async () => {
    const response = jsonResponse(apiErrorBody('forbidden', 'origin not allowed'), { status: 403 });

    const error = expectFailure(await parse(response));
    expect(error.code).toBe('forbidden');
    expect(error.message).toContain('CUMULO_WEB_ORIGINS');
  });

  it('maps 404 to not-found', async () => {
    const response = jsonResponse(apiErrorBody('not_found', 'no such site'), { status: 404 });

    const error = expectFailure(await parse(response));
    expect(error.code).toBe('not-found');
    expect(error.message).toContain('no such site');
  });

  it('maps 429 with Retry-After: 17 to rate-limited carrying 17 seconds', async () => {
    const response = jsonResponse(apiErrorBody('rate_limited', 'slow down'), {
      status: 429,
      headers: { 'Retry-After': '17' },
    });

    const error = expectFailure(await parse(response));
    expect(error.code).toBe('rate-limited');
    expect(error.code === 'rate-limited' && error.retryAfterSeconds).toBe(17);
  });

  it('omits retryAfterSeconds entirely when a 429 carries no Retry-After header', async () => {
    // The gateway's own throttle answers this way: a 429 with a body this
    // client cannot parse and no stated wait. Absent must not become zero.
    const response = jsonResponse({ message: 'Too Many Requests' }, { status: 429 });

    const error = expectFailure(await parse(response));
    expect(error.code).toBe('rate-limited');
    expect('retryAfterSeconds' in error).toBe(false);
  });

  it('omits retryAfterSeconds when Retry-After states a date rather than seconds', async () => {
    const response = jsonResponse(apiErrorBody('rate_limited', 'slow down'), {
      status: 429,
      headers: { 'Retry-After': 'Wed, 01 Aug 2026 12:00:00 GMT' },
    });

    const error = expectFailure(await parse(response));
    expect(error.code).toBe('rate-limited');
    expect('retryAfterSeconds' in error).toBe(false);
  });

  it('maps 500 to network', async () => {
    const response = jsonResponse(apiErrorBody('internal', 'the request could not be completed'), {
      status: 500,
    });

    const error = expectFailure(await parse(response));
    expect(error.code).toBe('network');
    expect(error.message).toContain(OPERATION);
  });

  it('maps an unlisted status to network rather than to silence', async () => {
    const error = expectFailure(await parse(new Response('Bad Gateway', { status: 502 })));

    expect(error.code).toBe('network');
    expect(error.message).toContain('502');
  });
});

describe('thrownToNetworkFailure', () => {
  it('renders a rejected request as network, naming the operation and what was thrown', () => {
    const error = expectFailure(
      thrownToNetworkFailure(OPERATION, new TypeError('Failed to fetch')),
    );

    expect(error.code).toBe('network');
    expect(error.message).toContain(OPERATION);
    expect(error.message).toContain('Failed to fetch');
  });

  it('describes a non-Error throw rather than losing it', () => {
    const error = expectFailure(thrownToNetworkFailure(OPERATION, 'boom'));

    expect(error.code).toBe('network');
    expect(error.message).toContain('non-Error thrown');
  });
});
