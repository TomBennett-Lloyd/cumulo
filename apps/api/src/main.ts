import { randomUUID } from 'node:crypto';

import { utcIsoTimestampSchema, type UtcIsoTimestamp } from '@cumulo/shared';
import { SiteAdapter, createStorageDocumentClient, storageTableName } from '@cumulo/storage';
import { z } from 'zod';

import { parseGatewayEvent } from './http/gateway-event';
import { describeZodIssues, errorResponse, type ApiResponse } from './http/response';
import { routeRequest, type Route } from './http/router';
import { createSite, type CreateSiteDeps } from './sites/create-site';
import { deleteSite } from './sites/delete-site';
import { getSite } from './sites/get-site';
import { listSites } from './sites/list-sites';
import { siteIdParamName } from './sites/site-id-param';
import { updateSite } from './sites/update-site';

/**
 * The composition root, and the module the bundled artifact's `handler` export
 * comes from.
 *
 * Everything that is a *decision* about the running system lives here and only
 * here: which tables, which routes, which clock, which log sink. Every module
 * beneath takes its collaborators as parameters, which is what lets every route
 * — including its failure paths — run in a unit test with no AWS in sight
 * (`docs/standards/architecture.md` rule 3).
 *
 * The composition happens at **module scope**, on purpose. Lambda reuses a warm
 * container across invocations, so the client built here is built once per
 * container rather than once per request — and a missing or malformed
 * environment variable fails the *initialization*, before any request gets an
 * answer that looks like a product bug.
 */

/**
 * The environment this service requires, as the only place `process.env` is read
 * (`docs/standards/typing.md` rule 3).
 *
 * `AWS_REGION` is deliberately absent: Lambda always sets it and the SDK reads
 * it directly. `CUMULO_ENV` is checked only for being non-empty — the alphabet a
 * real environment name must satisfy is `storageTableName`'s, which mirrors
 * `infra/storage/variables.tf`, and restating the pattern here would make a
 * third copy of it.
 */
export const apiEnvSchema = z.object({
  CUMULO_ENV: z.string().min(1),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;

/**
 * Parse the process environment, or fail loudly.
 *
 * A throw rather than a value (`docs/standards/error-handling.md` rule 1): a
 * missing table environment is a deployment that is wrong, not an outcome a
 * request could handle.
 */
export const parseApiEnv = (source: Record<string, string | undefined>): ApiEnv => {
  const parsed = apiEnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`api: invalid environment — ${describeZodIssues(parsed.error)}`);
  }
  return parsed.data;
};

/**
 * One rendering of an unknown thrown value, for the boundary's log line.
 *
 * `unknown` is the honest parameter type — JavaScript allows throwing anything,
 * and a thrown string is precisely the case where a naive `.message` would log
 * `undefined` and lose the incident. `apps/ingestion` carries the same rendering
 * in its own module: apps never import from apps (`architecture.md` rule 1), and
 * promoting a five-line log helper into a shared package is a decision worth
 * making on purpose rather than as a side effect of this chunk.
 */
const describeThrown = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : `non-Error thrown (${typeof error})`;

/**
 * The production log sink: one JSON object per line, which is what makes
 * CloudWatch Logs Insights able to query these entries by field rather than by
 * substring. `console.log` is correct *here* and nowhere else — this module is
 * the process boundary `docs/standards/error-handling.md` rule 4 reserves it for.
 */
const jsonLineLog = (entry: Record<string, unknown>): void => {
  console.log(JSON.stringify(entry));
};

const env = parseApiEnv(process.env);

/**
 * One document client for every adapter: a shared connection pool, and one place
 * the storage failure policy (attempt budget, backoff) is set — `@cumulo/storage`
 * owns both.
 */
const documentClient = createStorageDocumentClient();

const sites = new SiteAdapter({
  client: documentClient,
  tableName: storageTableName('sites', env.CUMULO_ENV),
});

