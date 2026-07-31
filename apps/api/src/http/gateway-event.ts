import { Buffer } from 'node:buffer';

import { z } from 'zod';

import { describeZodIssues } from './response';

/**
 * The request half of this service's HTTP boundary: an API Gateway HTTP API
 * event (payload format **2.0**) turned into the four things this API actually
 * routes on.
 *
 * There is no `@types/aws-lambda` dependency here on purpose. An invocation
 * payload is external data, and `docs/standards/typing.md` rule 3 makes external
 * data `unknown` until a schema parses it — a hand-installed `.d.ts` would let
 * the compiler believe a shape nothing checked, which is exactly the class of
 * bug a malformed event causes at 3am. Parsing also documents the *slice* this
 * service depends on: five fields out of a payload with about forty.
 */

/**
 * The slice of the payload-v2 event this API reads.
 *
 * `.nullish()` rather than `.optional()` on the absent-able fields is deliberate
 * tolerance at the boundary: the gateway omits `queryStringParameters` and
 * `body` when there are none, but a null from any producer on this seam (a
 * console test invoke, a future Function URL) would otherwise fail every
 * request that simply had no query string. Being strict about a field's *type*
 * and liberal about its absence is the useful combination.
 *
 * `headers` is parsed as part of the v2 shape but deliberately not surfaced on
 * {@link ApiRequest}: no route reads a header yet, and a field on the request
 * type that nothing consumes is an invitation to start branching on transport
 * detail. Adding it is one line the day a route needs one.
 */
const gatewayEventSchema = z.object({
  rawPath: z.string(),
  requestContext: z.object({ http: z.object({ method: z.string() }) }),
  body: z.string().nullish(),
  isBase64Encoded: z.boolean().nullish(),
  queryStringParameters: z.record(z.string(), z.string()).nullish(),
  headers: z.record(z.string(), z.string()).nullish(),
});

/**
 * One request, in this service's own vocabulary.
 *
 * `rawBody` is the undecoded *text*: whether it is JSON is the router's
 * question, and whether that JSON is a valid site is the handler's. Splitting
 * those three is what lets "not JSON at all" be one 400 in one place rather
 * than a `try`/`catch` in every handler that accepts a body.
 */
export interface ApiRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string>;
  readonly rawBody: string | undefined;
}

/**
 * The body as text, with the gateway's base64 wrapper removed when it applied.
 *
 * The gateway base64-encodes a body it considers binary, which depends on the
 * request's content type rather than on anything this API controls — so a JSON
 * body can arrive encoded, and a decoder that only runs "for binary routes"
 * would drop it.
 */
const decodeBody = (body: string, isBase64Encoded: boolean): string =>
  isBase64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;

/**
 * Parse an invocation payload, or throw.
 *
 * A throw rather than a 400 (`docs/standards/error-handling.md` rule 1): an
 * event that is not a payload-v2 event means this function is wired to
 * something other than the HTTP API its Terraform configures, which is a broken
 * deployment rather than a caller's mistake. The boundary in `main.ts` catches
 * it, logs the offending fields, and answers 500 — the honest status for
 * "nothing about this request was ever understood".
 */
export const parseGatewayEvent = (event: unknown): ApiRequest => {
  const parsed = gatewayEventSchema.safeParse(event);
  if (!parsed.success) {
    throw new Error(
      `api: event is not an API Gateway payload v2 request — ${describeZodIssues(parsed.error)}`,
    );
  }

  const { rawPath, requestContext, body, isBase64Encoded, queryStringParameters } = parsed.data;

  return {
    method: requestContext.http.method,
    path: rawPath,
    query: queryStringParameters ?? {},
    rawBody:
      body === null || body === undefined ? undefined : decodeBody(body, isBase64Encoded === true),
  };
};
