import type { CreateSiteInput, Forecast, GenerationReading, Site } from '@cumulo/shared';

/**
 * Why the fleet could not answer, from the client's point of view.
 *
 * Deliberately the *client's* view rather than a transport code: the whole
 * point of the union is that each arm implies a different recourse, and two
 * transports that imply the same recourse are the same arm here.
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
 *   (`error-handling.md` rule 3, and the Open-Meteo budget in CLAUDE.md
 *   upstream of it).
 * - `not-found` — the entity does not exist *yet*. For a forecast this is the
 *   ordinary state of a site created seconds ago, not a fault, which is why
 *   the first-forecast poll treats it as "keep waiting".
 * - `invalid-response` — server → client: the fleet sent a payload this client
 *   cannot reconcile with the domain schemas. Changing the request cannot
 *   help; *time* can — the same request may parse later (a record the
 *   pipeline is still writing), which is why the first-forecast poll keeps
 *   waiting on this arm instead of failing fast.
 * - `invalid-request` — client → server: the fleet refused the payload or
 *   parameters we sent; a *different answer* needs a changed request. A
 *   consumer whose request is fixed (the first-forecast poll) can only wait
 *   out its own deadline and report — deliberately pinned behaviour, not an
 *   invitation to hot-retry.
 * - `server-fault` — server → client: the fleet *answered*, and the answer is
 *   that it is broken (a 5xx). Recourse is to retry on a backoff, the same
 *   shape of recourse `network` has — but the two are separate arms because
 *   the question that decides blame is "who does the operator need to call?"
 *   and the answers differ: the fleet's operator here, the visitor's own
 *   connection there. That is why #162's "same recourse ⇒ same arm" principle
 *   does not collapse them, and it is what keeps `network`'s own doc true:
 *   only requests that never produced an answer land there.
 * - `forbidden` — the API refused this client on policy, not on content. The
 *   one failure a retry cannot fix: nothing the caller can add to the request
 *   makes it succeed, because what is wrong is *who is asking*. Its recourse is
 *   a deployment change (`CUMULO_WEB_ORIGINS`), which is why it is neither of
 *   the two data arms above — those are about the bytes, this one is about the
 *   identity behind them.
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
       * `cors_configuration` sets no `expose_headers`, so from a real
       * cross-origin deployment the browser withholds this header from this
       * code even when the wire carries it. Absent therefore means "no wait
       * this client could read"; exposing the header is #21's
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
 *
 * Per-site reads honour the look-back. **Fleet-level reads cannot.** The only
 * fleet-wide read an HTTP source may fan out over without tripping the API's
 * per-IP limiter is the per-site `/forecast` route, and that route returns
 * *future* hours — so the HTTP source's fleet-level implementation necessarily
 * reinterprets this window as a forward horizon (see
 * {@link FleetDataSource.fleetForecasts}). Fleet-level range selection is
 * therefore horizon-capped in live mode: it selects how far *ahead* the
 * aggregate reaches, it shows no history, and any two ranges past the deployed
 * pipeline's write depth render identically.
 */
export type RangeHours = 24 | 48 | 168;

/**
 * What a source can actually answer at the fleet level, as data rather than as
 * prose a view has to know by heart.
 *
 * The two flags exist because {@link RangeHours} already documents that
 * fleet-level reads may reinterpret the window and that an implementation is
 * free to serve the look-back but not required to — which leaves a view unable
 * to tell which kind of source it holds. Copy and controls that promise history
 * or measured output are only honest against a source that says so here, so
 * they read these instead of assuming.
 */
