/**
 * Operator CLI: a one-off backfill of simulated actuals across the forecast
 * history already sitting in `cumulo-series`.
 *
 * Why this exists. The trailing producer in `src/simulate-actuals.ts` fills a
 * few hours behind each forecast cycle, which keeps the series honest from the
 * moment it is deployed and no earlier. The dashboard's look-back windows go
 * back a week, so on day one every hour older than the deploy would plot a
 * forecast line with nothing to compare it against. This script walks the
 * physics forecasts that were already stored over a past window and writes the
 * actuals those settled hours should have had — once, by hand, after a deploy.
 *
 * It is the *composition root* for that run, in the same shape as
 * `packages/hindcast/scripts/run-hindcast.ts` and for the same reasons. Which
 * tables the adapters address, what clock bounds the window, how wide the
 * window is: all of that is decided here and nowhere below. The planning itself
 * is `planSimulatedActuals`, which is pure and already unit-tested — this file
 * adds only the effects around it.
 *
 * Why it is not a test. It needs an operator's AWS session and it writes to real
 * tables, so it is deliberately absent from `pnpm test` and from the root
 * `pnpm verify` gate, which runs in CI where the OIDC role holds no DynamoDB
 * permissions by design. It *is* covered by `pnpm typecheck` — the package
 * tsconfig includes `scripts` — so it cannot rot silently against the adapters
 * it wires together.
 *
 * Usage:
 *
 *   AWS_PROFILE=… CUMULO_ENV=dev pnpm --filter @cumulo/forecast-service \
 *     backfill-actuals -- --hours 336
 *
 * **Run it off-peak.** Every site's window is one batched write against
 * `cumulo-series`, and that table's write capacity is #258's territory: an
 * on-demand flip is in flight on another branch, and until it merges the table
 * is provisioned at 14 WCU and the throttle alarm will fire if this run collides
 * with an ingestion cycle. A site reported `partial` is safely re-runnable —
 * every Put is deterministic in `(siteId, validTime)` and idempotent, so a
 * second pass rewrites exactly the rows it wrote before and fills the rest.
 *
 * **Fewer rows than `--hours` is the normal answer, not a failure.** An actual
 * can only be synthesized for an hour that already holds a physics forecast, so
 * a fleet whose live history is shorter than the window asked for yields
 * whatever history it has. So does a site added yesterday.
 */

import { parseArgs } from 'node:util';

import {
  describeThrown,
  utcIsoTimestampSchema,
  type GenerationReading,
  type UtcIsoTimestamp,
  type UtcWindow,
} from '@cumulo/shared';
import {
  SERIES_RETENTION_DAYS,
  SeriesAdapter,
  SiteAdapter,
  createStorageDocumentClient,
  storageTableName,
} from '@cumulo/storage';
import { z } from 'zod';

import { planSimulatedActuals, utcHoursBefore } from '../src/simulate-actuals';

const USAGE =
  'Usage: AWS_PROFILE=… CUMULO_ENV=dev pnpm --filter @cumulo/forecast-service ' +
  'backfill-actuals -- --hours 336';

/** Which set of tables to talk to — `cumulo-<table>-<environment>`, as `src/main.ts` does. */
const ENVIRONMENT = process.env.CUMULO_ENV ?? 'dev';

const HOURS_PER_DAY = 24;

/**
 * The widest window a run may ask for: the whole of what the series table keeps.
 *
 * Computed from the retention `@cumulo/storage` owns rather than written down as
 * its own number (`docs/standards/architecture.md` rule 9). Hours older than the
 * TTL horizon hold no forecast rows to plan from — DynamoDB has already deleted
 * them — so a larger request could only buy round trips.
 */
const MAX_BACKFILL_HOURS = SERIES_RETENTION_DAYS * HOURS_PER_DAY;

/**
 * Two weeks when `--hours` is omitted: comfortably wider than the longest range
 * the dashboard's picker offers (`RangeHours` in
 * `apps/web/src/data/fleet-data-source.ts`), so the default fills every window a
 * visitor can select with slack to spare. This is the script's own choice and
 * nothing else reads it.
 */
