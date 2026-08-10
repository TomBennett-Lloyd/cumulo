import type { FleetSite, UtcIsoTimestamp } from '@cumulo/shared';
import type { QueryPaginationBound, SeriesAdapter, SeriesPoint } from '@cumulo/storage';

import type { RequestDeadline } from '../http/request-deadline';
import { errorResponse, type ApiResponse } from '../http/response';
import { hasBudgetForStorageCommands } from '../request-budget';

/**
 * The fan-out both fleet routes perform: one Query per site over one window,
 * issued in concurrent batches, deadline-gated between them, whole-or-nothing.
 *
 * **The batch is the unit, and the gate sits between batches.** A fleet of 61
 * sites read one site at a time is 61 warm round trips (~2.4 s, measured at
 * #296) for work whose Queries do not depend on one another at all — the window
 * is one window, chosen once by the caller, and no site's read tells the next
 * one anything. So the loop reads {@link FLEET_READ_CONCURRENCY} sites at a
 * time and asks the deadline once per batch, which turns the fleet's cost from
 * one round trip per site into one per batch.
 *
 * **Why one admission prices one command.** The gate asks
 * `hasBudgetForStorageCommands(remaining, 1)` before a batch of many Queries,
 * which looks like under-pricing and is not: the batch's cost in *wall clock* —
 * which is the only currency the deadline spends — is the **maximum** of its
 * members, not their sum. All of them are dispatched in the same tick as the
 * admission, each independently bounded by `STORAGE_COMMAND_WORST_MS`, so
 * concurrent worst cases overlap rather than accumulate. Pricing the batch
 * serially would be not merely pessimistic but incoherent: `W` commands demand
 * more than the whole invocation budget for any `W` above one, so every batch
 * after the first would refuse, always. Nor does a member sneak in extra
 * commands behind that one admission — pages within a site's Query are
 * re-admitted page by page through the same `bound` below. `request-budget.ts`
 * states the invariant this rests on: what an admission buys is one
 * `STORAGE_COMMAND_WORST_MS` of wall clock.
 *
 * **What survives of the one-at-a-time argument.** The gate is still there, and
 * it still refuses the shape it always refused: the fleet's whole worth of
 * Queries spent with nothing between them to stop. Batching moves the something
 * between them from every site to every batch boundary; it does not remove it. A
 * fan-out with no gate at all — one `Promise.all` over the entire fleet — is
 * still the shape this module declines, because an arbitrarily large fleet would
 * then commit an arbitrary number of Queries on one reading of the clock.
 *
 * **Why this is shared rather than written twice.** `get-fleet-actuals.ts` and
 * `get-fleet-forecast.ts` differ in the parts a reader would expect them to —
 * which direction the window runs, which kind of point they keep, which schema
 * their body is parsed against — and are identical in this part: the order the
 * sites are read in, when the loop is allowed to start another Query, and what
 * happens when it cannot finish. Apply `docs/standards/structure.md` rule 7's
 * test to that middle: if the gate moved, or a truncated fan-out started being
 * served as a partial 200, the other route would be wrong until it changed the
 * same way. So the shared portion is extracted and the dissimilar remainder
 * stays in the handlers — deliberately *not* one function with a direction flag
 * and a "which kind of point" flag, which is the shape rule 7 names as the tell
 * that two intents were forced together.
 *
 * What comes back is therefore one array of raw {@link SeriesPoint}s per site,
 * unsplit: the split is the caller's half of the job (`series-split.ts`), and
 * doing it here would require exactly the flag this module exists without.
 *
 * **The deadline event is a parameter**, not a constant declared here, because
 * each route owns its own: an operator asking "which fan-out is outgrowing the
 * function timeout?" needs to be able to tell the two apart in a log query, and
 * a single shared event name could not separate them.
 */

/**
 * How many sites this fan-out reads at once: **8**.
 *
 * **What the width costs, and where.** Nothing on the Lambda side: promises in
 * flight inside one invocation are still one execution environment, so the
 * account concurrency cap recorded in `infra/ingestion/alarms.tf` counts this
 * request exactly once however many Queries it is holding. What the width
 * multiplies is downstream — worst case this many times that cap in concurrent
 * Queries against the `cumulo-series` table, which is on on-demand billing
 * (ADR 0002) and absorbs bursts orders of magnitude above that number. Nor does
 * a batch queue on sockets: `@smithy/node-http-handler`'s default `maxSockets`
 * sits well above this width and `packages/storage/src/client.ts` does not
 * lower it.
 *
 * **So why not wider.** Because the ceiling that binds is not throughput, it is
 * how much work one reading of the clock is allowed to commit. A batch is
 * admitted on the deadline as it stood before the batch began, and the fleet
 * cannot be re-asked mid-batch; a width the size of the fleet is the ungated
 * fan-out this module refuses. At this width a 61-site fleet costs eight round
 * trips instead of 61 and the request still stops to check the clock seven
 * times on the way — which is the trade this number *is*, and the reason it is a
 * named constant a test can hold rather than a literal in the loop head.
 */
export const FLEET_READ_CONCURRENCY = 8;

export interface FleetSeriesReadDeps {
  /** Reads only: neither fleet route writes a point (`typing.md` rule 6, ADR 0002 least privilege). */
  readonly series: Pick<SeriesAdapter, 'querySeriesRange'>;
  /** Structured-logging sink (`docs/standards/error-handling.md` rule 4). */
  readonly log: (entry: Record<string, unknown>) => void;
}

