import type { CreateSiteInput, Forecast, GenerationReading, Site } from '@cumulo/shared';

/**
 * Why the fleet could not answer, from the client's point of view.
 *
 * Deliberately the *client's* view rather than a transport code: the whole
 * point of the union is that each arm implies a different recourse, and two
 * transports that imply the same recourse are the same arm here.
 *
 * - `network` — the request never produced an answer (offline, DNS, timeout).
 *   Retryable as-is.
 * - `rate-limited` — the answer was "not now", with `retryAfterSeconds` when
 *   the server said how long. Back off; never hot-retry (`error-handling.md`
 *   rule 3, and the Open-Meteo budget in CLAUDE.md upstream of it).
 * - `not-found` — the entity does not exist *yet*. For a forecast this is the
 *   ordinary state of a site created seconds ago, not a fault, which is why
 *   the first-forecast poll treats it as "keep waiting".
 * - `invalid-response` — the payload could not be reconciled with the domain
 *   schemas, or the server refused the payload we sent. Both mean "the data on
 *   the wire is wrong", and in both cases repeating the identical request is
 *   pointless — so they share an arm rather than splitting one that no caller
 *   would branch on differently.
 */
export interface FleetDataError {
  readonly code: 'network' | 'rate-limited' | 'not-found' | 'invalid-response';
  /** Human-readable, and carrying the entity it is about (`error-handling.md` rule 4). */
  readonly message: string;
  /** Present only when the server stated a wait; absent is not "zero seconds". */
  readonly retryAfterSeconds?: number;
}

/**
 * The outcome of one fleet request.
 *
 * Every failure this interface models is *expected* — a site that does not
 * exist, a budget that is spent, a network that is down — so it arrives as a
 * value the caller must destructure rather than as a `throw` the caller can
 * forget to catch (`error-handling.md` rule 1). A rejected promise from any
 * implementation of `FleetDataSource` is therefore a bug in that
 * implementation, not a failure mode callers are expected to handle.
 *
 * This is the app's *only* fleet result type. `apps/web` briefly carried a
 * second one, whose failure arm was a bare `string`, because the chart views and
 * the map dashboard were built in parallel against read surfaces that never met
 * (#105). The typed union won that decision: a string cannot say "not yet"
 * versus "not now", and those are exactly the two answers the first-forecast
 * poll has to tell apart.
 */
export type FleetSourceResult<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'error'; readonly error: FleetDataError };

/**
 * The look-back windows the chart views offer, as whole hours: 24 h, 48 h, 7 d.
 *
 * A closed union rather than `number`: a source must be able to serve every
 * value, and adding a window should fail to compile everywhere it is switched
 * on rather than silently return nothing.
 */
export type RangeHours = 24 | 48 | 168;

/**
 * Everything `apps/web` needs from the fleet, with no commitment to where the
 * fleet lives.
 *
 * Every view talks to this interface and nothing else, so the same components
 * run against deterministic fixtures today and the Fleet API (#14) later with
 * no change above this line. Two implementations exist by design:
 * `DemoFleetDataSource` (deterministic, in-memory, what local development and
 * the whole test suite run against) and the HTTP source that talks to the
 * deployed API. The second one is not built here — this interface is the
 * contract it will have to satisfy.
 *
 * ## Members are function-typed properties, not method signatures
 *
 * Callers pass `source.listSites` straight into a hook, and a detached method
 * would lose its `this` (`@typescript-eslint/unbound-method`, which is an error
 * here). Arrow-typed properties make detaching safe by construction, so every
 * implementation must define its members as bound properties too rather than as
 * prototype methods.
 *
 * ## What a transport maps onto `FleetDataError`
 *
 * The Fleet API answers failures with `apiErrorSchema` bodies from
 * `@cumulo/shared` — `validation_failed` (400), `not_found` (404), `internal`
 * (500) — plus gateway-generated 429s, which are produced by API Gateway's
 * stage throttle before the Lambda runs and therefore carry the gateway's own
 * body rather than an `apiErrorSchema` one. The HTTP source consequently maps
 * on **status**, the one part of the contract every arm is reachable from:
 *
 * - **404** (`not_found`) → `not-found`. Covers an unknown site *and* a site
 *   whose first forecast does not exist yet; the poll treats both as "wait".
 * - **429** (gateway throttle) → `rate-limited`, with `retryAfterSeconds` taken
 *   from the `Retry-After` header when the response carries one and left absent
 *   when it does not — absent means "no stated wait", not zero.
 * - **400** (`validation_failed`), or a 2xx body that fails its zod parse →
 *   `invalid-response`. Both mean the bytes on the wire cannot be believed, and
 *   neither is worth repeating unchanged.
 * - **5xx** (`internal`), or a `fetch` that rejects → `network`. Retryable as
 *   is, on a backoff.
 *
 * A 200 carrying an empty series is **not** an error: the API answers a
 * forecast-less site with `200 []`, and that is `{ kind: 'ok', value: [] }`
 * here. Callers that need "nothing yet" as a distinct state derive it from the
 * empty array, which is what `useFirstForecast` does.
 */
