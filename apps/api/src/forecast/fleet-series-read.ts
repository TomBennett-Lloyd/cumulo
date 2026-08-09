import type { FleetSite, UtcIsoTimestamp } from '@cumulo/shared';
import type { QueryPaginationBound, SeriesAdapter, SeriesPoint } from '@cumulo/storage';

import type { RequestDeadline } from '../http/request-deadline';
import { errorResponse, type ApiResponse } from '../http/response';
import { hasBudgetForStorageCommands } from '../request-budget';

/**
 * The fan-out both fleet routes perform: one Query per site over one window,
 * sequential, deadline-gated, and whole-or-nothing.
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
 * Two call sites — the fan-out stopped between sites, and one site's window
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

  for (const [index, site] of sites.entries()) {
    // Sequential, and gated before every site *after* the first — the first
    // Query is this fan-out's ungated prefix, as it is on every read in this
    // folder. A parallel fan-out would spend the fleet's worth of Queries with
    // nothing between them to stop, which is the shape the deadline exists to
    // refuse.
    if (index > 0 && !hasBudgetForStorageCommands(deadline.remainingMs(), 1)) {
      return {
        complete: false,
        response: readDeadlineReached(deps.log, deadlineEvent, {
          sitesRead: index,
          fleetSize: sites.length,
        }),
      };
    }

    const { points, complete } = await deps.series.querySeriesRange(site.id, from, to, bound);

    // A fleet short of one site's afternoon is the half-truth `get-site-series.ts`
    // refuses at length, and it is worse here: these points are summed hour by
    // hour, so a missing site does not read as missing — it reads as a fleet
    // that generated, or will generate, less. Serving the whole thing or
    // nothing is the only honest option this wire contract offers
    // (`docs/standards/error-handling.md` rule 5); labelling the response
    // partial is the richer answer and is the same contract change #165 holds
    // for the per-site routes.
    if (!complete) {
      return {
        complete: false,
        response: readDeadlineReached(deps.log, deadlineEvent, { siteId: site.id }),
      };
    }

    perSite.push(points);
  }

  return { complete: true, perSite };
};