const DEFAULT_BACKFILL_DAYS = 14;

/**
 * `--hours` as an operator types it: digits, then the range check.
 *
 * The regex is what distinguishes this from a bare `Number.parseInt`, which
 * would read `12h` as 12 and silently back-fill a window the operator did not
 * ask for.
 */
const hoursSchema = z
  .string()
  .regex(/^\d+$/u)
  .transform((digits) => Number.parseInt(digits, 10))
  .pipe(z.number().int().min(1).max(MAX_BACKFILL_HOURS));

/**
 * A throw rather than a value: an unusable `--hours` is an operator who has not
 * finished typing the command, not an outcome a backfill could report
 * (`docs/standards/error-handling.md` rule 1). The usage line rides along so the
 * fix arrives in the same message as the complaint.
 */
const parseHours = (raw: string | undefined): number => {
  if (raw === undefined) {
    return DEFAULT_BACKFILL_DAYS * HOURS_PER_DAY;
  }
  const parsed = hoursSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `--hours must be a whole number of hours from 1 to ${String(MAX_BACKFILL_HOURS)}, ` +
        `not '${raw}'\n${USAGE}`,
    );
  }
  return parsed.data;
};

/**
 * The one clock read in the whole run, here at the edge, and handed downwards as
 * data. Fixed-width to the second because ADR 0002's range queries rely on
 * lexicographic order being chronological and `toISOString()`'s milliseconds
 * break that; parsed rather than asserted, so the normalizing regex and the
 * brand cannot disagree. The same three lines every composition root in this
 * repo opens with (`src/main.ts`, `apps/api/src/main.ts`).
 */