export interface FleetDataSource {
  /**
   * The whole fleet, once. Callers load this on mount and never poll it: a
   * repeated fan-out across every site's partition is the read-capacity
   * mistake ADR 0002's review called out (a per-site forecast poll costs
   * ~0.5 read units; the fleet fan-out costs ~25).
   */
  readonly listSites: () => Promise<FleetSourceResult<readonly Site[]>>;

  /**
   * Adds a site to the fleet.
   *
   * The returned `Site` carries the **server-assigned id**, and that returned
   * value is the only legitimate source of it. Callers must not predict an id
   * locally: a locally minted id can collide with, or shadow, a real one, and
   * every subsequent call keyed on it (forecast polling above all) then
   * addresses a site that does not exist.
   */
  readonly createSite: (input: CreateSiteInput) => Promise<FleetSourceResult<Site>>;

  /**
   * The forecast series for one site as it stands *now* — one partition, never
   * the fleet, and no window to choose.
   *
   * This is the poll's call (`GET /v1/sites/{siteId}/forecast`): it asks "does
   * this site have a forecast yet", so it takes no range and its answer is
   * whatever the pipeline has produced. `not-found` and an empty series are
   * both the normal answer for a site created seconds ago, so a caller polling
   * for the first forecast treats either as "keep waiting".
   */
  readonly getSiteForecast: (siteId: Site['id']) => Promise<FleetSourceResult<readonly Forecast[]>>;

  /**
   * One site's forecast over a chosen window (`GET /v1/sites/{siteId}/series`).
   *
   * Distinct from {@link getSiteForecast} because the question is different:
   * this one is the chart's, spanning `range` hours of history plus the
   * horizon, and it is answered even when the poll's question ("is there
   * anything yet?") has stopped being interesting.
   */
  readonly siteForecasts: (
    siteId: Site['id'],
    range: RangeHours,
  ) => Promise<FleetSourceResult<readonly Forecast[]>>;

  /** One site's measured generation over the same window, for the same chart. */
  readonly siteActuals: (
    siteId: Site['id'],
    range: RangeHours,
  ) => Promise<FleetSourceResult<readonly GenerationReading[]>>;

  /**
   * Every site's forecast over the window, unaggregated.
   *
   * The summing belongs to `@cumulo/shared`'s aggregation (`architecture.md`
   * rule 3), so this returns the raw series and the view aggregates. Until the
   * API grows a fleet-level endpoint this is a client-side fan-out — noted as
   * out of scope on #14 rather than hidden here.
   */
  readonly fleetForecasts: (range: RangeHours) => Promise<FleetSourceResult<readonly Forecast[]>>;

  /** Every site's measured generation over the window, unaggregated. */
  readonly fleetActuals: (
    range: RangeHours,
  ) => Promise<FleetSourceResult<readonly GenerationReading[]>>;
}
