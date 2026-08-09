import {
  describeThrown,
  simulatedActualFromForecast,
  utcIsoTimestampSchema,
  type GenerationReading,
  type UtcIsoTimestamp,
  type UtcWindow,
} from '@cumulo/shared';
import type {
  BatchWriteOutcome,
  SeriesAdapter,
  SeriesPoint,
  SeriesRangeResult,
} from '@cumulo/storage';

/**
 * The trailing simulated-actuals producer: having stored a cycle's forecasts, look back over the
 * last few hours of each site's series and write the actuals those hours should have.
 *
 * The fleet is synthetic and has no metering feed, so an "actual" is manufactured from the physics
 * forecast that was stored for the same hour — `simulatedActualFromForecast` in `@cumulo/shared`
 * owns that derivation and the ±15 % draw it applies (#264). This module owns only *which* hours
 * get one, and the effects: one read of the trailing window per site, one batch write per site
 * that needs it.
 *
 * Two properties make this safe to run on every message rather than on a schedule:
 *
 * - **Idempotent.** The draw is deterministic in `(siteId, validTime)` and every write is a Put
 *   over `T#<validTime>#GEN` (ADR 0002), so re-running a window rewrites exactly the rows it wrote
 *   before. A redelivered message costs duplicate work and nothing else.
 * - **Self-healing.** The window is {@link TRAILING_ACTUALS_HOURS} wide rather than one hour, so a
 *   missed cycle, a rate-limited ingestion hour or a partial write is repaired by the next run
 *   instead of leaving a permanent hole in the series.
 *
 * `simulateTrailingActuals` does not reject for any failure of the series adapter or of one site's
 * plan: every per-site step is converted to an outcome value, because its caller is the record
 * boundary (`consume-message.ts`) and a throw crossing that boundary would fail a record whose
 * forecasts were already stored (`docs/standards/error-handling.md` rule 2a). What it does not
 * defend against is a broken composition root — an injected clock that throws is wiring that could
 * not have been assembled correctly, and that is a bug which should surface (rule 1).
 */

/**
 * How far back a run looks. Three hours rather than one so that a cycle missed for any reason —
 * a rate-limited ingestion hour, a Lambda that timed out, a drain DynamoDB declined — is repaired
 * by the next run rather than leaving a hole in the series.
 */
export const TRAILING_ACTUALS_HOURS = 3;

const MILLISECONDS_PER_HOUR = 3_600_000;

/**
 * The instant `hours` before `instant`, in the one timestamp form ADR 0002's range queries accept.
 *
 * `Date` is the arithmetic, never the clock: the input instant is supplied by the caller. The
 * result is parsed rather than asserted, so the fixed-width normalization and the brand cannot
 * disagree — `toISOString` always emits milliseconds and this domain's timestamps never carry
 * them (`timestamp.ts` explains why the width is load-bearing).
 *
 * A deliberate local copy of arithmetic other apps also do over their own read windows
 * (`apps/api`'s series window, `apps/web/src/data/http-fleet-data-source.ts`): apps may not import
 * apps (`docs/standards/architecture.md` rule 1), and the duplication is incidental — each
 * consumer's window is free to change without the others being wrong (`structure.md` rule 7).
 */
export const utcHoursBefore = (instant: UtcIsoTimestamp, hours: number): UtcIsoTimestamp =>
  utcIsoTimestampSchema.parse(
    new Date(Date.parse(instant) - hours * MILLISECONDS_PER_HOUR)
      .toISOString()
      .replace(/\.\d{3}Z$/u, 'Z'),
  );

/** The hours in a window that already hold a generation row, keyed by `validTime`. */
const hoursAlreadyActual = (points: readonly SeriesPoint[]): ReadonlySet<string> =>
  new Set(
    points.flatMap((point) => (point.type === 'generation' ? [point.reading.validTime] : [])),
  );

/**
 * The readings a window is missing: one per settled physics-forecast hour that has no actual yet.
 *
 * Pure, and separated from the effects around it so the three decisions it makes are testable as
 * plain input and output (`docs/standards/architecture.md` rule 3):
 *
 * - **Physics only.** The ML layer corrects the physics forecast; simulating an actual from the
 *   correction would make the ML error metric a measure of the draw rather than of the model.
 * - **Settled hours only.** `validTime` is hour-ending, so an hour whose end has not arrived has
 *   not happened, and no actual for it exists to be simulated. This is the guard that keeps the
 *   function total over *any* window a caller hands it — `querySeriesRange`'s upper bound is
 *   exclusive, so the live producer below could not deliver a future hour here, but the hindcast
 *   backfill (#264) plans over windows it assembles itself.
 * - **No overwrite.** An hour already carrying a generation row keeps it. Real metering would
 *   arrive as exactly such a row, and a simulated reading must never displace a measured one.
 *
 * Hours are compared as strings because these timestamps are fixed-width UTC, where lexicographic
 * order *is* chronological order — the same property ADR 0002's sort keys are built on.
 */
export const planSimulatedActuals = (
  points: readonly SeriesPoint[],
  now: UtcIsoTimestamp,
): GenerationReading[] => {
  const alreadyActual = hoursAlreadyActual(points);
  return points.flatMap((point) =>
    point.type === 'forecast' &&
    point.forecast.model === 'physics' &&
    point.forecast.validTime <= now &&
    !alreadyActual.has(point.forecast.validTime)
      ? [simulatedActualFromForecast(point.forecast)]
      : [],
  );
};

/**
 * The log event every per-site outcome is written under, exported so a test asserts on the name
 * the operator greps for rather than on a copy of it.
 */
export const simulatedActualsOutcomeEvent = 'forecast.actuals.outcome';

