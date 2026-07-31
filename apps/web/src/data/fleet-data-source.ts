import type { CreateSiteInput, Forecast, Site } from '@cumulo/shared';

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
 */
export type DataResult<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'error'; readonly error: FleetDataError };

/**
 * Everything the dashboard needs from the fleet, with no commitment to where
 * the fleet lives.
 *
 * Two implementations exist by design: `DemoFleetDataSource` (deterministic,
 * in-memory, what local development and the whole test suite run against) and
 * the HTTP source that talks to the Fleet API (#14). The dashboard depends on
 * this interface only, which is what lets the UI be built and proven before
 * the API exists.
 */
export interface FleetDataSource {
  /**
   * The whole fleet, once. Callers load this on mount and never poll it: a
   * repeated fan-out across every site's partition is the read-capacity
   * mistake ADR 0002's review called out (a per-site forecast poll costs
   * ~0.5 read units; the fleet fan-out costs ~25).
   */
  listSites(): Promise<DataResult<readonly Site[]>>;

  /**
   * Adds a site to the fleet.
   *
   * The returned `Site` carries the **server-assigned id**, and that returned
   * value is the only legitimate source of it. Callers must not predict an id
   * locally: a locally minted id can collide with, or shadow, a real one, and
   * every subsequent call keyed on it (forecast polling above all) then
   * addresses a site that does not exist.
   */
  createSite(input: CreateSiteInput): Promise<DataResult<Site>>;

  /**
   * The forecast series for one site — one partition, never the fleet.
   *
   * `not-found` is the normal answer for a site whose first forecast has not
   * been produced yet, so a caller polling for it should treat that arm as
   * "keep waiting" rather than as a failure.
   */
  getSiteForecast(siteId: Site['id']): Promise<DataResult<readonly Forecast[]>>;
}
