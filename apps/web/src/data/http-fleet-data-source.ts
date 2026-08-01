import {
  fleetSiteSchema,
  listSitesResponseSchema,
  siteForecastResponseSchema,
  siteSeriesResponseSchema,
  utcIsoTimestampSchema,
  type CreateSiteInput,
  type Forecast,
  type GenerationReading,
  type Site,
  type SiteSeriesResponse,
} from '@cumulo/shared';
import type { ZodType } from 'zod';

import { parseFleetApiResponse, thrownToNetworkFailure } from './fleet-api-result';
import type {
  FleetDataError,
  FleetDataSource,
  FleetSourceResult,
  RangeHours,
} from './fleet-data-source';
import { pacedMap } from './request-pacing';

const MS_PER_HOUR = 3_600_000;

/**
 * How far forward the chart windows read.
 *
 * The `/series` route takes an explicit `from`/`to`, so the forward edge is
 * this client's to choose, and it is chosen to match the forecast horizon the
 * API serves by default (`DEFAULT_FORECAST_HORIZON_HOURS` in
 * `apps/api/src/forecast/get-site-forecast.ts` — cited rather than imported,
 * because `apps/web` may not import another app, `architecture.md` rule 1).
 * Asking for less would crop the forecast half of an accuracy chart; asking for
 * more would spend a read on rows that cannot exist yet.
 *
 * The widest window this produces is 168 + 48 = 216 hours, comfortably inside
 * the route's `MAX_SERIES_SPAN_HOURS` of 336 — so widening `RangeHours` has
 * headroom before it starts 400ing.
 */
const SERIES_HORIZON_HOURS = 48;

/**
 * How many per-site forecast requests the fleet fan-out launches per second.
 *
 * `infra/api/gateway.tf`'s `default_route_settings` throttles the whole stage
 * at 10 requests/second sustained (20 burst), and that ceiling is *shared* —
 * every visitor's dashboard, the Swagger page, and this fan-out all draw on the
 * same bucket. 8 keeps a fan-out under the sustained rate with room left for
 * the requests that are not part of it, rather than sitting exactly on a limit
 * whose other consumers this app cannot see.
 *
 * This is deliberately **not** a declared infra mirror
 * (`architecture.md` rule 8). `throttling_rate_limit` lives inside the stage's
 * `default_route_settings` sub-block, and `check-infra-mirrors.sh` reads only
 * attributes indented directly inside a `resource` block — it refuses a nested
 * one outright (exit 2, "declares no top-level attribute"), verified by running
 * the gate against this pair. So the citation above is the enforcement, and the
 * gate's limitation is recorded in `docs/tech-debt.md`.
 *
 * The routes this fans out over — `GET /v1/sites` and `GET …/forecast` — are
 * **not** metered by the API's per-IP limiter (the route table in
 * `apps/api/src/main.ts` wraps only the three writes and `GET …/series`), so
 * even a 60-site fleet cannot trip the limiter's 30-requests-per-60-seconds
 * auto-block. A fan-out over `/series` would: 60 > 30, and the visitor would be
 * blocked for an hour by loading the dashboard once. That is why the fleet view
 * reads `/forecast` per site and why it must never be re-pointed at `/series`.
 */
const FLEET_FANOUT_LAUNCHES_PER_SECOND = 8;

/** GET carries no body and no headers of its own; shared so it is written once. */
const GET_INIT: RequestInit = { method: 'GET' };

/**
 * An instant as `utcIsoTimestampSchema` accepts it — fixed-width UTC to the
 * second, which `toISOString()` alone is not (it always emits milliseconds).
 *
 * The same three lines exist in `demo-fleet-data-source.ts`, and the
 * duplication is incidental (`structure.md` rule 7): that one formats instants
 * it invented for a fixture, this one formats query parameters a server will
 * validate. Neither becomes wrong because the other changed.
 *
 * Parsed rather than asserted, so a clock that produced something unformattable
 * fails here — a bug — instead of becoming a 400 the user sees.
 */
const utcSecondIso = (epochMs: number): string =>
  utcIsoTimestampSchema.parse(`${new Date(epochMs).toISOString().slice(0, 19)}Z`);

/**
 * Project the success arm and leave the failure arm exactly as it is.
 *
 * Every read route answers with an envelope — `{ sites }`, `{ forecasts,
 * attribution }` — and every caller here wants the array inside it, so the
 * unwrapping is one function rather than four `kind === 'ok'` ternaries that
 * could each get the error arm subtly wrong.
 */
