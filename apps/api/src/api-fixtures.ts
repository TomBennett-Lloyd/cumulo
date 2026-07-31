import {
  createSiteInputSchema,
  fleetSiteSchema,
  type CreateSiteInput,
  type FleetSite,
} from '@cumulo/shared';

import type { ApiRequest } from './http/gateway-event';
import type { ApiResponse } from './http/response';
import type { RouteRequest } from './http/router';

/**
 * Fixtures shared by this service's tests: the two request shapes its boundary
 * deals in, a fleet site, and the one way a test reads a response body.
 *
 * Test support, in one module rather than a copy per test file, for the reason
 * `docs/standards/testing.md` rule 5 gives: these encode one thing each — what a
 * gateway event looks like, what a site looks like — and a change to any of them
 * has to reach every test at once. Nothing here is imported by `main.ts`, so
 * none of it reaches the deployed bundle.
 */

/** A stable uuid, so a test asserting on an id is not asserting on randomness. */
export const RANELAGH_ID = '3f1a2b4c-5d6e-4f7a-8b9c-0d1e2f3a4b5c';
export const RATHMINES_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

/** `createdAt` is a plain string here: the brand is applied by the parse below. */
type FleetSiteOverrides = Partial<Omit<FleetSite, 'createdAt'>> & { readonly createdAt?: string };

export const fleetSite = (overrides: FleetSiteOverrides = {}): FleetSite =>
  fleetSiteSchema.parse({
    id: RANELAGH_ID,
    name: 'Ranelagh rooftop',
    latitude: 53.3245,
    longitude: -6.2601,
    tiltDegrees: 35,
    azimuthDegrees: 180,
    capacityKw: 4.2,
    origin: 'seed',
    createdAt: '2026-07-30T14:00:00Z',
    active: true,
    ...overrides,
  });

/** A valid `POST`/`PUT` body: every field a caller owns, and none it does not. */
export const siteInput = (overrides: Partial<CreateSiteInput> = {}): CreateSiteInput =>
  createSiteInputSchema.parse({
    name: 'Rathmines terrace',
    latitude: 53.3201,
    longitude: -6.2652,
    tiltDegrees: 30,
    azimuthDegrees: 170,
    capacityKw: 3.5,
    ...overrides,
  });

export const apiRequest = (overrides: Partial<ApiRequest> = {}): ApiRequest => ({
  method: 'GET',
  path: '/v1/sites',
  query: {},
  rawBody: undefined,
  ...overrides,
});

export const routeRequest = (overrides: Partial<RouteRequest> = {}): RouteRequest => ({
  method: 'GET',
  path: '/v1/sites',
  query: {},
  params: {},
  body: undefined,
  ...overrides,
});

export interface GatewayEventOverrides {
  readonly method?: string;
  readonly rawPath?: string;
  readonly body?: string | null;
  readonly isBase64Encoded?: boolean;
  readonly queryStringParameters?: Record<string, string> | null;
}

/**
 * An API Gateway HTTP API payload-v2 event, with the fields this service does
 * **not** read left in place — `version`, `routeKey`, `requestContext.sourceIp`
 * and friends. A fixture trimmed to the parsed slice would agree with the schema
 * by construction and prove nothing about a real invocation.
 */
export const gatewayEvent = (overrides: GatewayEventOverrides = {}): Record<string, unknown> => {
  const { method = 'GET', rawPath = '/v1/sites', ...rest } = overrides;

  return {
    version: '2.0',
    routeKey: '$default',
    rawPath,
    rawQueryString: '',
    headers: { 'content-type': 'application/json', 'user-agent': 'vitest' },
    requestContext: {
      accountId: 'anonymous',
      apiId: 'abc123',
      http: {
        method,
        path: rawPath,
        protocol: 'HTTP/1.1',
        sourceIp: '203.0.113.1',
        userAgent: 'vitest',
      },
      requestId: 'req-1',
      stage: '$default',
    },
    isBase64Encoded: false,
    ...rest,
  };
};

/** A response body as the caller would see it: text on the wire, JSON to assert on. */
export const jsonBodyOf = (response: ApiResponse): unknown => {
  const parsed: unknown = JSON.parse(response.body ?? 'null');
  return parsed;
};
