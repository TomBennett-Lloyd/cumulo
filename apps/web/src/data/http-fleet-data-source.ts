import {
  fleetActualsResponseSchema,
  fleetForecastResponseSchema,
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
  FleetDataSource,
  FleetSourceCapabilities,
  FleetSourceResult,
  RangeHours,
} from './fleet-data-source';

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
 * unwrapping is one function rather than a `kind === 'ok'` ternary at every
 * call site, each free to get the error arm subtly wrong. Deliberately without
 * a count of those sites: the set moves whenever a route does — #296 changed it
 * — and a literal count in prose goes stale the moment one is added.
 */
const mapOk = <T, R>(
  result: FleetSourceResult<T>,
  project: (value: T) => R,
): FleetSourceResult<R> =>
  result.kind === 'ok' ? { kind: 'ok', value: project(result.value) } : result;

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
   * and both are halves of one `/series` payload. `/series` is metered by the
   * API's per-IP limiter (30 requests per 60 seconds, then a one-hour block;
   * the route table in `apps/api/src/main.ts` owns which routes are), so
   * sharing the promise is the difference between one metered request per
   * selection and two. Even unshared this is far from the limiter — a human
   * would need more than 30 distinct (site, range) selections inside a minute —
   * but the halving is free and it is the frugality posture CLAUDE.md asks for.
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

  /**
   * One `/series` read. Knows nothing about the in-flight map — the sharing is
   * {@link seriesFor}'s, and so is the bookkeeping that goes with it.
   */
  private readonly fetchSeries = (
    siteId: string,
    range: RangeHours,
  ): Promise<FleetSourceResult<SiteSeriesResponse>> => {
    const nowMs = this.now();
    const window = new URLSearchParams({
      from: utcSecondIso(nowMs - range * MS_PER_HOUR),
      to: utcSecondIso(nowMs + SERIES_HORIZON_HOURS * MS_PER_HOUR),
    });

    return this.requestJson(
      `siteSeries (site ${siteId}, ${String(range)}h)`,
      `${this.siteUrl(siteId)}/series?${window.toString()}`,
      siteSeriesResponseSchema,
      GET_INIT,
    );
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

    /*
     * The entry is cleared by a `.finally` *here*, not by a `finally` block
     * inside the request — and that difference is the whole bug this shape
     * exists to avoid.
     *
     * Building the window can fail before any request is made: a clock that
     * returned a non-finite instant makes `toISOString` throw `RangeError`, and
     * `utcSecondIso` parses rather than asserts, so a malformed instant throws
     * `ZodError`. Both are bugs and correctly throw (`error-handling.md`
     * rule 1) — but both happen before the request exists, which is precisely
     * where an inner `finally` runs too early. It would delete a key the `set`
     * below had not written yet, and the failed promise would then be stored
     * *permanently*: every later read of this (site, range) would be handed the
     * same failure for the life of the page.
     *
     * Cleared from here, neither failure can wedge the map. A synchronous
     * throw never reaches the `set` at all, and a rejection reaches the
     * `.finally` as a microtask — which cannot run before the `set` on the
     * line after it.
     */
    const request = this.fetchSeries(siteId, range).finally(() => {
      // Settled, so the next selection of this pair is a fresh read rather than
      // a cached one — this shares a request, it does not cache a response.
      this.seriesInFlight.delete(key);
    });
    this.seriesInFlight.set(key, request);
    return request;
  };

  /**
   * One false, one true, and the false one is not a shortcut this source could
   * choose to undo. `fleetForecasts` below is one request now rather than a
   * per-site fan-out (#296), and the flag did not move with it: the route it
   * calls reads *forward from now*, so the range it takes is a horizon and
   * there is no look-back for this source to honour however it asks. Closing
   * that needs the fleet *series* endpoint — every site's stored points over an
   * explicit window — which is #289's, on the way to #148. It is not something
   * a different request shape here could reach.
   *
   * What the false one no longer means is "no window control". It used to: a
   * picker here moves the actuals' window and leaves the forecast half roughly
   * where it was, and that asymmetry was once read as a reason to withhold the
   * control. #284 D5 keeps the control and pays for the asymmetry in the copy
   * instead — more measured hours is a real thing to offer a reader, and the
   * chart's own name declines to claim the forecast half moved with them.
   *
   * `fleetActuals` is true because the fleet's readings now both exist and
   * arrive in one request: the forecast service writes them and
   * `GET /v1/fleet/actuals` serves them (#264, see the comment there).
   */
  readonly capabilities: FleetSourceCapabilities = {
    fleetLookback: false,
    fleetActuals: true,
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

  /**
   * The whole fleet's forecasts, in one request — never a fan-out.
   *
   * `GET /v1/fleet/forecast` reads every site's stored points server-side and
   * answers with one payload (#296). What did not change when the fan-out this
   * replaced went away is the *direction*: `range` is still spent as a
   * **forward horizon** rather than as the look-back {@link RangeHours}
   * describes, because the route's window opens at the clock and runs ahead. So
   * the fleet aggregate still shows no history, and it is still capped by how
   * far the deployed pipeline has written. Closing that needs the fleet
   * *series* endpoint, not a change here (#289, #148).
   *
   * That route *is* metered by the API's per-IP limiter, and deliberately so:
   * the caller picks nothing about this request's cost and the fleet picks all
   * of it, which is the pairing with `/v1/fleet/actuals` that the route table in
   * `apps/api/src/main.ts` states. One metered request per range selection is
   * the whole point — the fan-out spent one unmetered request per site plus a
   * listing, and grew with the fleet.
   *
   * **All-or-nothing, and that is a deliberate change of semantics.** The
   * fan-out returned the union of whichever sites answered; one request either
   * answers for the fleet or fails for it, which is the posture `fleetActuals`
   * has always had. There is no partial for this client to label because the
   * route does not serve one: a fleet short of a site's points is summed hour
   * by hour into a fleet that merely looks like it generates less, so the read
   * refuses rather than truncating (`error-handling.md` rule 5). That decision
   * is `apps/api/src/forecast/fleet-series-read.ts`'s and its reasoning lives
   * there; labelling a response partial is the richer answer that module names
   * as still open — the same contract change #165 holds for the per-site
   * routes.
   */
  readonly fleetForecasts = async (
    range: RangeHours,
  ): Promise<FleetSourceResult<readonly Forecast[]>> =>
    mapOk(
      await this.requestJson(
        `fleetForecasts (${String(range)}h)`,
        `${this.baseUrl}/v1/fleet/forecast?hours=${String(range)}`,
        fleetForecastResponseSchema,
        GET_INIT,
      ),
      (payload) => payload.forecasts,
    );

  /**
   * The whole fleet's readings, in one request — never a fan-out.
   *
   * The forecast service's simulated-actuals producer writes generation
   * readings from each site's stored physics forecast (#264), and
   * `GET /v1/fleet/actuals` serves every site's readings over the look-back in
   * a single response. So unlike {@link fleetForecasts} above, this member
   * spends `range` as the look-back {@link RangeHours} describes.
   *
   * That route *is* metered by the API's per-IP limiter, and one request per
   * range selection is the point of it: assembling the same answer in the
   * browser would spend one metered `/series` request per site (the only
   * per-site route that carries actuals), and on a 60-site fleet that alone
   * would trip the limiter's 30-per-60-seconds block. Which is why the fleet's
   * actuals are read here and must never be re-pointed at `/series`.
   */
  readonly fleetActuals = async (
    range: RangeHours,
  ): Promise<FleetSourceResult<readonly GenerationReading[]>> =>
    mapOk(
      await this.requestJson(
        `fleetActuals (${String(range)}h)`,
        `${this.baseUrl}/v1/fleet/actuals?hours=${String(range)}`,
        fleetActualsResponseSchema,
        GET_INIT,
      ),
      (payload) => payload.actuals,
    );
}
