import {
  createSiteInputSchema,
  fleetSiteSchema,
  forecastSchema,
  generationReadingSchema,
  type CreateSiteInput,
  type FleetSite,
  type Forecast,
  type GenerationReading,
} from '@cumulo/shared';
import type { SeriesPoint } from '@cumulo/storage';

import type { ApiRequest } from './http/gateway-event';
import type { RequestDeadline } from './http/request-deadline';
import type { ApiResponse } from './http/response';
import type { RouteRequest } from './http/router';
import { API_LAMBDA_TIMEOUT_MS } from './request-budget';

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

/**
 * The forecast vintage and valid hour the series fixtures share, so a test that
 * asserts on a window is asserting on numbers it can read here rather than on
 * whatever "now" happened to be.
 */
export const ISSUED_AT = '2026-07-31T12:00:00Z';
export const VALID_TIME = '2026-07-31T13:00:00Z';

/** The branded timestamps arrive as plain strings; the parse below applies the brand. */
type ForecastOverrides = Partial<Omit<Forecast, 'validTime' | 'issuedAt'>> & {
  readonly validTime?: string;
  readonly issuedAt?: string;
};

export const forecast = (overrides: ForecastOverrides = {}): Forecast =>
  forecastSchema.parse({
    siteId: RANELAGH_ID,
    model: 'physics',
    validTime: VALID_TIME,
    issuedAt: ISSUED_AT,
    weatherSource: 'open-meteo',
    poaIrradianceWm2: 640,
    acPowerKw: 2.8,
    ...overrides,
  });

type GenerationReadingOverrides = Partial<Omit<GenerationReading, 'validTime'>> & {
  readonly validTime?: string;
};

export const generationReading = (overrides: GenerationReadingOverrides = {}): GenerationReading =>
  generationReadingSchema.parse({
    siteId: RANELAGH_ID,
    validTime: VALID_TIME,
    acPowerKw: 2.4,
    ...overrides,
  });

/**
 * The two `SeriesPoint` variants, built from the fixtures above.
 *
 * A stubbed `querySeriesRange` returns these, so a test writes the *interleaved*
 * list the real adapter produces — which is the input the split under test
 * actually has to cope with — rather than two tidy pre-separated arrays.
 */
export const forecastPoint = (overrides: ForecastOverrides = {}): SeriesPoint => ({
  type: 'forecast',
  forecast: forecast(overrides),
});

export const generationPoint = (overrides: GenerationReadingOverrides = {}): SeriesPoint => ({
  type: 'generation',
  reading: generationReading(overrides),
});

/**
 * The address and host every fixture below shares, so a test about *one* IP or
 * *one* origin says which by overriding rather than by repeating the default.
 * `203.0.113.0/24` is RFC 5737's documentation range — it can never be a real
 * caller.
 */
export const SOURCE_IP = '203.0.113.1';
export const API_DOMAIN = 'abc123.execute-api.eu-west-1.amazonaws.com';
export const OWN_ORIGIN = `https://${API_DOMAIN}`;

export const apiRequest = (overrides: Partial<ApiRequest> = {}): ApiRequest => ({
  method: 'GET',
  path: '/v1/sites',
  query: {},
  rawBody: undefined,
  sourceIp: SOURCE_IP,
  originHeader: undefined,
  ownOrigin: OWN_ORIGIN,
  ...overrides,
});

/**
 * The deadline of a request that has its whole budget left — the production
 * shape, since a real invocation starts with the function timeout in hand.
 *
 * This is the default every fixture request carries, so a test that says
 * nothing about time is testing the configuration that ships
 * (`docs/standards/testing.md` rule 7) rather than one with the guard off.
 */
export const fullBudgetDeadline: RequestDeadline = { remainingMs: () => API_LAMBDA_TIMEOUT_MS };

/**
 * A deadline that permits a fixed number of storage commands and then refuses:
 * the full budget for the first `permittedCommands` readings, and `0` for every
 * reading after that.
 *
 * A class rather than a factory closing over a counter, because the count *is*
 * state shared between calls and `this.` is what makes that visible
 * (`docs/standards/structure.md` rule 2).
 *
 * Counting readings rather than tracking elapsed time is what makes a test
 * about "the deadline runs out mid-loop" say how far the loop got, in the units
 * the loop is written in, with no clock and no timers involved.
 */
class CountdownDeadline implements RequestDeadline {
  private permitsLeft: number;

  constructor(permittedCommands: number) {
    this.permitsLeft = permittedCommands;
  }

  remainingMs = (): number => {
    if (this.permitsLeft <= 0) {
      return 0;
    }
    this.permitsLeft -= 1;
    return API_LAMBDA_TIMEOUT_MS;
  };
}

/**
 * The shared way a test forces a handler's deadline to run out at a chosen
 * point. One helper rather than one per test file: what "out of time" means to
 * the budget predicate is a single fact, and a second spelling of it would drift
 * from the first.
 */
export const countdownDeadline = (permittedCommands: number): RequestDeadline =>
  new CountdownDeadline(permittedCommands);

export const routeRequest = (overrides: Partial<RouteRequest> = {}): RouteRequest => ({
  method: 'GET',
  path: '/v1/sites',
  query: {},
  params: {},
  body: undefined,
  sourceIp: SOURCE_IP,
  originHeader: undefined,
  ownOrigin: OWN_ORIGIN,
  deadline: fullBudgetDeadline,
  ...overrides,
});

export interface GatewayEventOverrides {
  readonly method?: string;
  readonly rawPath?: string;
  readonly body?: string | null;
  readonly isBase64Encoded?: boolean;
  readonly queryStringParameters?: Record<string, string> | null;
  readonly headers?: Record<string, string> | null;
  readonly sourceIp?: string;
  readonly domainName?: string;
}

/**
 * An API Gateway HTTP API payload-v2 event, with the fields this service does
 * **not** read left in place — `version`, `routeKey`, `requestContext.requestId`
 * and friends. A fixture trimmed to the parsed slice would agree with the schema
 * by construction and prove nothing about a real invocation.
 *
 * `sourceIp` and `domainName` are separate overrides rather than parts of the
 * `...rest` spread because both live *inside* `requestContext`, where a
 * top-level spread cannot reach them — and a fixture that silently ignored an
 * override would make a limiter test pass by testing one address twice.
 */
export const gatewayEvent = (overrides: GatewayEventOverrides = {}): Record<string, unknown> => {
  const {
    method = 'GET',
    rawPath = '/v1/sites',
    sourceIp = SOURCE_IP,
    domainName = API_DOMAIN,
    headers = { 'content-type': 'application/json', 'user-agent': 'vitest' },
    ...rest
  } = overrides;

  return {
    version: '2.0',
    routeKey: '$default',
    rawPath,
    rawQueryString: '',
    headers,
    requestContext: {
      accountId: 'anonymous',
      apiId: 'abc123',
      domainName,
      http: {
        method,
        path: rawPath,
        protocol: 'HTTP/1.1',
        sourceIp,
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
