import { apiErrorSchema } from '@cumulo/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { gatewayEvent, jsonBodyOf } from './api-fixtures';
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
    );

    expect(response.statusCode).toBe(200);
    expect(logged).toEqual([]);
  });
});
