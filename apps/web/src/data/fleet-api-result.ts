import { apiErrorSchema, describeThrown, describeZodIssues } from '@cumulo/shared';
import type { ZodType } from 'zod';

import type { FleetDataError, FleetSourceResult } from './fleet-data-source';

/**
 * The transport → domain boundary of the HTTP fleet source: one `Response` in,
 * one {@link FleetSourceResult} out.
 *
 * Pure of `fetch` on purpose. Everything interesting about the mapping —
 * which status means which recourse, when `Retry-After` is believed, what a
 * body that fails its schema is worth — is decided here, where a test hands it
 * a `Response` it constructed and reads back the value a view would render.
 * `http-fleet-data-source.ts` is then only URLs, and the transport has no
 * opinions of its own to test.
 *
 * The mapping itself is specified on `FleetDataSource` in
 * `fleet-data-source.ts`; this module implements that paragraph and does not
 * restate it.
 */

/**
 * The error arm says nothing about the success type, so one
 * `FleetSourceResult<never>` is assignable wherever any `FleetSourceResult<T>`
 * is expected.
 */
const errorResult = (error: FleetDataError): FleetSourceResult<never> => ({
  kind: 'error',
  error,
});

/** A body that parsed as JSON, or the reason there was none to parse. */
type JsonBody =
  | { readonly parsed: true; readonly value: unknown }
  | { readonly parsed: false; readonly reason: string };

/**
 * `response.json()`, as a value rather than a throw.
 *
 * A non-JSON body is an ordinary thing for this client to receive — a gateway
 * error page, a proxy's HTML, a truncated response — so it is an expected
 * failure (`error-handling.md` rule 1) rather than an exception the caller
 * would have to remember to catch.
 */
const readJsonBody = async (response: Response): Promise<JsonBody> => {
  try {
    const value: unknown = await response.json();
    return { parsed: true, value };
  } catch (thrown: unknown) {
    return { parsed: false, reason: describeThrown(thrown) };
  }
};

/**
 * What the server said about a failure, for the human-readable half of the
 * error (`error-handling.md` rule 4).
 *
 * `apiErrorSchema` is *tolerated*, not required. API Gateway's own throttles
 * answer before the Lambda runs, with a body no code in this repository shapes,
 * so a 429 legitimately arrives without an `ApiError` in it — and a body this
 * client cannot read must not turn a well-understood status into a mystery.
 */
const describeFailureBody = async (response: Response): Promise<string> => {
  const status = String(response.status);
  const body = await readJsonBody(response);
  if (!body.parsed) {
    return `HTTP ${status}, body unreadable (${body.reason})`;
  }

  const apiError = apiErrorSchema.safeParse(body.value);
  return apiError.success
    ? `HTTP ${status}: ${apiError.data.message}`
    : `HTTP ${status}, body not in this API's error shape`;
};

/** Seconds, as `Retry-After` states them when it states them in seconds. */
const RETRY_AFTER_SECONDS_PATTERN = /^\d+$/;

/**
 * The wait the server asked for, or `undefined` when it did not ask for one.
 *
 * `Retry-After` has a second legal form — an HTTP-date — which is deliberately
 * read as "no stated wait" rather than converted. Converting it would make the
 * wait depend on this client's clock agreeing with the server's, and a caller
 * backing off on its own schedule is strictly safer than one backing off on a
 * skewed date. Absent is not zero, which is why this returns `undefined` and
 * the field is omitted rather than defaulted.
 */
const statedRetryAfterSeconds = (response: Response): number | undefined => {
  const header = response.headers.get('Retry-After');
  if (header === null) {
    return undefined;
  }

  const trimmed = header.trim();
  return RETRY_AFTER_SECONDS_PATTERN.test(trimmed) ? Number.parseInt(trimmed, 10) : undefined;
};

/**
 * Built in two shapes rather than with `retryAfterSeconds: undefined`, because
 * `exactOptionalPropertyTypes` makes those two different values and only one of
 * them means "the server said nothing" (`typing.md` rule 5).
 */
const rateLimited = (response: Response, message: string): FleetSourceResult<never> => {
  const seconds = statedRetryAfterSeconds(response);
  return errorResult(
    seconds === undefined
      ? { code: 'rate-limited', message }
      : { code: 'rate-limited', message, retryAfterSeconds: seconds },
  );
};

/**
 * One Fleet API response, as the outcome a view can act on.
 *
 * `operation` is the caller's own description of what it was doing, and it is
 * expected to name the entity — `getSiteForecast (site 8f2…)` rather than
 * `getSiteForecast` — because it becomes the whole of the context the error
 * carries (`error-handling.md` rule 4).
 *
 * Success is `schema.safeParse` of the body and nothing else: a 2xx whose
 * payload does not match the domain schemas is `invalid-response`, exactly like
 * a 400, because both mean the bytes on the wire cannot be believed.
 */
export const parseFleetApiResponse = async <T>(
  operation: string,
  schema: ZodType<T>,
  response: Response,
): Promise<FleetSourceResult<T>> => {
  if (response.ok) {
    const body = await readJsonBody(response);
    if (!body.parsed) {
      return errorResult({
        code: 'invalid-response',
        message: `${operation}: the response body was not JSON (${body.reason})`,
      });
    }

    const parsed = schema.safeParse(body.value);
    return parsed.success
      ? { kind: 'ok', value: parsed.data }
      : errorResult({
          code: 'invalid-response',
          message: `${operation}: the response did not match its schema — ${describeZodIssues(parsed.error)}`,
        });
  }

  const detail = await describeFailureBody(response);
  switch (response.status) {
    case 400:
      return errorResult({
        code: 'invalid-response',
        message: `${operation}: the API rejected the request — ${detail}`,
      });
    case 403:
      return errorResult({
        code: 'forbidden',
        message: `${operation}: refused by the API's access policy — ${detail}. This deployment's origin has to be in the API's CUMULO_WEB_ORIGINS; retrying cannot help.`,
      });
    case 404:
      return errorResult({
        code: 'not-found',
        message: `${operation}: the API has no such entity — ${detail}`,
      });
    case 429:
      return rateLimited(
        response,
        `${operation}: the API is rate-limiting this client — ${detail}`,
      );
    default:
      return errorResult({
        code: 'network',
        message: `${operation}: the API could not answer — ${detail}`,
      });
  }
};

/**
 * A `fetch` that rejected, as the `network` arm.
 *
 * `fetch` rejects for exactly the reasons `network` describes — no DNS, no
 * route, connection reset, a CORS preflight the browser refused — none of which
 * produced an answer, and all of which are worth retrying on a backoff. It is a
 * separate export rather than a `catch` inside a request helper so that the
 * conversion has one definition and one test, wherever the `try` happens to sit.
 */
export const thrownToNetworkFailure = (
  operation: string,
  thrown: unknown,
): FleetSourceResult<never> =>
  errorResult({
    code: 'network',
    message: `${operation}: the request never produced a response (${describeThrown(thrown)})`,
  });
