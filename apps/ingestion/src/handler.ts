import { runCycle, type CycleReport, type RunCycleDeps } from './cycle';

/**
 * The Lambda entry point: an ingestion cycle plus the two things a scheduled
 * function owes its operator — a structured log of what happened, and an honest
 * verdict on whether it worked.
 *
 * The verdict is the reason this module exists at all. `runCycle` resolves for
 * every fleet it can enumerate, because a rate-limited location is a domain
 * outcome rather than a crash. But a Lambda that returns normally is a *success*
 * to every metric AWS keeps: `Errors` stays flat, no alarm fires, and a cycle that
 * published nothing looks exactly like a cycle that published everything. So the
 * handler converts "some location did not publish" into a throw
 * (`docs/standards/error-handling.md` rule 5 — degrade honestly), which is the only
 * signal the platform actually watches.
 */

/** Emitted once at the end of every cycle, after each location's own entry. */
export const cycleSummaryEvent = 'ingestion.cycle.summary';

/** How much of the cycle failed, as the error carries it. */
export interface CycleFailureCounts {
  /** Locations that did not publish, for any reason. */
  readonly failed: number;
  /** Active locations the cycle set out to publish. */
  readonly total: number;
}

/**
 * Thrown when a cycle finished with any location unpublished.
 *
 * It carries the counts rather than only a message because the interesting
 * question in CloudWatch is which kind of failure this was: `1 of 12` is a location
 * having a bad hour, `12 of 12` is Open-Meteo, DynamoDB or the queue being down.
 * The message states both so the distinction survives into a log line, and the
 * fields keep it machine-readable for whatever alarms on it later.
 */
export class CycleFailedError extends Error {
  override readonly name = 'CycleFailedError';
  readonly failed: number;
  readonly total: number;

  constructor(counts: CycleFailureCounts) {
    super(
      `ingestion cycle failed: ${String(counts.failed)} of ${String(counts.total)} locations did not publish`,
    );
    this.failed = counts.failed;
    this.total = counts.total;
  }
}

/**
 * The handler's signature. The scheduled event payload is deliberately absent:
 * EventBridge's trigger carries nothing this cycle uses — what to fetch comes from
 * the fleet, not from the invocation — so accepting it would only invite someone to
 * start branching on it. The {@link CycleReport} is returned for the benefit of a
 * manual invoke; nothing consumes it in production.
 */
export type IngestionHandler = () => Promise<CycleReport>;

/**
 * The production log sink: one JSON object per line, which is what makes
 * CloudWatch Logs Insights able to query these entries by field instead of by
 * substring. `console.log` is correct *here* and nowhere else — this module is the
 * process boundary that `docs/standards/error-handling.md` rule 4 reserves it for,
 * and every module beneath it takes `log` as a dependency.
 */
export const jsonLineLog = (entry: Record<string, unknown>): void => {
  console.log(JSON.stringify(entry));
};

/**
 * Bind a cycle's dependencies into the handler AWS invokes.
 *
 * The summary is logged **before** the throw, and the throw happens only after
 * every location has been processed: a failed cycle must still leave behind the
 * full account of which locations worked, or the error tells an operator that
 * something broke while hiding what.
 */
export const createHandler =
  (deps: RunCycleDeps): IngestionHandler =>
  async () => {
    const report = await runCycle(deps);

    // The two skip counts are on the summary rather than only on the individual
    // outcomes because they are the line an operator reads first, and they mean
    // different things: `skippedForCap` says the fleet has outgrown the
    // Open-Meteo allowance this service budgets for, `skippedForDeadline` says
    // the cycle ran out of wall clock. Both are zero on every healthy cycle, so
    // either being non-zero is the signal (#115).
    deps.log({
      event: cycleSummaryEvent,
      activeLocations: report.activeLocations,
      published: report.published,
      failed: report.failed,
      skippedForCap: report.skippedForCap,
      skippedForDeadline: report.skippedForDeadline,
    });

    if (report.failed > 0) {
      throw new CycleFailedError({ failed: report.failed, total: report.activeLocations });
    }

    return report;
  };
