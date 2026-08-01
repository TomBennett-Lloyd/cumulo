import { apiErrorSchema, type ApiError, type ApiErrorCode } from '@cumulo/shared';
import type { ZodError, ZodType, output } from 'zod';

/**
 * The response half of this service's HTTP boundary: the shape API Gateway
 * expects back from a payload-v2 Lambda integration, and the two ways this API
 * ever produces one — a validated success body, or an `apiErrorSchema` failure.
 *
 * Nothing below reaches for a framework's `res.json()`, because there is no
 * framework: a response is a value, built and returned like any other, which is
 * what lets every handler be tested by calling it.
 */

/**
 * What the API Gateway HTTP API (payload format 2.0) accepts as a Lambda's
 * response object.
 *
 * `body` is absent rather than empty for a 204: the gateway distinguishes the
 * two, and an empty-string body on a no-content response is a content-length
 * header nobody asked for. `isBase64Encoded` is here because binary assets are
 * served over this same seam (the Swagger UI bundle); no route in this chunk
 * sets it.
 */
export interface ApiResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly isBase64Encoded?: boolean;
}

/**
 * The field-level reasons an {@link ApiError} body carries, named once here so
 * handlers and the zod mapping below agree on one type rather than three
 * spellings of `NonNullable<ApiError['details']>`.
 */
export type ApiErrorDetails = NonNullable<ApiError['details']>;

/**
 * The status ↔ code mapping the Fleet API's error contract fixes, as data.
 *
 * It lives here, once, so no call site can pair a 404 with `validation_failed`:
 * {@link errorResponse} takes the code and derives the status from it. The
 * mapping is stated in `apiErrorCodeSchema`'s doc comment in `@cumulo/shared`
 * and this is its executable half.
 *
 * 429 appears here now because the service produces one of its own — see
 * {@link rateLimitedResponse}. It is still not the *only* 429 a caller can see:
 * API Gateway's throttles answer before this Lambda is invoked, in a body no
 * code here shapes, which is why the contract tells clients to map on status.
 *
 * `Readonly` is load-bearing rather than tidy: the map is read at **two
 * different times**. `src/openapi/paths.ts` reads it once at module load, to key
 * each documented error response, and {@link errorResponse} reads it again on
 * every request. A write between those two moments would leave the published
 * document promising a status the API no longer answers with — the exact
 * disagreement this map exists to make impossible.
 */
export const apiErrorStatus: Readonly<Record<ApiErrorCode, number>> = {
  validation_failed: 400,
  forbidden: 403,
  not_found: 404,
  rate_limited: 429,
  internal: 500,
};

/**
 * A fresh headers object per response rather than one shared constant: the type
 * is a mutable `Record` because that is what the gateway contract is, and a
 * shared literal would let one route's header edit reach every other route's
 * response.
 */
const jsonHeaders = (): Record<string, string> => ({ 'content-type': 'application/json' });

/**
 * A zod failure rendered as the `details` a caller can act on.
 *
 * `path` is flattened to a dotted string (`location.latitude`) because the wire
 * contract in `@cumulo/shared` is a string — zod's `(string | number | symbol)[]`
 * has no natural JSON form and would leak the parser's own vocabulary into the
 * API. `String(...)` rather than a bare `join` because `Array.prototype.join`
 * throws on a symbol key, which a record schema can legitimately produce.
 *
 * Every issue is listed, not the first: a body with three bad fields should take
 * one fix rather than one request per problem.
 */
export const zodIssueDetails = (error: ZodError): ApiErrorDetails =>
  error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.map((segment) => String(segment)).join('.') : '<root>',
    message: issue.message,
  }));

/**
 * The same zod failure rendered as one log line.
 *
 * Defined in terms of {@link zodIssueDetails} rather than beside it, so the path
 * flattening a caller sees in a 400 body and the one an operator sees in
 * CloudWatch cannot drift apart. Used where a parse failure is not a response —
 * the composition root's environment check, and the gateway event that did not
 * look like a gateway event.
 */
export const describeZodIssues = (error: ZodError): string =>
  zodIssueDetails(error)
    .map((detail) => `${detail.path}: ${detail.message}`)
    .join('; ');

/**
 * A success response, **validated against its own schema before serialising**.
 *
 * The parse is the point. A response schema that is only used to generate the
 * OpenAPI document is a promise nothing keeps; parsing through it here makes the
 * document and the bytes on the wire the same fact, and turns a handler that
 * quietly returns the wrong shape into a 500 (via the boundary in `main.ts`)
 * rather than into a client that silently mis-renders.
 *
 * It also normalizes: zod strips keys the schema does not declare, so a stored
 * item that grew an attribute cannot leak it into a public response.
 */
export const jsonResponse = <TSchema extends ZodType>(
  statusCode: number,
  schema: TSchema,
  value: output<TSchema>,
): ApiResponse => ({
  statusCode,
  headers: jsonHeaders(),
  body: JSON.stringify(schema.parse(value)),
});

/**
 * The one failure response every route returns, in the one shape every route
 * returns it (`apiErrorSchema`).
 *
 * The status comes from {@link apiErrorStatus}, not from the caller, so the
 * contract is enforced by construction. The body is parsed through
 * `apiErrorSchema` on the way out for the same reason successes are: this is the
 * shape the OpenAPI document will promise from every non-2xx response.
 *
 * `details` is omitted rather than passed as `undefined` — `exactOptionalPropertyTypes`
 * is on, and the schema's optionality is meant to carry "there is something
 * field-specific to say", which an explicit `undefined` would blur.
 */
export const errorResponse = (
  code: ApiErrorCode,
  message: string,
  details?: ApiErrorDetails,
): ApiResponse =>
  jsonResponse(apiErrorStatus[code], apiErrorSchema, {
    code,
    message,
    ...(details === undefined ? {} : { details }),
  });

/**
 * The 429 this service produces itself — its per-IP limiter's refusal — as
 * distinct from the 429 API Gateway's throttles produce before the Lambda is
 * ever invoked.
 *
 * The only response in this API that carries a header beyond `content-type`,
 * and that header is the whole point of the function existing: `retry-after`
 * turns "you are being limited" into "come back at this time", which is the
 * difference between a client that backs off and one that hot-retries into the
 * block already in force. Seconds rather than an HTTP-date because the
 * limiter's window is a *duration*, and a duration cannot be misread by a
 * caller whose clock disagrees with ours.
 *
 * The wait is stated twice on purpose — once machine-readable in the header,
 * once in the message a human sees in a terminal — and both come from the same
 * argument in the same expression, so the two cannot drift.
 *
 * The body is built by {@link errorResponse}, so the status still comes from
 * {@link apiErrorStatus} and is still parsed through `apiErrorSchema`: this
 * adds a header to that response rather than assembling a second one beside it.
 */
export const rateLimitedResponse = (retryAfterSeconds: number): ApiResponse => {
  // A violated invariant, not a domain outcome (error-handling rule 1): a
  // fractional or non-positive `retry-after` is not a header value a client can
  // act on, and one that fails to parse is read as "retry now" — straight back
  // into the limiter that just refused.
  if (!Number.isInteger(retryAfterSeconds) || retryAfterSeconds < 1) {
    throw new Error(
      `rateLimitedResponse: retryAfterSeconds must be a positive integer, got ${String(retryAfterSeconds)}`,
    );
  }

  const response = errorResponse(
    'rate_limited',
    `Too many requests from this address. Retry in ${String(retryAfterSeconds)} seconds.`,
  );

  return {
    ...response,
    headers: { ...response.headers, 'retry-after': String(retryAfterSeconds) },
  };
};
