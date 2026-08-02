import { apiErrorSchema } from '@cumulo/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_LIMITED_REQUESTS_PER_WINDOW } from './abuse/ip-limiter';
import {
  OWN_ORIGIN,
  RANELAGH_ID,
  SOURCE_IP,
  fullBudgetDeadline,
  gatewayEvent,
  jsonBodyOf,
  siteInput,
} from './api-fixtures';
import { lambdaContextDeadline } from './http/request-deadline';
import type { ApiResponse } from './http/response';
import type { Route } from './http/router';

/**
 * The composition root is tested the only way its behaviour is observable: by
 * importing it (`docs/standards/testing.md` rule 1). Startup *is* part of that
 * behaviour — a composition root's job is to fail before the first request when
 * the deployment is wrong — so every case gets a fresh module graph via
 * `vi.resetModules()`, because module scope runs once per graph.
 */

/** The rejection reason of importing the composition root, or a failure if it loaded. */
const importFailure = async (): Promise<unknown> => {
  try {
    await import('./main');
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected importing ./main to throw, but it loaded');
};

/** A route table entry as a reader would write it: `GET /v1/sites/{siteId}`. */
const describeRoute = (route: Route): string => {
  const path = route.segments
    .map((segment) => (typeof segment === 'string' ? segment : `{${segment.param}}`))
    .join('/');
  return `${route.method} /${path}`;
};

const throwingRoute = (thrown: unknown): Route => ({
  method: 'GET',
  segments: ['v1', 'sites'],
  handle: () => {
    throw thrown;
  },
});

beforeEach(() => {
  vi.resetModules();
  // Every case sets what it needs; nothing inherits the developer's own shell.
  vi.stubEnv('CUMULO_ENV', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the api composition root', () => {
  it('a missing environment fails startup loudly', async () => {
    const error = await importFailure();

    expect(String(error)).toContain('CUMULO_ENV');
    expect(String(error)).toContain('invalid environment');
  });

  it('an environment name that cannot name a table fails startup', async () => {
    // `storageTableName` owns this alphabet (it mirrors infra/storage/variables.tf).
    // What this proves is that its throw happens during initialization rather
    // than as a ResourceNotFoundException on the first request.
    vi.stubEnv('CUMULO_ENV', 'Staging Env');

    const error = await importFailure();

    expect(String(error)).toContain('storageTableName');
    expect(String(error)).toContain('Staging Env');
  });

  it('a complete environment exports a handler and every route the API answers', async () => {
    vi.stubEnv('CUMULO_ENV', 'test');

    const main = await import('./main');

    expect(typeof main.handler).toBe('function');
    // Composing the client performs no I/O: region, credentials and connections
    // are all resolved lazily at send time, which is why this test needs no AWS.
    expect(main.routes.map(describeRoute)).toEqual([
      'GET /v1/sites',
      'POST /v1/sites',
      'GET /v1/sites/{siteId}',
      'PUT /v1/sites/{siteId}',
      'DELETE /v1/sites/{siteId}',
      'GET /v1/sites/{siteId}/forecast',
      'GET /v1/sites/{siteId}/series',
      'GET /openapi.json',
      'GET /docs',
      'GET /docs/{asset}',
    ]);
  });
});

describe('the top-level error boundary', () => {
  beforeEach(() => {
    vi.stubEnv('CUMULO_ENV', 'test');
  });

  it('turns a thrown handler into a resolved 500 with an apiErrorSchema body', async () => {
    const { handleApiEvent, apiRequestFailedEvent } = await import('./main');
    const logged: Record<string, unknown>[] = [];

    const response: ApiResponse = await handleApiEvent(
      {
        routes: [throwingRoute(new Error('DynamoDB is having a day'))],
        log: (e) => logged.push(e),
      },
      gatewayEvent(),
      fullBudgetDeadline,
    );

    // Resolved, not rejected: a rejected promise is an unhandled Lambda error,
    // which the gateway renders as a body no client can parse.
    expect(response.statusCode).toBe(500);
    expect(apiErrorSchema.parse(jsonBodyOf(response)).code).toBe('internal');
    expect(logged).toHaveLength(1);
    expect(logged[0]?.event).toBe(apiRequestFailedEvent);
  });

  it('keeps the operator detail in the log and out of the response', async () => {
    const { handleApiEvent } = await import('./main');
    const logged: Record<string, unknown>[] = [];
    const secret = 'arn:aws:dynamodb:eu-west-1:123456789012:table/cumulo-sites-test';

    const response = await handleApiEvent(
      { routes: [throwingRoute(new Error(secret))], log: (e) => logged.push(e) },
      gatewayEvent(),
      fullBudgetDeadline,
    );

    expect(response.body).not.toContain(secret);
    expect(String(logged[0]?.detail)).toContain(secret);
  });

  it('survives a non-Error throw, which a naive .message would lose', async () => {
    const { handleApiEvent } = await import('./main');
    const logged: Record<string, unknown>[] = [];

    const response = await handleApiEvent(
      { routes: [throwingRoute('a string, thrown')], log: (e) => logged.push(e) },
      gatewayEvent(),
      fullBudgetDeadline,
    );

    expect(response.statusCode).toBe(500);
    expect(String(logged[0]?.detail)).toContain('non-Error thrown (string)');
  });

  it('answers 500 when the invocation payload is not a gateway event at all', async () => {
    const { handleApiEvent } = await import('./main');
    const logged: Record<string, unknown>[] = [];

    const response = await handleApiEvent(
      { routes: [], log: (e) => logged.push(e) },
      { httpMethod: 'GET', path: '/v1/sites' },
      fullBudgetDeadline,
    );

    expect(response.statusCode).toBe(500);
    expect(String(logged[0]?.detail)).toContain('payload v2');
  });

  it('leaves a route that answers normally alone, and logs nothing', async () => {
    const { handleApiEvent } = await import('./main');
    const logged: Record<string, unknown>[] = [];
    const route: Route = {
      method: 'GET',
      segments: ['v1', 'sites'],
      handle: () => Promise.resolve({ statusCode: 200, headers: {} }),
    };

    const response = await handleApiEvent(
      { routes: [route], log: (e) => logged.push(e) },
      gatewayEvent(),
      fullBudgetDeadline,
    );

    expect(response.statusCode).toBe(200);
    expect(logged).toEqual([]);
  });
});

/**
 * The invocation context, which this boundary used to drop on the floor (#165).
 *
 * Tested here rather than only in `http/request-deadline.test.ts` because the
 * unit test proves the deadline *reads* the context and this one proves the
 * number survives the trip — through `handleApiEvent`, through the router, and
 * onto the `RouteRequest` a handler is given. Those are two different ways to
 * be wrong, and the second is the one that was wrong before.
 */
describe('the invocation deadline reaching a handler', () => {
  /** Answers `remainingMs` with whatever the deadline it was given reports. */
  const probeRoute = (seen: number[]): Route => ({
    method: 'GET',
    segments: ['v1', 'sites'],
    handle: (request) => {
      seen.push(request.deadline.remainingMs());
      return Promise.resolve({ statusCode: 200, headers: {} });
    },
  });

  beforeEach(() => {
    vi.stubEnv('CUMULO_ENV', 'test');
  });

  it('hands the handler the context’s own remaining time', async () => {
    const { handleApiEvent } = await import('./main');
    const seen: number[] = [];
    // 1,234 is a number nothing in this service could compute: it is the
    // context's answer or it is nothing.
    const context = { getRemainingTimeInMillis: () => 1_234 };

    await handleApiEvent(
      { routes: [probeRoute(seen)], log: () => undefined },
      gatewayEvent(),
      lambdaContextDeadline(context, 15_000),
    );

    expect(seen).toEqual([1_234]);
  });

  it('hands the handler a budget countdown when the invocation had no context', async () => {
    const { handleApiEvent } = await import('./main');
    const seen: number[] = [];
    // A direct `aws lambda invoke` passes no context; the clock is injected so
    // the case needs no timers.
    const readings = [1_000, 3_000];
    const now = (): number => readings.shift() ?? 3_000;

    await handleApiEvent(
      { routes: [probeRoute(seen)], log: () => undefined },
      gatewayEvent(),
      lambdaContextDeadline(undefined, 15_000, now),
    );

    expect(seen).toEqual([13_000]);
  });
});

describe('parseWebOrigins', () => {
  beforeEach(() => {
    vi.stubEnv('CUMULO_ENV', 'test');
  });

  it('collapses every spelling of "no extra origins" to the same empty list', async () => {
    // Terraform's `web_origins` defaults to `""`, and a variable set to a
    // trailing comma or a stray space must not become an origin no browser
    // will ever send — which would be an allow-list entry that silently
    // matches nothing.
    const { parseWebOrigins } = await import('./main');

    expect(parseWebOrigins(undefined)).toEqual([]);
    expect(parseWebOrigins('')).toEqual([]);
    expect(parseWebOrigins('  ,  ,')).toEqual([]);
  });

  it('splits and trims a comma-separated list', async () => {
    const { parseWebOrigins } = await import('./main');

    expect(parseWebOrigins('https://a.example, https://b.example')).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });
});

/**
 * The abuse protections, exercised through the real route table (#29).
 *
 * Which routes carry the limiter and the origin check is a decision that lives
 * in `main.ts` and nowhere else, so it is only observable here — a unit test of
 * the wrappers would prove they work and say nothing about where they are
 * applied, which is the half that gets wrong in review.
 *
 * The storage adapters are stubbed at the prototype rather than injected: the
 * composition root builds them itself, on purpose (that is what makes it the
 * composition root), and stubbing the class the fresh module graph is about to
 * instantiate is the one seam that does not require inventing an injection
 * point for the benefit of a test.
 */
describe('the abuse protections on the route table', () => {
  const stubStorage = async () => {
    const storage = await import('@cumulo/storage');

    const getBlock = vi
      .spyOn(storage.AbuseAdapter.prototype, 'getBlock')
      .mockResolvedValue({ blocked: false });
    const incrementRateWindow = vi
      .spyOn(storage.AbuseAdapter.prototype, 'incrementRateWindow')
      .mockResolvedValue(1);
    vi.spyOn(storage.AbuseAdapter.prototype, 'putBlock').mockResolvedValue(undefined);
    vi.spyOn(storage.SiteAdapter.prototype, 'listFleetSites').mockResolvedValue([]);
    vi.spyOn(storage.SiteAdapter.prototype, 'createUserSiteWithCap').mockResolvedValue({
      created: true,
    });
    vi.spyOn(storage.SiteAdapter.prototype, 'getFleetSite').mockResolvedValue({ found: false });

    return { getBlock, incrementRateWindow };
  };

  const postSite = (headers: Record<string, string>): Record<string, unknown> =>
    gatewayEvent({
      method: 'POST',
      rawPath: '/v1/sites',
      headers,
      body: JSON.stringify(siteInput()),
    });

  const jsonHeaders = { 'content-type': 'application/json' };

  beforeEach(() => {
    vi.stubEnv('CUMULO_ENV', 'test');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('leaves the unlimited reads alone — listing the fleet never touches the abuse table', async () => {
    const { getBlock, incrementRateWindow } = await stubStorage();
    const { handler } = await import('./main');

    const response = await handler(gatewayEvent({ method: 'GET', rawPath: '/v1/sites' }));

    expect(response.statusCode).toBe(200);
    expect(getBlock).not.toHaveBeenCalled();
    expect(incrementRateWindow).not.toHaveBeenCalled();
  });

  it('refuses a write with no Origin header, before spending anything on the limiter', async () => {
    const { getBlock, incrementRateWindow } = await stubStorage();
    const { handler } = await import('./main');

    const response = await handler(postSite(jsonHeaders));

    expect(response.statusCode).toBe(403);
    expect(apiErrorSchema.parse(jsonBodyOf(response)).code).toBe('forbidden');
    // Origin is checked first because it is free: a drive-by script costs no
    // abuse-table write.
    expect(getBlock).not.toHaveBeenCalled();
    expect(incrementRateWindow).not.toHaveBeenCalled();
  });

  it('admits a write from the origin it was served from — Swagger UI’s try-it-out', async () => {
    const { getBlock } = await stubStorage();
    const { handler } = await import('./main');

    const response = await handler(postSite({ ...jsonHeaders, origin: OWN_ORIGIN }));

    expect(response.statusCode).toBe(201);
    expect(getBlock).toHaveBeenCalledWith(SOURCE_IP);
  });

  it('admits a write from a configured web origin', async () => {
    vi.stubEnv('CUMULO_WEB_ORIGINS', 'https://web.example');
    await stubStorage();
    const { handler } = await import('./main');

    const response = await handler(postSite({ ...jsonHeaders, origin: 'https://web.example' }));

    expect(response.statusCode).toBe(201);
  });

  it('answers 429 rate_limited with a retry-after once the window is spent', async () => {
    const { incrementRateWindow } = await stubStorage();
    incrementRateWindow.mockResolvedValue(MAX_LIMITED_REQUESTS_PER_WINDOW + 1);
    const { handler } = await import('./main');

    const response = await handler(postSite({ ...jsonHeaders, origin: OWN_ORIGIN }));

    expect(response.statusCode).toBe(429);
    // The header is the difference between a client that backs off and one that
    // hot-retries into the block it just earned.
    expect(response.headers['retry-after']).toBe('3600');
    expect(apiErrorSchema.parse(jsonBodyOf(response)).code).toBe('rate_limited');
  });

  it('limits the span-capped series read, whose cost per request the caller picks', async () => {
    const { getBlock } = await stubStorage();
    const { handler } = await import('./main');

    const response = await handler(
      gatewayEvent({
        method: 'GET',
        rawPath: `/v1/sites/${RANELAGH_ID}/series`,
        queryStringParameters: { from: '2026-07-31T00:00:00Z', to: '2026-07-31T06:00:00Z' },
      }),
    );

    // The site is stubbed away, so the answer is a 404 — what this proves is
    // that the limiter ran first, with no Origin header in sight: a read is not
    // a write, and the web app must be able to plot from wherever it is served.
    expect(response.statusCode).toBe(404);
    expect(getBlock).toHaveBeenCalledWith(SOURCE_IP);
  });
});
