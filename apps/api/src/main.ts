import { randomUUID } from 'node:crypto';

import { utcIsoTimestampSchema, type UtcIsoTimestamp } from '@cumulo/shared';
import {
  AbuseAdapter,
  SeriesAdapter,
  SiteAdapter,
  createStorageDocumentClient,
  storageTableName,
} from '@cumulo/storage';
import { z } from 'zod';

import { IpLimiter } from './abuse/ip-limiter';
import { checkWriteOrigin } from './abuse/origin-check';
import { getSiteForecast } from './forecast/get-site-forecast';
import { getSiteSeries } from './forecast/get-site-series';
import { parseGatewayEvent } from './http/gateway-event';
import {
  describeZodIssues,
  errorResponse,
  rateLimitedResponse,
  type ApiResponse,
} from './http/response';
import { routeRequest, type Route, type RouteRequest } from './http/router';
import { docsAssetParamName } from './openapi/docs-assets';
import { docsPageResponse, serveDocsAsset, type DocsAssetDeps } from './openapi/docs-page';
import { openApiDocumentResponse } from './openapi/document';
import { createSite, type CreateSiteDeps } from './sites/create-site';
import { deleteSite, type DeleteSiteDeps } from './sites/delete-site';
import { getSite } from './sites/get-site';
import { listSites } from './sites/list-sites';
import { siteIdParamName } from './sites/site-id-param';
import { updateSite } from './sites/update-site';
import { describeThrown } from './thrown-detail';

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
 *
 * `CUMULO_WEB_ORIGINS` is optional because the deployment that has no browser
 * front-end yet is a valid deployment: the API's own origin is always allowed
 * (it is where `/docs` is served from), and this variable only ever *adds*.
 * `infra/api/variables.tf` defaults it to the empty string, which parses to no
 * extra origins rather than to a misconfiguration.
 */