const mapOk = <T, R>(
  result: FleetSourceResult<T>,
  project: (value: T) => R,
): FleetSourceResult<R> =>
  result.kind === 'ok' ? { kind: 'ok', value: project(result.value) } : result;

/**
 * The fleet fan-out's result policy: partial beats nothing.
 *
 * If any site answered, the union of what answered is returned as `ok` — the
 * aggregate view labels an incomplete fleet as partial rather than pretending
 * completeness (`error-handling.md` rule 5), and a fleet where one site's
 * partition is briefly unreadable is still worth drawing. Only a fan-out where
 * *every* site failed is an error, and it reports the first one because that is
 * the failure the retry advice should be about; a list of sixty identical
 * `network` errors tells a reader nothing the first one did not.
 *
 * An empty fleet is `ok` with nothing in it: no site failed, there were none.
 */
const combineFanOut = (
  results: readonly FleetSourceResult<readonly Forecast[]>[],
): FleetSourceResult<readonly Forecast[]> => {
  const forecasts: Forecast[] = [];
  let succeeded = false;
  let firstError: FleetDataError | undefined;

  for (const result of results) {
    if (result.kind === 'ok') {
      succeeded = true;
      forecasts.push(...result.value);
    } else {
      firstError ??= result.error;
    }
  }

  return firstError === undefined || succeeded
    ? { kind: 'ok', value: forecasts }
    : { kind: 'error', error: firstError };
};

export interface HttpFleetDataSourceOptions {
  /** Where the Fleet API is. A trailing slash is tolerated and dropped. */
  readonly baseUrl: string;
  /** Injected transport. Tests supply one; the browser's `fetch` is the default. */
  readonly fetchFn?: typeof fetch;
  /** Injected clock, so a test asserts on the window it chose. */
  readonly now?: () => number;
}

/**
 * The `FleetDataSource` that talks to the deployed Fleet API.
 *
 * A class rather than a factory over captured variables (`structure.md`
 * rule 2): the members share the base URL, the transport, the clock and — the
 * one that matters — the in-flight series map, and `this.` is what makes that
 * sharing visible to a reader holding only one method.
 *
 * Members are arrow properties because `FleetDataSource` declares them as
 * properties: views hand `source.listSites` straight to a hook, and a detached
 * prototype method would arrive there with no `this` and no base URL.
 */
export class HttpFleetDataSource implements FleetDataSource {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  /**
   * `${siteId}|${range}` → the series request currently in flight for it.
   *
   * The detail view asks for that pair's forecasts and actuals concurrently,
   * and both are halves of one `/series` payload. `/series` is the one read the
   * API's per-IP limiter meters (30 requests per 60 seconds, then a one-hour
   * block), so sharing the promise is the difference between one metered
   * request per selection and two. Even unshared this is far from the limiter —
   * a human would need more than 30 distinct (site, range) selections inside a
   * minute — but the halving is free and it is the frugality posture CLAUDE.md
   * asks for.
   */
  private readonly seriesInFlight = new Map<
    string,
    Promise<FleetSourceResult<SiteSeriesResponse>>
  >();

