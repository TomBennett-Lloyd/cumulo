import { apiErrorSchema, type ApiError, type ApiErrorCode } from '@cumulo/shared';
import type { ZodError, ZodType, output } from 'zod';

/**
 * The response half of this service's HTTP boundary: the shape API Gateway
 * expects back from a payload-v2 Lambda integration, and the two ways this API
 * ever produces one — a validated success body, or an `apiErrorSchema` failure.
 */

/**
 * What the API Gateway HTTP API (payload format 2.0) accepts as a Lambda's
 * response object.
 *
 * `body` is absent rather than empty for a 204: the gateway distinguishes the
 * two, and an empty-string body on a no-content response is a content-length
 * header nobody asked for. `isBase64Encoded` is here because binary assets are
 * served over this same seam (the Swagger UI bundle).
 */
export interface ApiResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly isBase64Encoded?: boolean;
}

/**
 * The field-level reasons an {@link ApiError} body carries.
 */
export type ApiErrorDetails = NonNullable<ApiError['details']>;

/**
 * The status ↔ code mapping the Fleet API's error contract fixes, as data.
 *
 * The mapping is stated in `apiErrorCodeSchema`'s doc comment in `@cumulo/shared`
 * and this is its executable half.
 *
 * `Readonly` is load-bearing rather than tidy: the map is read at **two
 * different times**. `src/openapi/paths.ts` reads it once at module load, to key
 * each documented error response, and {@link errorResponse} reads it again on
 * every request. A write between those two moments would leave the published
 * document promising a status the API no longer answers with.
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
 */
export const zodIssueDetails = (error: ZodError): ApiErrorDetails =>
  error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.map((segment) => String(segment)).join('.') : '<root>',
    message: issue.message,
  }));

/**
 * The same zod failure rendered as one log line.
 *
 * Used where a parse failure is not a response.
 */
export const describeZodIssues = (error: ZodError): string =>
  zodIssueDetails(error)
    .map((detail) => `${detail.path}: ${detail.message}`)
    .join('; ');

/**
 * A success response, **validated against its own schema before serialising**.
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
 * `retry-after` turns "you are being limited" into "come back at this time",
 * which is the difference between a client that backs off and one that
 * hot-retries into the block already in force.
 */
export const rateLimitedResponse = (retryAfterSeconds: number): ApiResponse => {
  // A violated invariant, not a domain outcome (error-handling rule 1).
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