/**
 * The whole fleet's points, or the response that says why they are not coming.
 *
 * A discriminated union rather than a points array plus an optional error
 * (`docs/standards/typing.md` rule 4), and `complete` is the discriminant
 * because it is the adapter's own word for the same distinction: a read that
 * stopped with the window unread. The failure arm carries a built
 * {@link ApiResponse} rather than a reason code — there is exactly one refusal
 * here and its status, code and message are this module's to decide, not a
 * decision each handler should be free to spell differently.
 */
export type FleetSeriesRead =
  | { readonly complete: true; readonly perSite: readonly (readonly SeriesPoint[])[] }
  | { readonly complete: false; readonly response: ApiResponse };

/**
 * The one 500 the fan-out answers, with the log line that says where it stopped.
 *
 * Two call sites — the fan-out stopped between batches, and one site's window
 * stopped mid-page — and deliberately one message: a caller can do nothing
 * different with the two, while an operator reads the difference off the fields
 * in `detail`. One function rather than the message written twice, so the two
 * cannot drift into two contracts (`docs/standards/structure.md` rule 7).
 */
const readDeadlineReached = (
  log: FleetSeriesReadDeps['log'],
  deadlineEvent: string,
  detail: Record<string, unknown>,
): ApiResponse => {
  log({ event: deadlineEvent, ...detail });
  return errorResponse('internal', 'the request could not be completed in time');
};

/**
 * Read every site's points over `from`…`to`, or refuse.
 *
 * Every input arrives as a parameter — the sites, the window, the deadline, the
 * event name — so the loop is legible without knowing which handler called it
 * (`docs/standards/structure.md` rule 1). The window is passed already computed
 * rather than as a horizon, because which end of it the clock sits at is the
 * caller's decision and the difference between the two routes.
 */
export const readFleetSeries = async (
  deps: FleetSeriesReadDeps,
  deadline: RequestDeadline,
  sites: readonly FleetSite[],
  from: UtcIsoTimestamp,
  to: UtcIsoTimestamp,
  deadlineEvent: string,
): Promise<FleetSeriesRead> => {
  // Asked between pages of one site's Query, never mid-page (`request-budget.ts`).
  const bound: QueryPaginationBound = {
    hasBudgetForNextPage: () => hasBudgetForStorageCommands(deadline.remainingMs(), 1),
  };

  // One array per site, flattened once by the caller rather than spread-pushed
  // per site: the wire order is site by site, chronological within each, which
  // is the order the demo source produces too and the order the fleet chart's
  // hour-by-hour aggregation is indifferent to.
  const perSite: SeriesPoint[][] = [];

  for (let start = 0; start < sites.length; start += FLEET_READ_CONCURRENCY) {
    // Gated before every batch *after* the first — the opening batch is this
    // fan-out's ungated prefix, exactly as the first Query was when the loop
    // read one site at a time, and as the first page of every Query still is.
    // `sitesRead` counts sites rather than batches because it is the fleet the
    // operator is reasoning about, and `start` is already that count.
    if (start > 0 && !hasBudgetForStorageCommands(deadline.remainingMs(), 1)) {
      return {
        complete: false,
        response: readDeadlineReached(deps.log, deadlineEvent, {
          sitesRead: start,
          fleetSize: sites.length,
        }),
      };
    }

    // Each read carries its own site rather than being matched back by index:
    // under `noUncheckedIndexedAccess` the indexed lookup would be
    // `FleetSite | undefined` at a point where it provably is not
    // (`docs/standards/typing.md` rule 5). `Promise.all` settles in site order
    // whatever order the Queries answer in, so the wire order below is the
    // fleet's order and not the network's. A `StorageError` from any member
    // rejects this `await` and travels to the route boundary as it always did —
    // no `catch` here would have anything to add
    // (`docs/standards/error-handling.md` rule 2), and `Promise.all` has
    // attached a handler to every member, so a second failure is not an
    // unhandled rejection.
    const batch = await Promise.all(
      sites.slice(start, start + FLEET_READ_CONCURRENCY).map(async (site) => ({
        site,
        read: await deps.series.querySeriesRange(site.id, from, to, bound),
      })),
    );

    // A fleet short of one site's afternoon is the half-truth `get-site-series.ts`
    // refuses at length, and it is worse here: these points are summed hour by
    // hour, so a missing site does not read as missing — it reads as a fleet
    // that generated, or will generate, less. Serving the whole thing or
    // nothing is the only honest option this wire contract offers
    // (`docs/standards/error-handling.md` rule 5); labelling the response
    // partial is the richer answer and is the same contract change #165 holds
    // for the per-site routes.
    //
    // The batch is judged in site order, so the site named in the log is the
    // *first* one that stopped short — the one an operator would go and look
    // at — even though its neighbours were read at the same moment. The next
    // batch is never started: more sites cannot make this answer whole.
    const stoppedShort = batch.find(({ read }) => !read.complete);
    if (stoppedShort) {
      return {
        complete: false,
        response: readDeadlineReached(deps.log, deadlineEvent, { siteId: stoppedShort.site.id }),
      };
    }

    for (const { read } of batch) {
      perSite.push(read.points);
    }
  }

  return { complete: true, perSite };
};
