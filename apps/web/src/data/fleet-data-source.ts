import type {
  CreateSiteInput,
  FleetForecastAggregatePoint,
  Forecast,
  GenerationReading,
  Site,
} from '@cumulo/shared';

/**
 * Why the fleet could not answer, from the client's point of view.
 *
 * Deliberately the *client's* view rather than a transport code: the whole
 * point of the union is that each arm implies a different recourse, and two
 * transports that imply the same recourse are the same arm here (#162).
 *
 * A discriminated union rather than one interface with an optional extra, so
 * that `retryAfterSeconds` is representable only on the arm where it means
 * anything (`typing.md` rule 4). Every arm carries a human-readable `message`
 * naming the entity it is about (`error-handling.md` rule 4).
 *
 * - `network` — the request never produced an answer (offline, DNS, timeout).
 *   Retryable as-is.
 * - `rate-limited` — the answer was "not now", with `retryAfterSeconds` when
 *   this client could read a stated wait. Back off; never hot-retry
 *   (`error-handling.md` rule 3).
 * - `not-found` — the entity does not exist *yet*. For a forecast this is the
 *   ordinary state of a site created seconds ago, not a fault, which is why
 *   the first-forecast poll treats it as "keep waiting".
 * - `invalid-response` — server → client: the fleet sent a payload this client
 *   cannot reconcile with the domain schemas. Changing the request cannot
 *   help; *time* can — the same request may parse later, which is why the
 *   first-forecast poll keeps waiting on this arm instead of failing fast.
 * - `invalid-request` — client → server: the fleet refused the payload or
 *   parameters we sent; a *different answer* needs a changed request. A
 *   consumer whose request is fixed (the first-forecast poll) can only wait
 *   out its own deadline and report — deliberately pinned behaviour, not an
 *   invitation to hot-retry.
 * - `server-fault` — server → client: the fleet *answered*, and the answer is
 *   that it is broken (a 5xx). Recourse is a backoff retry, the same shape
 *   `network` has, but the two stay separate arms because the question that
 *   decides blame is "who does the operator need to call?" — the fleet's
 *   operator here, the visitor's own connection there.
 * - `forbidden` — the API refused this client on policy, not on content. The one
 *   failure a retry cannot fix: what is wrong is *who is asking*, so the recourse
 *   is a deployment change (`CUMULO_WEB_ORIGINS`).
 */
