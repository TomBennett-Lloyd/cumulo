import { z } from 'zod';

/**
 * Why a Fleet API request failed, in the API's own vocabulary.
 *
 * Five codes, each pinned to exactly one HTTP status so a client can branch on
 * either and reach the same conclusion:
 *
 * - `validation_failed` → **400** — the request was understood and rejected:
 *   a malformed JSON body, a path parameter that is not a uuid, a query
 *   parameter outside its allowed set, or a body that fails its zod schema
 *   (the failing paths are then carried in `details`)
 * - `forbidden` → **403** — refused on *policy* rather than on content: a write
 *   whose `Origin` this deployment does not serve, or a caller currently blocked
 *   for abuse (#29). Not "unauthorized", because there are no credentials to
 *   present — nothing the caller can add to this request makes it succeed
 * - `not_found` → **404** — covers both an unknown route and a known route
 *   naming an entity that does not exist. One code, because the distinction is
 *   not one an unauthenticated caller is entitled to; probing for which sites
 *   exist should not be cheaper than probing for which routes do
 * - `rate_limited` → **429** — the service's own per-IP limiter refused the
 *   request. The response carries a `retry-after` header naming the wait in
 *   seconds
 * - `internal` → **500** — the top-level error boundary caught something
 *   unexpected. The message is deliberately generic; the detail goes to the
 *   structured log, not to the caller
 *
 * **429 has two producers, and only one of them speaks this schema.** API
 * Gateway's throttles — the stage limit and the per-route write limits — answer
 * *before* the Lambda is invoked, with the gateway's own `{ "message": … }`
 * body that no code in this repository can shape. The per-IP limiter inside the
 * Lambda answers with `rate_limited` in this schema. A client therefore cannot
 * use the body to recognise throttling and must not try: **status is the
 * contract and this schema is the elaboration of it**, so a 429 means back off
 * whichever producer sent it, reading `retry-after` when it is present rather
 * than requiring it.
 */
export const apiErrorCodeSchema = z.enum([
  'validation_failed',
  'not_found',
  'forbidden',
  'rate_limited',
  'internal',
]);

export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

/**
 * One field-level reason inside a {@link apiErrorSchema} body.
 *
 * `path` is the dotted location within the request the caller sent
 * (`capacityKw`, `location.latitude`), flattened to a string rather than left as
 * zod's `(string | number)[]` so the wire shape stays trivially representable in
 * the generated OpenAPI document.
 */
const apiErrorDetailSchema = z.object({
  path: z.string(),
  message: z.string(),
});

/**
 * The one error body every Fleet API endpoint returns — see
 * {@link apiErrorCodeSchema} for the status ↔ code mapping and for the one
 * status — 429 — a caller can also receive in a body this schema did not shape.
 *
 * A single shape for every failing route is what lets a client write one error
 * path instead of one per endpoint, and what lets the OpenAPI document reference
 * a single `ApiError` component from every non-2xx response.
 *
 * `details` is present only for `validation_failed`, where naming the offending
 * fields is the difference between an actionable error and a shrug. It is
 * optional rather than an empty array on the other codes so that its presence
 * itself means "there is something field-specific to say".
 */
export const apiErrorSchema = z.object({
  code: apiErrorCodeSchema,
  message: z.string().min(1),
  details: z.array(apiErrorDetailSchema).optional(),
});

export type ApiError = z.infer<typeof apiErrorSchema>;
