import type { SeriesAdapter, SeriesCleanupOutcome } from '@cumulo/storage';

import { SERIES_CLEANUP_MAX_ITEMS } from '../request-budget';
import { describeThrown } from '../thrown-detail';

/**
 * Removing a departed site's stored series points (access pattern X3), shared by
 * the eviction inside `POST /v1/sites` and by `DELETE /v1/sites/{siteId}`.
 *
 * One module rather than a copy in each handler: the two callers differ only in
 * *why* the site left, and if the cleanup's policy changed — its budget, what
 * it logs, what it does with a short pass — the other caller would be wrong
 * until it changed identically (`docs/standards/structure.md` rule 7).
 *
 * **Bounded, and awaited.** Awaited because work left pending when a Lambda
 * handler resolves is frozen with the container and resumed at some arbitrary
 * later invocation, or never — so an unawaited cleanup is a cleanup that does
 * not happen. Bounded because awaiting an unbounded one is worse than not doing
 * it at all: the pass runs *after* the caller's write has committed, so a drain
 * that outlives the function timeout turns a committed 201 into a gateway 504,
 * and on the create path that 201 body is the only place the caller ever learns
 * the new site's id. {@link SERIES_CLEANUP_MAX_ITEMS} carries the arithmetic;
 * the short version is that one pass costs at most two DynamoDB requests.
 *
 * What the budget does not do is finish the job on an old site — a partition
 * that has been accumulating for weeks holds far more than one pass removes,
 * and eviction picks the oldest site precisely. The 90-day TTL of ADR 0002 is
 * what actually bounds stored rows, here as before; this pass is the prompt
 * half, and it is the whole job for the demo's common case of a site created
 * and evicted within a session. `docs/tech-debt.md` records that the inline
 * pass wants moving off the request path entirely.
 */

/**
 * Emitted when the cleanup threw. The site is gone; its points are not.
 */
export const seriesCleanupFailedEvent = 'api.site.series-cleanup-failed';

/**
 * Emitted when the pass ran but left rows behind — either DynamoDB declined
 * some deletes (capacity) or the pass hit its item budget (arithmetic). The
 * entry carries both counts because they call for different responses, and
 * neither is an error: whatever is left expires on the TTL.
 */
export const seriesCleanupIncompleteEvent = 'api.site.series-cleanup-incomplete';

export interface SeriesCleanupDeps {
  readonly series: Pick<SeriesAdapter, 'deleteSiteSeries'>;
  /** Structured-logging sink (`docs/standards/error-handling.md` rule 4). */
  readonly log: (entry: Record<string, unknown>) => void;
}

const leftRowsBehind = (outcome: SeriesCleanupOutcome): boolean =>
  outcome.declinedCount > 0 || outcome.budgetReached;

export const cleanUpSiteSeries = async (deps: SeriesCleanupDeps, siteId: string): Promise<void> => {
  try {
    const outcome = await deps.series.deleteSiteSeries(siteId, SERIES_CLEANUP_MAX_ITEMS);
    if (leftRowsBehind(outcome)) {
      // Reported rather than assumed: the adapter distinguishes a pass that
      // emptied the partition from one that merely sampled it
      // (`docs/standards/error-handling.md` rule 5), and dropping that
      // distinction here would put the dishonesty back where it started.
      deps.log({
        event: seriesCleanupIncompleteEvent,
        siteId,
        deletedCount: outcome.deletedCount,
        declinedCount: outcome.declinedCount,
        budgetReached: outcome.budgetReached,
      });
    }
  } catch (error: unknown) {
    // A `catch` that ends a failure, which `docs/standards/error-handling.md`
    // rule 2 otherwise reserves for the top-level boundary — so here is the
    // rule-2c argument for it. This catch *is* a boundary: it terminates a
    // subordinate operation, not a step on the request's own path. The caller's
    // create or delete has already committed by the time it runs, so (b)
    // rethrowing would answer 500 for a site that demonstrably exists or is
    // demonstrably gone — a lie about the operation the client asked for — and
    // (a) converting to a value would only move the same dead end one frame up,
    // since no caller can act on it either. The failure is bounded rather than
    // silent: the rows expire under ADR 0002's 90-day series TTL, so the worst
    // case is storage this pass did not bring forward, and this log line is
    // what makes that visible when it happens.
    deps.log({ event: seriesCleanupFailedEvent, siteId, detail: describeThrown(error) });
  }
};