export type FleetDataError =
  | { readonly code: 'network'; readonly message: string }
  | {
      readonly code: 'rate-limited';
      readonly message: string;
      /**
       * The wait the server asked for, when this client could read one.
       *
       * Absent is neither zero nor "the server stated none". `Retry-After` is
       * not a CORS-safelisted response header and `infra/api/gateway.tf`'s
       * `cors_configuration` sets no `expose_headers`. Absent therefore means
       * "no wait this client could read"; exposing the header is #21's
       * (`expose_headers = ["retry-after"]`).
       */
      readonly retryAfterSeconds?: number;
    }
  | { readonly code: 'not-found'; readonly message: string }
  | { readonly code: 'invalid-response'; readonly message: string }
  | { readonly code: 'invalid-request'; readonly message: string }
  | { readonly code: 'server-fault'; readonly message: string }
  | { readonly code: 'forbidden'; readonly message: string };

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
 * This is the app's *only* fleet result type; a second one whose failure arm was
 * a bare `string` was retired at #105.
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
 *
 * Per-site reads honour the look-back. **Fleet-level _forecasts_ cannot.** The
 * fleet-wide read of forecasts an HTTP source has is `GET /v1/fleet/forecast`,
 * one request for the whole fleet (#296), and its window opens at the clock
 * and runs *ahead* — so the HTTP source's fleet-level forecast reinterprets
 * this window as a forward horizon (see {@link FleetDataSource.fleetForecasts}).
 * Fleet-level range selection is therefore horizon-capped in live mode: it
 * selects how far *ahead* the aggregate reaches, and any two ranges past the
 * deployed pipeline's write depth render identically.
 *
 * Fleet-level *actuals* are the other half, and they do honour this window even
 * in live mode: `GET /v1/fleet/actuals` takes the look-back and answers for the
 * whole fleet in one request (#264). That is why the two flags below move
 * independently.
 */
export type RangeHours = 24 | 48 | 168;

/**
 * What a source can actually answer at the fleet level, as data rather than as
 * prose a view has to know by heart.
 *
 * Copy and controls that promise a chosen history, or actuals of any kind, are
 * only honest against a source that says so here, so they read these instead of
 * assuming.
 */
export interface FleetSourceCapabilities {
  /**
   * Fleet-level *forecasts* honour {@link RangeHours} as a look-back. False ⇒
   * forward horizon only.
   *
   * It decides what the panel may *say* about a look-back, and no longer decides
   * on its own whether a window can be chosen (#284 D5). The naming obligation
   * that leaves is discharged by
   * `apps/web/src/dashboard/fleet-panel-copy.ts`, and
   * `apps/web/src/dashboard/FleetPanel.tsx` owns the control's gate.
   */
  readonly fleetLookback: boolean;
  /** Fleet-level actuals can ever be non-empty. */
  readonly fleetActuals: boolean;
}

/**
 * Everything `apps/web` needs from the fleet, with no commitment to where the
 * fleet lives.
 *
 * Every view talks to this interface and nothing else, so the same components run
 * against deterministic fixtures and against the Fleet API (#14) with no change
 * above this line. Two implementations exist by design: `DemoFleetDataSource`
 * (deterministic, in-memory, what local development and the whole test suite run
 * against) and `apps/web/src/data/http-fleet-data-source.ts`.
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
 * `@cumulo/shared`. The one failure that does *not* arrive in that shape is a
 * gateway-generated 429. The HTTP source consequently maps on **status**, the
 * one part of the contract every arm is reachable from
 * (`apps/web/src/data/fleet-api-result.test.ts`):
 *
 * - **404** (`not_found`) → `not-found`. Covers an unknown site *and* a site
 *   whose first forecast does not exist yet; the poll treats both as "wait".
 * - **429** (a gateway throttle, or the API's own per-IP limiter) →
 *   `rate-limited`, with `retryAfterSeconds` taken from the `Retry-After` header
 *   when this client can read one. The caller floors its own backoff rather
 *   than reading the absence as permission to retry at once.
 * - **400** (`validation_failed`) → `invalid-request`.
 * - **A 2xx body that fails its zod parse** → `invalid-response`.
 * - **403** (`forbidden`) → `forbidden`. The API refuses a write whose `Origin`
 *   it does not serve, and refuses any request from a caller it has blocked for
 *   abuse (#29).
 * - **5xx** (`internal`, and any other status at or above 500) →
 *   `server-fault`.
 * - **Any other unlisted 4xx** (401, 405, 409, 422… — statuses this API may
 *   grow) → `invalid-request`, by the same direction the listed 400 takes.
 * - **Any remaining non-ok status** (a 3xx a `fetch` surfaced rather than
 *   followed) → `invalid-response`.
 * - **A `fetch` that rejects** → `network`. That arm is now reachable only
 *   this way, which is what makes its doc ("never produced an answer") true.
 *
 * A 200 carrying an empty series is **not** an error: the API answers a
 * forecast-less site with an object rather than a bare array, so it can carry the
 * Open-Meteo credit beside the data it credits (`siteForecastResponseSchema`).
 * The HTTP source unwraps it into an `ok` result holding an empty array, and
 * callers that need "nothing yet" as a distinct state derive it from that —
 * `apps/web/src/data/use-first-forecast.ts` does.
 *
 * The attribution travels with every weather-derived payload and must be
 * displayed wherever the data is (CC BY 4.0, CLAUDE.md). Today the UI renders
 * a static credit; unwrapping it is a decision to revisit here rather than a
 * detail of the transport.
 */
export interface FleetDataSource {
  /**
   * What this source can answer at the fleet level — see
   * {@link FleetSourceCapabilities}.
   *
   * A required member rather than an optional one so that a source added later
   * cannot omit it and inherit whichever default happened to flatter it.
   */
  readonly capabilities: FleetSourceCapabilities;

  /**
   * The whole fleet, once. Callers load this on mount and never poll it.
   *
   * This read is the cheap one (ADR 0002). The read-capacity mistake that ADR's
   * review called out belongs to the fleet-level *series* reads it usually
   * precedes — polling either of them would still be that mistake. The per-load
   * arithmetic is owned by the `series` section of `infra/storage/tables.tf`.
   */
  readonly listSites: () => Promise<FleetSourceResult<readonly Site[]>>;

  /**
   * Adds a site to the fleet.
   *
   * The returned `Site` carries the **server-assigned id**, and that returned
   * value is the only legitimate source of it. Callers must not predict an id
   * locally: a locally minted id addresses a site that does not exist.
   */
  readonly createSite: (input: CreateSiteInput) => Promise<FleetSourceResult<Site>>;

  /**
   * The forecast series for one site as it stands *now* — one partition, never
   * the fleet, and no window to choose.
   *
   * This is the poll's call (`GET /v1/sites/{siteId}/forecast`). `not-found` and
   * an empty series are both the normal answer for a site created seconds ago, so
   * a caller polling for the first forecast treats either as "keep waiting".
   */
  readonly getSiteForecast: (siteId: Site['id']) => Promise<FleetSourceResult<readonly Forecast[]>>;

  /**
   * One site's forecast over a chosen window (`GET /v1/sites/{siteId}/series`).
   *
   * Distinct from {@link getSiteForecast} because the question is different:
   * this one is the chart's, spanning `range` hours of history plus the
   * horizon.
   */
  readonly siteForecasts: (
    siteId: Site['id'],
    range: RangeHours,
  ) => Promise<FleetSourceResult<readonly Forecast[]>>;

  /**
   * One site's generation actuals over the same window, for the same chart —
   * simulated in live mode (the forecast service synthesises them from the
   * stored physics forecast, #264) and fixture-generated in the demo. The wire
   * shape is what a real meter would fill either way, so "simulated" is a claim
   * the UI's copy makes rather than a field on every reading.
   */
  readonly siteActuals: (
    siteId: Site['id'],
    range: RangeHours,
  ) => Promise<FleetSourceResult<readonly GenerationReading[]>>;

  /**
   * The fleet's forecast over the window, **already summed** — one point per hour.
   *
   * The seam sits above the aggregation rather than below it (#494). The HTTP
   * source now reads `GET /v1/fleet/forecast`, which serves the total the
   * forecast producer computed, and the demo source computes the identical shape
   * with `@cumulo/shared`'s `fleetForecastAggregate`. One definition of the fleet
   * total (`architecture.md` rule 3), two ways of arriving at the shape.
   *
   * `contributingCapacityKw` travels with each point for that reason too: the
   * `%`-of-capacity view needs a per-hour divisor.
   *
   * It spends `range` as a **forward horizon**, not as the look-back
   * {@link RangeHours} otherwise describes. An implementation is free to serve the
   * look-back if it can — the demo source does — but no implementation is
   * required to.
   */
  readonly fleetForecasts: (
    range: RangeHours,
  ) => Promise<FleetSourceResult<readonly FleetForecastAggregatePoint[]>>;

  /**
   * Every site's generation actuals over the window, unaggregated — simulated
   * in live mode as {@link siteActuals} describes (#264).
   *
   * Like {@link fleetForecasts} this is one request for the whole fleet — the
   * HTTP source reads `GET /v1/fleet/actuals`. That route reads *backwards* from
   * now, so this member honours `range` as
   * the look-back {@link RangeHours} describes even where `fleetLookback` is
   * false.
   */
  readonly fleetActuals: (
    range: RangeHours,
  ) => Promise<FleetSourceResult<readonly GenerationReading[]>>;
}