const nowUtc = (): UtcIsoTimestamp =>
  utcIsoTimestampSchema.parse(new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z'));

/**
 * What became of one site's window, as a value.
 *
 * `up-to-date` is a success and stays distinct from `written`: a site that was
 * already backfilled, or one whose history holds no settled physics hour, issues
 * no write at all, and an operator re-running the command wants to read that as
 * a healthy no-op rather than as nothing having happened.
 */
type SiteBackfillOutcome = { readonly siteId: string } & (
  | { readonly status: 'written'; readonly readingCount: number }
  | { readonly status: 'up-to-date' }
  | { readonly status: 'partial'; readonly unprocessedCount: number }
  | { readonly status: 'failed'; readonly detail: string }
);

/**
 * One site: read its window, plan the actuals it is missing, write them if there
 * are any.
 *
 * No pagination bound is passed to `querySeriesRange`. The bound exists for
 * callers with a deadline — the API's request handlers — and this one has none;
 * a window truncated part-way through would leave holes exactly where the run
 * claimed to have filled them.
 *
 * The `catch` converts rather than propagates (`error-handling.md` rule 2a) for
 * the reason `runLocation` in `apps/ingestion/src/cycle.ts` is written the same
 * way: these sites share one table's capacity, and one site's rejection must not
 * abandon its siblings. The verdict is not lost — a failed site is named on its
 * own line and fails the process's exit code. `describeThrown` is enough detail
 * here because a `StorageError` already carries the operation and the table in
 * its message (`error-handling.md` rule 4).
 */
const backfillSite = async (
  series: SeriesAdapter,
  siteId: string,
  window: UtcWindow,
): Promise<SiteBackfillOutcome> => {
  try {
    const range = await series.querySeriesRange(siteId, window.startInclusive, window.endExclusive);
    const readings: GenerationReading[] = planSimulatedActuals(range.points, window.endExclusive);

    if (readings.length === 0) {
      return { siteId, status: 'up-to-date' };
    }

    const stored = await series.putGenerationReadings(readings);
    return stored.status === 'partial'
      ? { siteId, status: 'partial', unprocessedCount: stored.unprocessedCount }
      : { siteId, status: 'written', readingCount: readings.length };
  } catch (error: unknown) {
    return { siteId, status: 'failed', detail: describeThrown(error) };
  }
};

const describeOutcome = (outcome: SiteBackfillOutcome): string => {
  switch (outcome.status) {
    case 'written':
      return `written: ${String(outcome.readingCount)} reading(s)`;
    case 'up-to-date':
      return 'up-to-date';
    case 'partial':
      return `partial: ${String(outcome.unprocessedCount)} unprocessed — re-run to finish`;
    case 'failed':
      return `FAILED: ${outcome.detail}`;
  }
};

/** True when the run has something an operator must act on, which is also the exit code. */
const needsAttention = (outcome: SiteBackfillOutcome): boolean =>
  outcome.status === 'partial' || outcome.status === 'failed';

const reportTotals = (outcomes: readonly SiteBackfillOutcome[]): void => {
  const readingsWritten = outcomes.reduce(
    (total, outcome) => total + (outcome.status === 'written' ? outcome.readingCount : 0),
    0,
  );
  const count = (status: SiteBackfillOutcome['status']): string =>
    String(outcomes.filter((outcome) => outcome.status === status).length);

  console.log(
    `Totals        ${count('written')} written, ${count('up-to-date')} up-to-date, ` +
      `${count('partial')} partial, ${count('failed')} failed`,
  );
  console.log(`Readings      ${String(readingsWritten)} simulated actual(s) stored`);
};

const client = createStorageDocumentClient();

try {
  const { values } = parseArgs({ options: { hours: { type: 'string' } } });
  const hours = parseHours(values.hours);

  const endExclusive = nowUtc();
  // A `UtcWindow` rather than two loose timestamps, so two same-shaped bounds
  // cannot be swapped at the call site below.
  const window: UtcWindow = {
    startInclusive: utcHoursBefore(endExclusive, hours),
    endExclusive,
  };

  /**
   * The adapters go in as whole objects, never as `adapter.querySeriesRange`:
   * they hold their client and table name on `this`, so a detached method would
   * arrive already broken (`docs/standards/structure.md` rule 3). One document
   * client for both — a shared connection pool, and one place the storage
   * failure policy is set. `SeriesAdapter` is left to its `defaultBatchPolicy`:
   * the drain's 25-item pages and backoff are `@cumulo/storage`'s decision, and
   * an operator run has no deadline that would argue for a different one.
   */
  const sites = new SiteAdapter({ client, tableName: storageTableName('sites', ENVIRONMENT) });
  const series = new SeriesAdapter({ client, tableName: storageTableName('series', ENVIRONMENT) });

  // The whole fleet, inactive sites included: a site switched off yesterday
  // still lived through the hours in this window, and its stored forecasts are
  // what the dashboard plots when someone opens it.
  const fleet = await sites.listFleetSites();

  console.log(
    `Backfill: environment '${ENVIRONMENT}', ${String(fleet.length)} site(s), ` +
      `${window.startInclusive} .. ${window.endExclusive} (${String(hours)} h)`,
  );

  // Sequentially, for the reason the trailing producer runs sequentially: these
  // sites share one table's write capacity, and a fan-out would spend it all at
  // once against the very alarm this run is meant to stay clear of.
  const outcomes: SiteBackfillOutcome[] = [];
  for (const site of fleet) {
    const outcome = await backfillSite(series, site.id, window);
    // Printed as it is decided, so a run killed part-way has still said what it
    // did for the sites it reached.
    console.log(`  ${site.id}  ${describeOutcome(outcome)}`);
    outcomes.push(outcome);
  }

  reportTotals(outcomes);
  process.exitCode = outcomes.some(needsAttention) ? 1 : 0;
} catch (error: unknown) {
  // The top-level boundary (`docs/standards/error-handling.md` rule 2c): a bad
  // argument, a missing table, an expired session or a `listFleetSites` outage
  // all land here and fail the process. Per-site failures never reach it — they
  // are values, and the loop above already reported them.
  console.error(`FAIL  backfill could not run — ${describeThrown(error)}`);
  process.exitCode = 1;
} finally {
  client.destroy();
}