/**
 * The API's clock, as a dependency rather than a `new Date()` inside a handler.
 *
 * Fixed-width to the second, because ADR 0002's range queries rely on
 * lexicographic order being chronological and `toISOString()`'s milliseconds
 * break that. Parsed through the schema rather than asserted, so the normalizing
 * regex and the brand can never disagree.
 */
const now = (): UtcIsoTimestamp =>
  utcIsoTimestampSchema.parse(new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'));

const newSiteId = (): string => randomUUID();

const createSiteDeps: CreateSiteDeps = { sites, now, newSiteId };

/**
 * The route table. Order is match order; no two patterns here overlap.
 *
 * The adapter is passed whole rather than as `sites.listFleetSites`: it holds
 * its client and table name on `this`, so a detached method would arrive at a
 * handler already broken. The `Pick<SiteAdapter, …>` in each handler's deps type
 * does the narrowing instead — free at runtime, and it cannot lose a binding.
 */
export const routes: readonly Route[] = [
  { method: 'GET', segments: ['v1', 'sites'], handle: () => listSites({ sites }) },
  // No site-cap check here, deliberately. The cap counter transaction, per-IP
  // limiting, eviction and auto-block are #29's scope; #14's cost guard on this
  // unauthenticated write is the API Gateway stage throttle (10 rps / burst 20)
  // configured in `infra/api`. A cap enforced here without #29's counter would
  // be a race, not a guard.
  {
    method: 'POST',
    segments: ['v1', 'sites'],
    handle: (request) => createSite(createSiteDeps, request),
  },
  {
    method: 'GET',
    segments: ['v1', 'sites', { param: siteIdParamName }],
    handle: (request) => getSite({ sites }, request),
  },
  {
    method: 'PUT',
    segments: ['v1', 'sites', { param: siteIdParamName }],
    handle: (request) => updateSite({ sites }, request),
  },
  {
    method: 'DELETE',
    segments: ['v1', 'sites', { param: siteIdParamName }],
    handle: (request) => deleteSite({ sites }, request),
  },
];

/** Emitted when a request reached the boundary as a throw rather than a response. */
export const apiRequestFailedEvent = 'api.request.failed';

export interface ApiBoundaryDeps {
  readonly routes: readonly Route[];
  /**
   * Structured-logging sink (`docs/standards/error-handling.md` rule 4).
   * Injected rather than called directly so this function stays testable and so
   * the test reads the entry a reviewer would read in CloudWatch.
   */
  readonly log: (entry: Record<string, unknown>) => void;
}

/**
 * The top-level error boundary: the one `catch` in this service that is allowed
 * to end a failure rather than convert or rethrow it
 * (`docs/standards/error-handling.md` rule 2c).
 *
 * Everything a route can *predict* — an unknown id, an invalid body, an
 * unmatched path — is already a response by the time it reaches here. So an
 * exception at this point means something nobody predicted: a DynamoDB failure
 * the adapter wrapped, a response that failed its own schema, an event that was
 * not a gateway event. Each is a 500, and each returns a **resolved** promise:
 * a rejected one is an unhandled Lambda error, which the gateway renders as its
 * own HTML-ish 502 and which no client can parse as an `apiErrorSchema` body.
 *
 * The caller gets a generic message; the detail goes to the log. That split is
 * the point — a `StorageError` states its table and operation, and neither is
 * something an unauthenticated caller is entitled to. No account id is logged
 * either: `describeThrown` renders name and message only, never a stack or an
 * SDK response object, both of which can carry an ARN.
 */
export const handleApiEvent = async (
  deps: ApiBoundaryDeps,
  event: unknown,
): Promise<ApiResponse> => {
  try {
    return await routeRequest(deps.routes, parseGatewayEvent(event));
  } catch (error: unknown) {
    deps.log({ event: apiRequestFailedEvent, detail: describeThrown(error) });
    return errorResponse('internal', 'the request could not be completed');
  }
};

/**
 * The Lambda entry point. `dist/main.mjs` is the bundle and `main.handler` is
 * the handler string the API's Terraform configures.
 */
export const handler = (event: unknown): Promise<ApiResponse> =>
  handleApiEvent({ routes, log: jsonLineLog }, event);