  constructor(options: HttpFleetDataSourceOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    // Wrapped rather than passed as `globalThis.fetch`: a detached `fetch` loses
    // its `this` in a browser and throws an illegal-invocation TypeError.
    this.fetchFn = options.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * One request, as a result.
   *
   * The `try` wraps the `fetch` and nothing else: a rejection from the
   * transport is the expected `network` failure, while anything thrown by the
   * parsing below it would be a bug in this app and must not be dressed up as a
   * network problem (`error-handling.md` rules 1 and 2).
   */
  private readonly requestJson = async <T>(
    operation: string,
    url: string,
    schema: ZodType<T>,
    init: RequestInit,
  ): Promise<FleetSourceResult<T>> => {
    let response: Response;
    try {
      response = await this.fetchFn(url, init);
    } catch (thrown: unknown) {
      return thrownToNetworkFailure(operation, thrown);
    }
    return parseFleetApiResponse(operation, schema, response);
  };

  /** `encodeURIComponent` because a site id reaches here from a URL or a server response. */
  private readonly siteUrl = (siteId: string): string =>
    `${this.baseUrl}/v1/sites/${encodeURIComponent(siteId)}`;

  private readonly fetchSeries = async (
    key: string,
    siteId: string,
    range: RangeHours,
  ): Promise<FleetSourceResult<SiteSeriesResponse>> => {
    const nowMs = this.now();
    const window = new URLSearchParams({
      from: utcSecondIso(nowMs - range * MS_PER_HOUR),
      to: utcSecondIso(nowMs + SERIES_HORIZON_HOURS * MS_PER_HOUR),
    });

    try {
      return await this.requestJson(
        `siteSeries (site ${siteId}, ${String(range)}h)`,
        `${this.siteUrl(siteId)}/series?${window.toString()}`,
        siteSeriesResponseSchema,
        GET_INIT,
      );
    } finally {
      // Settled, so the next selection of this pair is a fresh read rather than
      // a cached one — this shares a request, it does not cache a response.
      this.seriesInFlight.delete(key);
    }
  };

  private readonly seriesFor = (
    siteId: string,
    range: RangeHours,
  ): Promise<FleetSourceResult<SiteSeriesResponse>> => {
    const key = `${siteId}|${String(range)}`;
    const inFlight = this.seriesInFlight.get(key);
    if (inFlight !== undefined) {
      return inFlight;
    }

    const request = this.fetchSeries(key, siteId, range);
    this.seriesInFlight.set(key, request);
    return request;
  };

  readonly listSites = async (): Promise<FleetSourceResult<readonly Site[]>> =>
    mapOk(
      await this.requestJson(
        'listSites',
        `${this.baseUrl}/v1/sites`,
        listSitesResponseSchema,
        GET_INIT,
      ),
      (payload) => payload.sites,
    );

  readonly createSite = (input: CreateSiteInput): Promise<FleetSourceResult<Site>> =>
    this.requestJson(`createSite (${input.name})`, `${this.baseUrl}/v1/sites`, fleetSiteSchema, {
      method: 'POST',
      // Required rather than tidy: `application/json` is not a CORS-safelisted
      // Content-Type, and the gateway's `allow_headers` lists it for this reason.
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });

  /**
   * No `hours` parameter: the API's own default is 48, and restating it here
   * would be a second definition of the poll's horizon that could drift from
   * the published contract.
   */
  readonly getSiteForecast = async (
    siteId: Site['id'],
  ): Promise<FleetSourceResult<readonly Forecast[]>> =>
    mapOk(
      await this.requestJson(
        `getSiteForecast (site ${siteId})`,
        `${this.siteUrl(siteId)}/forecast`,
        siteForecastResponseSchema,
        GET_INIT,
      ),
      (payload) => payload.forecasts,
    );

  readonly siteForecasts = async (
    siteId: Site['id'],
    range: RangeHours,
  ): Promise<FleetSourceResult<readonly Forecast[]>> =>
    mapOk(await this.seriesFor(siteId, range), (payload) => payload.forecasts);

  readonly siteActuals = async (
    siteId: Site['id'],
    range: RangeHours,
  ): Promise<FleetSourceResult<readonly GenerationReading[]>> =>
    mapOk(await this.seriesFor(siteId, range), (payload) => payload.actuals);

  readonly fleetForecasts = async (
    range: RangeHours,
  ): Promise<FleetSourceResult<readonly Forecast[]>> => {
    // The fan-out owns its own site list rather than taking one: a caller
    // holding a stale list would silently fan out over sites that no longer
    // exist, and a fleet-wide 404 is not what "the fleet failed" should mean.
    const sites = await this.listSites();
    if (sites.kind === 'error') {
      return sites;
    }

    const perSite = await pacedMap(
      sites.value,
      async (site) =>
        mapOk(
          await this.requestJson(
            `fleetForecasts (site ${site.id}, ${String(range)}h)`,
            `${this.siteUrl(site.id)}/forecast?hours=${String(range)}`,
            siteForecastResponseSchema,
            GET_INIT,
          ),
          (payload) => payload.forecasts,
        ),
      { launchesPerSecond: FLEET_FANOUT_LAUNCHES_PER_SECOND },
    );

    return combineFanOut(perSite);
  };

  /**
   * Always empty, and deliberately without a request.
   *
   * Nothing in the deployed pipeline writes generation readings — the API's
   * IAM policy does not even grant `PutItem` on `cumulo-series` — so every
   * site's actuals are `[]` today. Fanning out to discover that would spend
   * one metered `/series` request per site (the only route that carries
   * actuals) to learn nothing, and on a 60-site fleet that alone would trip the
   * per-IP limiter's 30-per-60-seconds block.
   *
   * Typed as the interface's member and implemented with no parameter at all:
   * callers still pass a range (the contract is unchanged), and the body has no
   * ignored binding to explain away. The window cannot matter when there is
   * nothing to window.
   */
  readonly fleetActuals: FleetDataSource['fleetActuals'] = () =>
    Promise.resolve({ kind: 'ok', value: [] });
}