export interface FleetSourceCapabilities {
  /** Fleet-level reads honour {@link RangeHours} as a look-back. False ⇒ forward horizon only. */
  readonly fleetLookback: boolean;
  /** Fleet-level actuals can ever be non-empty. */
  readonly fleetActuals: boolean;
}

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
 * `@cumulo/shared`, in five codes — `validation_failed` (400), `forbidden`
 * (403), `not_found` (404), `rate_limited` (429) and `internal` (500). The one
 * failure that does *not* arrive in that shape is a gateway-generated 429:
 * API Gateway's stage and per-route throttles answer before the Lambda runs and
 * carry the gateway's own body, so 429 is the one status reachable with either
 * body. The HTTP source consequently maps on **status**, the one part of the
 * contract every arm is reachable from:
 *
 * - **404** (`not_found`) → `not-found`. Covers an unknown site *and* a site
 *   whose first forecast does not exist yet; the poll treats both as "wait".
 * - **429** (a gateway throttle, or the API's own per-IP limiter) →
 *   `rate-limited`, with `retryAfterSeconds` taken from the `Retry-After` header
 *   when this client can read one. From a **cross-origin browser** it usually
 *   cannot: `Retry-After` is not a CORS-safelisted response header and
 *   `infra/api/gateway.tf`'s `cors_configuration` sets no `expose_headers`, so
 *   from a real deployment the header reads as absent even on the limiter's
 *   429s, which always put it on the wire. Absent therefore means "no wait this
 *   client could read", not "the server stated none" — which is why the field
 *   is optional and why the caller floors its own backoff instead of reading
 *   the absence as permission to retry at once. Exposing the header is #21's
 *   (`expose_headers = ["retry-after"]`).
 * - **400** (`validation_failed`) → `invalid-request`. The fleet refused what
 *   this client sent — a different answer needs a changed request, though a
 *   fixed-request consumer may still wait out its own deadline (see the arm
 *   doc above).
 * - **A 2xx body that fails its zod parse** → `invalid-response`. The payload
 *   cannot be reconciled with the domain schemas; changing the request cannot
 *   help, but the same request may parse later (see the arm doc above).
 * - **403** (`forbidden`) → `forbidden`. The API refuses a write whose `Origin`
 *   it does not serve, and refuses any request from a caller it has blocked for
 *   abuse (#29). It is the one failure a retry cannot fix — the request is not
 *   wrong, the *caller* is — so its recourse is deployment configuration: the
 *   origin the app is served from has to be in the API's `CUMULO_WEB_ORIGINS`.
 *   A view that renders this as "try again" is telling the visitor to do the one
 *   thing that cannot work.
 * - **5xx** (`internal`, and any other status at or above 500) →
 *   `server-fault`. The fleet answered; the answer is that it is broken.
 *   Retryable on a backoff, but the operator to call is the fleet's.
 * - **Any other unlisted 4xx** (401, 405, 409, 422… — statuses this API may
 *   grow) → `invalid-request`, by the same direction the listed 400 takes: a
 *   4xx is the fleet reading what this client sent and refusing it.
 * - **Any remaining non-ok status** (a 3xx a `fetch` surfaced rather than
 *   followed) → `invalid-response`: the fleet answered in a shape this client
 *   cannot use.
 * - **A `fetch` that rejects** → `network`. That arm is now reachable only
 *   this way, which is what makes its doc ("never produced an answer") true.
 *
 * A 200 carrying an empty series is **not** an error: the API answers a
 * forecast-less site with `200 { "forecasts": [], "attribution": {…} }` — the
 * body is an object rather than a bare array, so that it can carry the
 * Open-Meteo credit beside the data it credits (`siteForecastResponseSchema`).
 * The HTTP source unwraps `forecasts` into `{ kind: 'ok', value: [] }` here.
 * Callers that need "nothing yet" as a distinct state derive it from the empty
 * array, which is what `useFirstForecast` does.
 *
 * The attribution travels with every weather-derived payload and must be
 * displayed wherever the data is (CC BY 4.0, CLAUDE.md). Today the UI renders
 * a static credit; an HTTP source that discards this field is only correct for
 * as long as that stays true, so unwrapping it is a decision to revisit here
 * rather than a detail of the transport.
 */
export interface FleetDataSource {
  /**
   * What this source can answer at the fleet level — see
   * {@link FleetSourceCapabilities}, and {@link RangeHours} for the range
   * semantics the first flag is about.
   *
   * A required member rather than an optional one so that a source added later
   * cannot omit it and inherit whichever default happened to flatter it.
   */
  readonly capabilities: FleetSourceCapabilities;

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
   *
   * That fan-out spends `range` as a **forward horizon**, not as the look-back
   * {@link RangeHours} otherwise describes: the unmetered per-site `/forecast`
   * route serves future hours only, and fanning out over `/series` instead
   * would trip the API's per-IP limiter (one request per site, against 30 per
   * 60 seconds). An implementation is free to serve the look-back if it can —
   * the demo source does — but no implementation is required to.
   */
  readonly fleetForecasts: (range: RangeHours) => Promise<FleetSourceResult<readonly Forecast[]>>;

  /** Every site's measured generation over the window, unaggregated. */
  readonly fleetActuals: (
    range: RangeHours,
  ) => Promise<FleetSourceResult<readonly GenerationReading[]>>;
}