export const apiEnvSchema = z.object({
  CUMULO_ENV: z.string().min(1),
  CUMULO_WEB_ORIGINS: z.string().optional(),
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
 * The `cumulo-series` adapter: `querySeriesRange` for the two read routes, and
 * `deleteSiteSeries` for the cleanup that follows a deleted or evicted site.
 *
 * Nothing here *writes* a series point — forecasts are #12's and actuals are
 * #16's — so the IAM policy this function runs under grants Query, DeleteItem
 * and BatchWriteItem on this table and neither PutItem nor UpdateItem
 * (`infra/api/iam.tf`). The `Pick<SeriesAdapter, …>` in each handler's deps type
 * is the compile-time half of the same statement.
 */
const series = new SeriesAdapter({
  client: documentClient,
  tableName: storageTableName('series', env.CUMULO_ENV),
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

/**
 * The real timer, for the write routes' backoff between contended transaction
 * attempts (`sites/conflict-retry.ts` owns the curve; this is only the clock it
 * runs on). A dependency rather than a `setTimeout` inside the loop, so those
 * routes' tests observe the delays without waiting them out.
 */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * The `cumulo-abuse` table's adapter and the limiter over it, built once per
 * container so the limiter's block cache survives between invocations — which
 * is the whole reason a repeat offender costs nothing to refuse
 * (`abuse/ip-limiter.ts`).
 */
const abuse = new AbuseAdapter({
  client: documentClient,
  tableName: storageTableName('abuse', env.CUMULO_ENV),
});

const limiter = new IpLimiter({
  abuse,
  nowEpochSeconds: () => Math.floor(Date.now() / 1000),
});

/**
 * The browser origins allowed on write routes *in addition to* the API's own.
 *
 * Comma-separated, trimmed, empties dropped — so `""`, `" "` and an unset
 * variable all mean the same thing, and a trailing comma in a Terraform-built
 * string is not a silently-allowed empty origin. Exported for its test: the
 * behaviour worth pinning is that the sloppy spellings collapse rather than
 * producing an origin no browser will ever send.
 */
export const parseWebOrigins = (value: string | undefined): readonly string[] =>
  value === undefined
    ? []
    : value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin !== '');

const webOrigins = parseWebOrigins(env.CUMULO_WEB_ORIGINS);

/**
 * The per-IP limiter in front of one route (ADR 0006 layer 1).
 *
 * Applied per route rather than as a blanket middleware, because *which* routes
 * are limited is a deliberate list and not a default. The three writes and the
 * span-capped series read are limited: each one either changes state or reads a
 * range whose cost a caller chooses. `GET /v1/sites`, `GET …/forecast`,
 * `/openapi.json` and the two `/docs` routes are not: they are the pages a
 * reviewer clicks through, their cost per request is fixed and small, and the
 * stage throttle already bounds them. A limiter that made reading the docs
 * spend abuse-table writes would be paying to defend the cheapest thing here.
 */
const rateLimited = async (
  request: RouteRequest,
  handle: () => Promise<ApiResponse>,
): Promise<ApiResponse> => {
  const decision = await limiter.check(request.sourceIp);
  return decision.allowed ? handle() : rateLimitedResponse(decision.retryAfterSeconds);
};

/**
 * A write route: the origin check first, then the limiter, then the handler.
 *
 * Origin first because it is free — no I/O, no abuse-table write — so a
 * drive-by script that sends no `Origin` is refused without spending anything.
 * Defined in terms of {@link rateLimited} rather than beside it so that the two
 * cannot disagree about what limiting means.
 *
 * `request.ownOrigin` is derived per request from the gateway's `domainName`,
 * so nothing here hard-codes a hostname the stack assigns at create time — and
 * Swagger UI's "try it out", served from this same origin, passes by
 * construction.
 */
const guardedWrite = (
  request: RouteRequest,
  handle: () => Promise<ApiResponse>,
): Promise<ApiResponse> => {
  if (!checkWriteOrigin([request.ownOrigin, ...webOrigins], request.originHeader)) {
    return Promise.resolve(
      errorResponse(
        'forbidden',
        "requests to this endpoint must send an allowed Origin header — see the README's abuse-protection section",
      ),
    );
  }

  return rateLimited(request, handle);
};

/**
 * The two handlers that change the fleet's size, and so the two that need the
 * counter, the eviction index, the series cleanup and a log sink. Named
 * constants rather than object literals in the route table below: both are
 * built once per container, and a reader looking for what a write route can
 * reach finds it here rather than inline among ten routes.
 */
const createSiteDeps: CreateSiteDeps = {
  sites,
  series,
  now,
  newSiteId,
  log: jsonLineLog,
  sleep,
  random: Math.random,
};

const deleteSiteDeps: DeleteSiteDeps = { sites, series, log: jsonLineLog };

/**
 * Where the bundled Swagger UI assets are, decided here because it is a fact
 * about the *artifact* rather than about the code that reads them.
 *
 * `import.meta.url` is `dist/main.mjs` in Lambda, so this resolves to
 * `dist/swagger/` — the directory `scripts/copy-swagger-assets.mjs` fills from
 * the pinned `swagger-ui-dist` package and `handler.zip` ships alongside the
 * bundle. The trailing slash is load-bearing: `new URL('swagger-ui.css', …)`
 * resolves inside the directory only if the base names one.
 */
const docsAssetDeps: DocsAssetDeps = { assetDirectory: new URL('./swagger/', import.meta.url) };

/**
 * The route table. Order is match order; no two patterns here overlap.
 *
 * The adapter is passed whole rather than as `sites.listFleetSites`: it holds
 * its client and table name on `this`, so a detached method would arrive at a
 * handler already broken. The `Pick<SiteAdapter, …>` in each handler's deps type
 * does the narrowing instead — free at runtime, and it cannot lose a binding.
 *
 * The `guardedWrite`/`rateLimited` wrappers are the abuse protections, and this
 * table is the only place that says which routes carry them. Reading down the
 * `handle` column is how a reviewer answers "what is limited?" — the four
 * wrapped routes and no others. The route keys the gateway throttles separately
 * (`infra/api/gateway.tf`, ADR 0006 layer 2) are the three `guardedWrite` ones,
 * and those two lists have to be edited together.
 */
export const routes: readonly Route[] = [
  { method: 'GET', segments: ['v1', 'sites'], handle: () => listSites({ sites }) },
  {
    method: 'POST',
    segments: ['v1', 'sites'],
    handle: (request) => guardedWrite(request, () => createSite(createSiteDeps, request)),
  },
  {
    method: 'GET',
    segments: ['v1', 'sites', { param: siteIdParamName }],
    handle: (request) => getSite({ sites }, request),
  },
  {
    method: 'PUT',
    segments: ['v1', 'sites', { param: siteIdParamName }],
    handle: (request) => guardedWrite(request, () => updateSite({ sites }, request)),
  },
  {
    method: 'DELETE',
    segments: ['v1', 'sites', { param: siteIdParamName }],
    handle: (request) => guardedWrite(request, () => deleteSite(deleteSiteDeps, request)),
  },
  // The two series reads. Four segments each, so neither can shadow — or be
  // shadowed by — `GET /v1/sites/{siteId}` above, which matches three.
  {
    method: 'GET',
    segments: ['v1', 'sites', { param: siteIdParamName }, 'forecast'],
    handle: (request) => getSiteForecast({ sites, series, now }, request),
  },
  {
    method: 'GET',
    segments: ['v1', 'sites', { param: siteIdParamName }, 'series'],
    // The one limited read: `from`/`to` let a caller choose how much of a
    // partition to read (up to `MAX_SERIES_SPAN_HOURS`), so its cost per
    // request is the caller's to pick. No origin check — reads are not writes,
    // and the web app must be able to plot a site from wherever it is served.
    handle: (request) => rateLimited(request, () => getSiteSeries({ sites, series }, request)),
  },
  // The self-documenting half of the API (ADR 0005): the document, the page
  // that renders it, and the page's assets, all from this function and this
  // origin. Same origin is what lets Swagger UI's "try it out" call the routes
  // above with no CORS negotiation, and one artifact is what stops a deploy
  // from publishing a document for an API that is not running yet.
  {
    method: 'GET',
    segments: ['openapi.json'],
    handle: () => Promise.resolve(openApiDocumentResponse()),
  },
  { method: 'GET', segments: ['docs'], handle: () => Promise.resolve(docsPageResponse()) },
  {
    method: 'GET',
    segments: ['docs', { param: docsAssetParamName }],
    handle: (request) => serveDocsAsset(docsAssetDeps, request),
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
