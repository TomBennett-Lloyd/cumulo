import type { ApiErrorCode } from '@cumulo/shared';

import { apiErrorStatus } from '../http/response';

import { componentRef, type ComponentSchemaName } from './components';
import type { ContentObject, ResponseObject, ResponsesObject, SchemaObject } from './openapi-types';

/**
 * How this document describes what comes *back*: the content wrappers, the
 * error-code vocabulary, and the two failures every operation shares.
 *
 * Split out of `paths.ts` so that file is the operation table and nothing else.
 * The seam is the same one `http/router.ts` and `http/response.ts` draw in the
 * running service — what a request matches versus what a response is — and it
 * is what keeps the error contract stated once here rather than retyped on ten
 * operations.
 *
 * **Statuses are read, not restated.** Every `apiErrorSchema` response below is
 * keyed by `apiErrorStatus[code]` — the same map `errorResponse` derives a
 * status line from. A document that hard-coded `'404'` beside `not_found` would
 * be a second statement of the error contract, free to disagree with the first
 * one the day it changed.
 */

export const jsonContent = (schema: SchemaObject): ContentObject => ({
  'application/json': { schema },
});

export const componentResponse = (
  description: string,
  name: ComponentSchemaName,
): ResponseObject => ({
  description,
  content: jsonContent(componentRef(name)),
});

/**
 * What each error code means to a caller, once, since the same sentences would
 * otherwise be retyped on every documented operation.
 *
 * Exhaustive by type (`Record<ApiErrorCode, string>`), which is the mechanism
 * that keeps it honest: a code added to `apiErrorCodeSchema` in `@cumulo/shared`
 * is a type error here until someone decides what it means to a caller, rather
 * than a code that reaches the published document undocumented.
 */
const apiErrorDescriptions: Record<ApiErrorCode, string> = {
  validation_failed:
    'The request was rejected before anything was read. `details` names the fields at fault.',
  forbidden: [
    'Refused on policy rather than on content — the request is well-formed, but this',
    'deployment does not serve it from where it came from. No credential makes it',
    'succeed; there are none to present.',
  ].join(' '),
  not_found: 'No such resource. An unknown route and an unknown site id both answer this way.',
  rate_limited: [
    'Refused by this service’s own rate limiter. `retry-after` names the wait in seconds.',
    'The other 429 below is API Gateway’s throttle, which answers before this service',
    'is invoked and does not use this body shape.',
  ].join(' '),
  internal:
    'Something failed that this service did not predict. The detail is in the log, not in the body.',
};

export const errorResponses = (...codes: readonly ApiErrorCode[]): ResponsesObject =>
  Object.fromEntries(
    codes.map((code) => [
      String(apiErrorStatus[code]),
      componentResponse(apiErrorDescriptions[code], 'ApiError'),
    ]),
  );

/**
 * The 429 every operation can answer — and the reason this document cannot
 * promise one body shape for it.
 *
 * **Two producers, two bodies.** API Gateway throttles first, before this
 * Lambda is invoked: the stage limit (ADR 0005: 10 requests/second, burst 20)
 * on everything, and a tighter per-route limit (ADR 0006: 2/second, burst 4) on
 * the three write routes. Those 429s carry the gateway's own `{ "message": … }`
 * and no code in this repository can shape them. The service's own per-IP
 * limiter answers the other 429s, in the `ApiError` shape with code
 * `rate_limited` and a `retry-after` header.
 *
 * The schema below is therefore stated as "either", rather than picking the
 * body we would have preferred and documenting a half-truth. What a client
 * should actually do is the same in both cases and is the point of saying all
 * this: **map on the status**, and read `retry-after` when it is there.
 */
const throttledResponse: ResponsesObject = {
  '429': {
    description: [
      'Too many requests, from one of two places. API Gateway throttles first — 10',
      'requests/second (burst 20) across the API, and 2/second (burst 4) on the three',
      'write routes — and its 429 carries the gateway’s own `{ "message": … }` body.',
      'Past that, this service’s per-IP limiter refuses more than 30 requests per',
      '60-second window to the write routes, `GET /v1/sites/{siteId}/series` and both',
      'fleet routes — `GET /v1/fleet/actuals` and `GET /v1/fleet/forecast`, whose cost',
      'grows with the fleet — and blocks the address for an hour; that 429 is an ApiError',
      'with code `rate_limited` and a `retry-after` header naming the wait in seconds.',
      'Branch on the status, never on the body.',
    ].join(' '),
    content: jsonContent({
      oneOf: [
        componentRef('ApiError'),
        {
          type: 'object',
          properties: { message: { type: 'string' } },
          required: ['message'],
        },
      ],
    }),
  },
};

/**
 * The two failures every operation shares, whatever it does.
 *
 * **Two, not three.** A request killed at the function timeout answers a gateway
 * 504, and that one is not documentable here at all: the invocation dies before
 * `main.ts`'s error boundary runs, so no code in this repository shapes the body
 * and this document would be describing something it does not produce. It is
 * unreachable through every *looping* path — the per-request deadline
 * (`http/request-deadline.ts`) stops those between commands — and the one
 * residual that remains is stated rather than silent, in `apps/api/README.md`'s
 * error contract: independent per-command worst cases coinciding in a route's
 * ungated straight-line prefix, counted per route in `../request-budget.ts` and
 * carried in `docs/tech-debt.md`.
 */
export const commonFailures: ResponsesObject = {
  ...throttledResponse,
  ...errorResponses('internal'),
};
