import type { ApiRequest } from './gateway-event';
import { errorResponse, type ApiResponse } from './response';

/**
 * The route table and its matcher.
 *
 * A table rather than a framework. Seven routes, one path parameter and no
 * middleware do not pay for a dependency — and a framework here would be a
 * dependency whose own types sit between this service and the gateway payload
 * it already parses. What a framework would give us is exactly what this file
 * is: match a method and a path, extract the parameters, and decide what an
 * unmatched request means.
 */

/** A path segment that captures its value under `param` rather than matching a literal. */
export interface PathParameter {
  readonly param: string;
}

/** Either a literal segment (`'sites'`) or a capture (`{ param: 'siteId' }`). */
export type PathSegment = string | PathParameter;

/**
 * A matched request, as a handler receives it.
 *
 * `body` is `unknown` and pre-parsed from JSON: the router owns "is this JSON at
 * all", and the handler owns "is this JSON the thing I need", which is what
 * keeps a single `validation_failed` shape across both without a `try`/`catch`
 * per handler.
 */
export interface RouteRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string>;
  readonly params: Record<string, string>;
  readonly body: unknown;
}

export type RouteHandler = (request: RouteRequest) => Promise<ApiResponse>;

export interface Route {
  readonly method: string;
  readonly segments: readonly PathSegment[];
  readonly handle: RouteHandler;
}

/** A route and the parameters its pattern captured from the request path. */
export interface RouteMatch {
  readonly route: Route;
  readonly params: Record<string, string>;
}

/**
 * Empty segments are dropped, so `/v1/sites`, `/v1/sites/` and `//v1//sites`
 * are one resource. The alternative — 404 on a trailing slash — is a distinction
 * no caller means to draw.
 */
const pathSegments = (path: string): string[] =>
  path.split('/').filter((segment) => segment !== '');

const matchSegments = (
  pattern: readonly PathSegment[],
  actual: readonly string[],
): Record<string, string> | undefined => {
  if (pattern.length !== actual.length) {
    return undefined;
  }

  const params: Record<string, string> = {};
  for (const [index, segment] of pattern.entries()) {
    const value = actual[index];
    if (value === undefined) {
      return undefined;
    }
    if (typeof segment === 'string') {
      if (segment !== value) {
        return undefined;
      }
    } else {
      params[segment.param] = value;
    }
  }

  return params;
};

/**
 * The first route whose method and pattern both match, in table order.
 *
 * Exported because matching is the interesting, entirely pure half of this
 * module — a table with two patterns that can both match one path is a bug
 * worth a test that needs no handlers and no promises.
 */
export const matchRoute = (
  routes: readonly Route[],
  request: ApiRequest,
): RouteMatch | undefined => {
  const actual = pathSegments(request.path);

  for (const route of routes) {
    if (route.method !== request.method) {
      continue;
    }
    const params = matchSegments(route.segments, actual);
    if (params !== undefined) {
      return { route, params };
    }
  }

  return undefined;
};

/** A body that was not JSON is a value here, not a throw — it is a caller's 400. */
type JsonBodyResult = { readonly ok: true; readonly body: unknown } | { readonly ok: false };

const parseJsonBody = (rawBody: string | undefined): JsonBodyResult => {
  if (rawBody === undefined || rawBody.trim() === '') {
    return { ok: true, body: undefined };
  }

  try {
    const body: unknown = JSON.parse(rawBody);
    return { ok: true, body };
  } catch {
    // Converted to an expected-failure value rather than swallowed
    // (`docs/standards/error-handling.md` rule 2a): the caller sent bytes that
    // are not JSON, which is a domain outcome of an HTTP API, not a bug.
    return { ok: false };
  }
};

/**
 * Route one parsed request to its handler.
 *
 * Two failures are answered here rather than in any handler, because both are
 * properties of the *request* and not of the resource:
 *
 * - **No route matches** → 404 `not_found`. Method mismatch included: a 405
 *   would tell an unauthenticated caller which methods a path supports, and the
 *   error contract has one code for "there is nothing here" on purpose.
 * - **A body that is not JSON** → 400 `validation_failed`, before the handler
 *   runs. A handler never sees text it would have to `JSON.parse` itself.
 *
 * Neither message quotes the request. Reflecting a caller-controlled path back
 * into a response body is free to do and free to regret.
 */
export const routeRequest = async (
  routes: readonly Route[],
  request: ApiRequest,
): Promise<ApiResponse> => {
  const match = matchRoute(routes, request);
  if (match === undefined) {
    return errorResponse('not_found', 'no route matches this method and path');
  }

  const parsed = parseJsonBody(request.rawBody);
  if (!parsed.ok) {
    return errorResponse('validation_failed', 'the request body is not valid JSON');
  }

  const response = await match.route.handle({
    method: request.method,
    path: request.path,
    query: request.query,
    params: match.params,
    body: parsed.body,
  });

  return response;
};
