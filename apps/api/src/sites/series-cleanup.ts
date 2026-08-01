import type { SeriesAdapter } from '@cumulo/storage';

import { describeThrown } from '../thrown-detail';

/**
 * Removing a departed site's stored series points (access pattern X3), shared by
 * the eviction inside `POST /v1/sites` and by `DELETE /v1/sites/{siteId}`.
 *
 * One module rather than a copy in each handler: the two callers differ only in
 * *why* the site left, and if the cleanup's policy changed — what it logs, what
 * it does with a partial drain — the other caller would be wrong until it
 * changed identically (`docs/standards/structure.md` rule 7).
 *
 * The cleanup is **awaited**, not fired and forgotten. Work left pending when a
 * Lambda handler resolves is frozen with the container and resumed at some
 * arbitrary later invocation, or never; awaiting is the only way the deletes
 * actually happen. The cost is latency on the one request that evicts: a full
 * ~97-point partition is under 7 seconds against the series table's provisioned
 * 14 WCU with no burst assumed, inside the function's 15-second timeout
 * (`infra/api/lambda.tf`), and instant in the normal case where the burst
 * reserve is there.
 */

/**
 * Emitted when the cleanup threw. The site is gone; some of its points are not.
 */
export const seriesCleanupFailedEvent = 'api.site.series-cleanup-failed';

/**
 * Emitted when DynamoDB kept declining deletes until the batch policy gave up.
 * Distinct from the failure event because it is a different operator question:
 * "was the table throttled?" rather than "did the call break?".
 */
export const seriesCleanupIncompleteEvent = 'api.site.series-cleanup-incomplete';

export interface SeriesCleanupDeps {
  readonly series: Pick<SeriesAdapter, 'deleteSiteSeries'>;
  /** Structured-logging sink (`docs/standards/error-handling.md` rule 4). */
  readonly log: (entry: Record<string, unknown>) => void;
}

export const cleanUpSiteSeries = async (deps: SeriesCleanupDeps, siteId: string): Promise<void> => {
  try {
    const outcome = await deps.series.deleteSiteSeries(siteId);
    if (outcome.status === 'partial') {
      // The adapter reports a short drain rather than pretending completeness
      // (`docs/standards/error-handling.md` rule 5); reporting it is this
      // caller's half of that bargain.
      deps.log({
        event: seriesCleanupIncompleteEvent,
        siteId,
        unprocessedCount: outcome.unprocessedCount,
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
    // silent: the orphaned points expire under ADR 0002's 90-day series TTL, so
    // the worst case is storage the cap does not shrink, and this log line is
    // what makes that visible when it happens.
    deps.log({ event: seriesCleanupFailedEvent, siteId, detail: describeThrown(error) });
  }
};