/**
 * What became of one site's trailing window, as a value.
 *
 * `up-to-date` is a success and is deliberately distinct from `written`: a site whose window is
 * already complete — the common case, since only the newest hour is usually missing — issues no
 * write at all, and an operator reading a run of them is reading a healthy fleet rather than a
 * producer that has stopped producing.
 */
export type SiteActualsOutcome = { readonly siteId: string } & (
  | { readonly status: 'written'; readonly readingCount: number }
  | { readonly status: 'up-to-date' }
  | { readonly status: 'store-partial'; readonly unprocessedCount: number }
  | { readonly status: 'failed'; readonly detail: string }
);

/**
 * The three steps of one site's simulation that can fail. A `failed` outcome names which, because
 * the next step differs (`docs/standards/error-handling.md` rule 4): a `querySeriesRange` or
 * `putGenerationReadings` throw is the series table, while a `planSimulatedActuals` throw is a bug
 * in the derivation — nothing an operator can fix in AWS.
 */
type SiteActualsOperation = 'querySeriesRange' | 'planSimulatedActuals' | 'putGenerationReadings';

/**
 * The collaborators a simulation run needs.
 *
 * `series` is narrowed to the two methods this producer uses, so the read it adds to a service
 * that previously only wrote series (`infra/forecast/iam.tf` carries the matching grant) is a
 * compile-time fact and not merely an IAM one. The adapter is passed whole rather than as
 * `adapter.querySeriesRange`: it holds its client and table name on `this`, so a detached method
 * would arrive already broken (`docs/standards/structure.md` rule 3).
 */
export interface SimulateActualsDeps {
  readonly series: Pick<SeriesAdapter, 'querySeriesRange' | 'putGenerationReadings'>;
  /** Structured-logging sink, injected — this module is below the composition root (rule 4). */
  readonly log: (entry: Record<string, unknown>) => void;
  /** The clock bounding the window, read once per run so every site sees the same window. */
  readonly now: () => UtcIsoTimestamp;
}

const failedOutcome = (
  siteId: string,
  operation: SiteActualsOperation,
  error: unknown,
): SiteActualsOutcome => ({
  siteId,
  status: 'failed',
  detail: `${operation} threw — ${describeThrown(error)}`,
});

/**
 * One site's window: read it, plan what is missing, write only if something is.
 *
 * The window arrives as a {@link UtcWindow} rather than as two timestamps, so its two same-shaped
 * bounds cannot be swapped at the call site. No pagination bound is passed: the window is at most
 * `TRAILING_ACTUALS_HOURS` hours of one site's series — a dozen points at the outside — which is
 * one Query page with room to spare, and a bound would introduce a `complete: false` case that
 * this caller has no better answer to than reading the whole thing.
 */
const simulateSiteActuals = async (
  deps: SimulateActualsDeps,
  siteId: string,
  window: UtcWindow,
): Promise<SiteActualsOutcome> => {
  let range: SeriesRangeResult;
  try {
    range = await deps.series.querySeriesRange(siteId, window.startInclusive, window.endExclusive);
  } catch (error: unknown) {
    return failedOutcome(siteId, 'querySeriesRange', error);
  }

  let readings: GenerationReading[];
  try {
    readings = planSimulatedActuals(range.points, window.endExclusive);
  } catch (error: unknown) {
    // The bug arm, and it is caught for one reason only: this runs beneath a record boundary that
    // must not fail a message whose forecasts are already stored. The outcome names the operation,
    // which is how an operator tells a derivation bug from a table (rule 2a).
    return failedOutcome(siteId, 'planSimulatedActuals', error);
  }

  if (readings.length === 0) {
    return { siteId, status: 'up-to-date' };
  }

  let stored: BatchWriteOutcome;
  try {
    stored = await deps.series.putGenerationReadings(readings);
  } catch (error: unknown) {
    return failedOutcome(siteId, 'putGenerationReadings', error);
  }

  if (stored.status === 'partial') {
    // `BatchWriteItem` answers HTTP 200 while handing back items it declined (ADR 0002
    // Consequence 4). Nothing retries here and nothing needs to: the next run's window still
    // covers this hour and will find it missing again.
    return { siteId, status: 'store-partial', unprocessedCount: stored.unprocessedCount };
  }

  return { siteId, status: 'written', readingCount: readings.length };
};

/**
 * Simulate the trailing window for every site named, sequentially, and log each outcome.
 *
 * Sequential rather than concurrent, and per-site failures converted rather than propagated, for
 * the reason `runLocation` in `apps/ingestion/src/cycle.ts` is written the same way: these sites
 * share one table's capacity, and one site's rejection must not abandon its siblings — a fan-out
 * that failed fast would leave the remaining sites' hours to a later run for no benefit.
 *
 * Each outcome is logged as it is decided, so a run killed mid-way has still said what it did for
 * the sites it reached. The returned array is the same information as a value, for a caller that
 * wants to count rather than read.
 */
export const simulateTrailingActuals = async (
  deps: SimulateActualsDeps,
  siteIds: readonly string[],
): Promise<SiteActualsOutcome[]> => {
  const endExclusive = deps.now();
  const window: UtcWindow = {
    startInclusive: utcHoursBefore(endExclusive, TRAILING_ACTUALS_HOURS),
    endExclusive,
  };

  const outcomes: SiteActualsOutcome[] = [];
  for (const siteId of siteIds) {
    const outcome = await simulateSiteActuals(deps, siteId, window);
    deps.log({ event: simulatedActualsOutcomeEvent, ...outcome });
    outcomes.push(outcome);
  }
  return outcomes;
};
