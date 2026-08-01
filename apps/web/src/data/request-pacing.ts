/**
 * Launch-rate pacing for a client-side fan-out.
 *
 * The fleet view needs one request per site and the API sits behind a shared
 * per-second stage throttle, so the fan-out's shape is a product decision, not
 * an implementation detail: fired all at once, a 60-site fleet 429s most of
 * itself and the dashboard renders a fleet that looks broken. Pacing the
 * launches turns that into a slightly slower load of the whole fleet.
 *
 * Domain-named rather than a `utils` helper (`architecture.md` rule 5), and
 * separate from the transport so the pacing can be tested with an injected
 * `delay` and no clock at all.
 */

const MS_PER_SECOND = 1000;

/**
 * The real wait, wrapped rather than passed as `setTimeout` itself: a detached
 * host method is a lint error here (`structure.md` rule 3), and this is the one
 * place in the module that touches a timer.
 */
const sleepMs = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export interface PacedMapOptions {
  /**
   * How many workers may be launched in one second. The ceiling this is chosen
   * against belongs to the caller — it is the caller that knows which route it
   * is calling and what throttles that route.
   */
  readonly launchesPerSecond: number;
  /**
   * The wait between batches. Injected so a test drives the pacing directly
   * rather than by sleeping, and so the suite never spends a real second.
   */
  readonly delay?: (ms: number) => Promise<void>;
}

/**
 * `items.map(worker)`, launched in batches of `launchesPerSecond` a second
 * apart, results in input order.
 *
 * Two properties callers rely on:
 *
 * - **Order is the input's**, not completion's. A fan-out whose results
 *   arrived in race order would make the aggregate view's output depend on
 *   which site's request happened to be quickest.
 * - **It never rejects because the work failed.** `worker` is expected to
 *   return a result value for every outcome — which is what the fleet source's
 *   `FleetSourceResult` already is — so a partial fan-out comes back as a list
 *   containing failures rather than as one rejection that discards the sites
 *   that did answer (`error-handling.md` rule 5). The one rejection this can
 *   produce is the precondition below, which is a bug in the caller.
 *
 * The delay is taken *after* a batch has settled rather than on a fixed
 * schedule, so a slow batch spreads the launches further apart rather than
 * closer together. That errs on the safe side of a throttle, and it is the
 * reason this is not a token bucket: a bucket would let a stalled batch bank
 * capacity and then spend it all at once, which is precisely the burst the
 * pacing exists to avoid.
 */
export const pacedMap = async <T, R>(
  items: readonly T[],
  worker: (item: T) => Promise<R>,
  options: PacedMapOptions,
): Promise<readonly R[]> => {
  if (!Number.isInteger(options.launchesPerSecond) || options.launchesPerSecond < 1) {
    // A violated invariant, not an outcome: zero or a fraction makes the loop
    // below never advance, and a hang is the worst way to report a typo
    // (`error-handling.md` rule 1).
    throw new Error(
      `pacedMap: launchesPerSecond must be a positive integer, received ${String(options.launchesPerSecond)}`,
    );
  }

  const delay = options.delay ?? sleepMs;
  const results: R[] = [];

  for (let start = 0; start < items.length; start += options.launchesPerSecond) {
    if (start > 0) {
      await delay(MS_PER_SECOND);
    }
    const batch = items.slice(start, start + options.launchesPerSecond);
    results.push(...(await Promise.all(batch.map((item) => worker(item)))));
  }

  return results;
};
