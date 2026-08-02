import type { ApiRequest } from './gateway-event';
import type { RequestDeadline } from './request-deadline';
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
 *
 * Matching is **exact, deliberately**, because this table is not the only thing
 * that matches these paths: API Gateway matches its own declared route keys
 * against the raw path to decide which throttle applies. A router that accepted
 * spellings the gateway does not would let a caller pick the looser limit — see
 * {@link canonicalPathSegments}, where that reasoning lives.
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
 *
 * `sourceIp`, `originHeader` and `ownOrigin` ride through from
 * {@link ApiRequest} unchanged. The router makes no decision with any of them —
 * the abuse protections are wrappers around individual handlers in `main.ts`,
 * not a middleware layer here — but the wrapper receives a `RouteRequest`, so
 * the three have to survive the trip.
 *
 * `deadline` is the one field that comes from the *invocation* rather than from
 * the request: how much time is left before Lambda kills this call
 * (`request-deadline.ts`). It rides here rather than being threaded through
 * every handler's deps because it is a property of this request and not of the
 * container — a deps object is built once per container, and a deadline built
 * once per container would be the same wrong number for every invocation after
 * the first. The router makes no decision with it either; the handlers that
 * loop over storage commands do.
 */
export interface RouteRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string>;
  readonly params: Record<string, string>;
  readonly body: unknown;
  readonly sourceIp: string;
  readonly originHeader: string | undefined;
  readonly ownOrigin: string;
  readonly deadline: RequestDeadline;
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
 * The segments of a **canonical** path, or `undefined` for anything else.
 *
 * Canonical means: a leading `/`, and no empty segment after it. So `/v1/sites`
 * matches and `/v1/sites/`, `//v1//sites` and `/v1//sites` do not — they fall
 * through to the 404 below.
 *
 * This used to normalise instead, dropping empty segments so a trailing slash
 * named the same resource. That read as generosity and was a hole. **API
 * Gateway matches its declared route keys against the raw path, exactly**, and
 * `infra/api/gateway.tf` declares `POST /v1/sites`, `PUT /v1/sites/{siteId}`
 * and `DELETE /v1/sites/{siteId}` precisely so the stage can throttle those
 * three at 2 rps / burst 4 instead of the stage-wide 10 / 20 (ADR 0006 layer
 * 2). A request to `POST /v1/sites/` does not match that key, so it fell
 * through to `$default` — and a normalising router then served it as a create.
 * One trailing slash bought a 5× looser write throttle, which is the opposite
 * of a distinction no caller means to draw.
 *
 * Refusing to match is the fix that keeps the two tables agreeing on what a
 * route *is*, rather than teaching the gateway every spelling of every path:
 * slash variants declared at the gateway would be six more route keys to keep
 * in step with this file, and the next non-canonical form (`/v1//sites`) would
 * still be uncovered. The cost is that `GET /docs/` is now a 404 where it used
 * to render — accepted: `/docs` is what the runbook and every Swagger UI asset
 * URL use, and those are absolute (`/docs/swagger-ui.css`), so nothing in the
 * page depends on the trailing form.
 *
 * The gateway's exact-match behaviour is confirmed live by issue #29's E2
 * evidence run, which watches the tighter limit bite on `POST /v1/sites`.
 */
const canonicalPathSegments = (path: string): string[] | undefined => {
  const [leading, ...segments] = path.split('/');

  // A path that does not start with `/` has no leading empty piece, and one
  // with a doubled or trailing slash has an empty piece among the rest.
  if (leading !== '' || segments.includes('')) {
    return undefined;
  }

  return segments;
};

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
  const actual = canonicalPathSegments(request.path);
  if (actual === undefined) {
    return undefined;
  }

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
 *   error contract has one code for "there is nothing here" on purpose. A
 *   non-canonical path (`/v1/sites/`, `//v1//sites`) is "no route matches" for
 *   the gateway-parity reason on {@link canonicalPathSegments}.
 * - **A body that is not JSON** → 400 `validation_failed`, before the handler
 *   runs. A handler never sees text it would have to `JSON.parse` itself.
 *
 * Neither message quotes the request. Reflecting a caller-controlled path back
 * into a response body is free to do and free to regret.
 *
 * The `deadline` is a parameter rather than something derived here: this module
 * is pure matching, and the only place that knows what an invocation's time
 * budget *is* is the composition root that received the Lambda context.
 */
export const routeRequest = async (
  routes: readonly Route[],
  request: ApiRequest,
  deadline: RequestDeadline,
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
    sourceIp: request.sourceIp,
    originHeader: request.originHeader,
    ownOrigin: request.ownOrigin,
    deadline,
  });

  return response;
};
