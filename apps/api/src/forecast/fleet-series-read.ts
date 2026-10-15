import type { FleetSite, UtcIsoTimestamp } from '@cumulo/shared';
import type { QueryPaginationBound, SeriesAdapter, SeriesPoint } from '@cumulo/storage';

import type { RequestDeadline } from '../http/request-deadline';
import { errorResponse, type ApiResponse } from '../http/response';
import { hasBudgetForStorageCommands } from '../request-budget';

/**
 * The fan-out over one window: one Query per site, issued in concurrent
 * batches, deadline-gated between them, whole-or-nothing.
 *
 * **Two callers, both fallbacks.** Both fleet routes read the pre-summed
 * `#FLEET` partition and reach this module only through ADR 0009's fallback,
 * which #507 removes.
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
 * What comes back is one array of raw {@link SeriesPoint}s per site,
 * unsplit: the split is the caller's half of the job (`series-split.ts`).
 */

/**
 * How many sites this fan-out reads at once: **8**.
 *
 * **So why not wider.** Because the ceiling that binds is not throughput, it is
 * how much work one reading of the clock is allowed to commit. A batch is
 * admitted on the deadline as it stood before the batch began, and the fleet
 * cannot be re-asked mid-batch; a width the size of the fleet is the ungated
 * fan-out this module refuses.
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
 * (`docs/standards/typing.md` rule 4).
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
 * in `detail`.
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
 * The window is passed already computed rather than as a horizon, because which
 * end of it the clock sits at is the caller's decision and the difference
 * between the two routes.
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
  // per site: the wire order is site by site, chronological within each.
  const perSite: SeriesPoint[][] = [];

  for (let start = 0; start < sites.length; start += FLEET_READ_CONCURRENCY) {
    // Gated before every batch *after* the first — the opening batch is this
    // fan-out's ungated prefix.
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
    // (`docs/standards/error-handling.md` rule 2).
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
