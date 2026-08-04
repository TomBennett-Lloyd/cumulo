import { createPhysicsForecast, type PhysicsParams } from '@cumulo/forecast';
import {
  PERSISTENCE_24H,
  alignByValidTime,
  errorMetricsSchema,
  meanAbsoluteErrorKw,
  persistenceBaselineSeries,
  rootMeanSquareErrorKw,
  skillScore,
  type ErrorMetrics,
  type GenerationReading,
  type GeoCoordinates,
  type Site,
  type TimedPowerPoint,
  type UtcIsoTimestamp,
  type UtcWindow,
  type WeatherReading,
} from '@cumulo/shared';

import { utcDaysCovering, type UtcDay } from './archive-days';
import {
  ensureArchiveCoverage,
  type ArchiveCoverageDeps,
  type ArchiveCoverageOutcome,
  type ArchiveDayStore,
} from './archive-cache';

/**
 * The hindcast itself: what the physics model *would* have said about a past
 * period, scored against what the site actually generated.
 *
 * The whole run is a straight replay — archive weather in, the same
 * `createPhysicsForecast` production calls out (ADR 0003: the physics is an
 * in-process function over typed inputs precisely so a season of site-hours is a
 * loop rather than a service). Nothing here re-implements the model, which is
 * what makes the resulting metrics a measurement of the *deployed* forecast
 * rather than of a sibling of it.
 *
 * Two properties are load-bearing and both come from keeping this function pure
 * of ambient state:
 * - **`issuedAt` is a parameter, never a clock read.** A hindcast issues a
 *   forecast for an hour that is already past, which `forecastSchema` explicitly
 *   permits; reading a clock here would make the run unreproducible and its
 *   `computedAt` a fact about when someone happened to type the command.
 * - **Everything effectful arrives in `deps`.** The archive cache, the reading
 *   store and the metrics sink are all injected as objects, so the entire chain
 *   below runs in a unit test against a `Map` with no AWS in the graph
 *   (`docs/standards/architecture.md` rules 3 and 7).
 *
 * Order matters once, and it is the order below: coverage is settled *before*
 * anything is computed. A window whose coverage could not be **established** —
 * storage could not say what is cached, or the quota ran out mid-backfill —
 * writes no metrics at all, because scoring whichever hours happened to already
 * be cached is exactly the quiet corruption
 * `docs/standards/error-handling.md` rule 5 exists to prevent.
 *
 * A window whose coverage *was* established but has holes in it — days
 * Open-Meteo has no whole day of data for — is a different case and does
 * publish: those days are absent from the archive rather than absent from this
 * run, asking again now changes nothing, and refusing to score a season because
 * one day is missing would be its own dishonesty. The holes come back in the
 * outcome's `coverage.unavailableDays`. They are **not** recorded on the metrics
 * row itself, so a later reader of `cumulo-metrics` cannot see them — a
 * schema-level gap logged in `docs/tech-debt.md` rather than papered over here.
 */

/**
 * The archive *reading* surface of the `cumulo-weather` table — the half
 * {@link ArchiveDayStore} deliberately leaves out, because backfill never reads
 * weather back and the replay never writes it.
 *
 * Declared here as the consumer's half of the contract, for the same reason
 * `archive-cache.ts` declares its own: this package's library code depends on no
 * AWS-bearing adapter, and the real `WeatherAdapter` is checked against these
 * ports by the compiler where the two actually meet — the operator CLI in
 * `scripts/`, which passes one in.
 */
export interface ArchiveReadingStore {
  queryArchiveRange(
    coords: GeoCoordinates,
    fromInclusive: UtcIsoTimestamp,
    toExclusive: UtcIsoTimestamp,
  ): Promise<WeatherReading[]>;
}

/**
 * One object, both archive surfaces. A hindcast covers days and then reads them
 * back, and in production those are two methods on the *same* `WeatherAdapter`
 * instance — splitting them across two injected objects would let a caller wire
 * a run that fetched into one table and scored against another.
 */
export type HindcastWeatherStore = ArchiveDayStore & ArchiveReadingStore;

/**
 * Where a finished evaluation goes — `MetricsAdapter.putMetrics` in production,
 * narrowed to the one method a hindcast is allowed to call. The run writes
 * metrics and never reads them back, and saying so in the type makes that a
 * compile-time fact rather than a convention.
 */
export interface MetricsSink {
  putMetrics(metrics: ErrorMetrics): Promise<void>;
}

/**
 * Everything {@link runHindcast} needs, as an extension of the coverage step's
 * own deps rather than a second, coincidentally similar shape
 * (`docs/standards/typing.md` rule 6). The `extends` is what lets this object be
 * handed to `ensureArchiveCoverage` unchanged: the two are the same contract,
 * one of them with more in it.
 *
 * Adapters are injected as whole objects, never as `adapter.queryArchiveRange`:
 * the real ones hold their client and table name on `this`, so a detached method
 * would arrive here already broken (`docs/standards/architecture.md` rule 7).
 */
export interface HindcastDeps extends ArchiveCoverageDeps {
  readonly weatherAdapter: HindcastWeatherStore;
  readonly metricsAdapter: MetricsSink;
}

/** One evaluation request: which site, over which window, against which actuals. */
export interface HindcastInput {
  readonly site: Site;
  /** The half-open window the metrics are keyed by *and* fetched for. */
  readonly period: UtcWindow;
  /**
   * The site's observed generation. Deliberately **not** restricted to `period`:
   * the persistence baseline for the window's first day is built from the day
   * before it, so passing a period's worth of readings and passing a period's
   * worth plus its run-up are two different (and both legitimate) runs.
   */
  readonly observations: readonly GenerationReading[];
  /** Forecast vintage and `computedAt` for the metrics row. A parameter, never a clock read. */
  readonly issuedAt: UtcIsoTimestamp;
  /** Model-constant overrides; anything omitted comes from `defaultPhysicsParams`. */
  readonly params?: Partial<PhysicsParams>;
}

/**
 * What the run cost and how complete its inputs were, alongside the numbers.
 *
 * Counts rather than day lists for the two large fields — a two-year backfill
 * cached 730 days and nobody wants them printed — but `unavailableDays` stays a
 * list, because those are the days the metrics are *missing*, and an operator
 * deciding whether to trust a skill score needs to see which ones.
 */
export interface HindcastCoverage {
  readonly alreadyCached: number;
  readonly fetched: number;
  readonly unavailableDays: readonly UtcDay[];
  /**
   * The archived hours the physics refused to forecast — schema-valid weather no
   * atmosphere produces (`createPhysicsForecast`'s `implausible` result). Listed
   * for the same reason `unavailableDays` is: these hours are missing from the
   * score, `sampleCount` already shrank truthfully, and an operator deciding
   * whether to trust the skill score needs to see *which* hours went missing and
   * why. Like `unavailableDays`, they are **not** on the metrics row itself.
   */
  readonly implausibleHours: readonly UtcIsoTimestamp[];
  readonly apiCallCount: number;
}

/**
 * The coverage outcomes that stop a hindcast, as a type rather than as a note in
 * a comment: `ready` is the only one this module proceeds from, so an
 * `archive-incomplete` result that claimed to carry one would be a state nobody
 * can produce and every reader has to consider.
 */
export type IncompleteArchiveCoverage = Exclude<ArchiveCoverageOutcome, { status: 'ready' }>;

/**
 * Every way a hindcast can end (`docs/standards/typing.md` rule 4). Only
 * `complete` has written anything: the other two are decisions not to compute,
 * and both leave the metrics table exactly as they found it.
 */
export type HindcastOutcome =
  | {
      readonly status: 'complete';
      readonly metrics: ErrorMetrics;
      readonly coverage: HindcastCoverage;
    }
  | { readonly status: 'no-observations' }
  | { readonly status: 'archive-incomplete'; readonly detail: IncompleteArchiveCoverage };

const withinPeriod = (period: UtcWindow, validTime: UtcIsoTimestamp): boolean =>
  validTime >= period.startInclusive && validTime < period.endExclusive;

/**
 * Refuses a run whose observations are not the site's.
 *
 * A violated invariant, not a domain outcome (`docs/standards/error-handling.md`
 * rule 1), and worth checking rather than assuming: the operator CLI takes the
 * site and the actuals from two separate files, and the wrong pairing would
 * score one site's model against another's roof and publish the result under the
 * first site's id — a wrong number that looks exactly like a right one.
 */
const requireObservationsOfSite = (
  site: Site,
  observations: readonly GenerationReading[],
): void => {
  const foreign = observations.find((reading) => reading.siteId !== site.id);
  if (foreign !== undefined) {
    throw new Error(
      `runHindcast: site ${site.id} was given an observation for site ${foreign.siteId}`,
    );
  }
};

/** The replayed hours worth scoring, and the ones the physics would not produce. */
interface ArchiveReplay {
  readonly scored: TimedPowerPoint[];
  readonly implausibleHours: readonly UtcIsoTimestamp[];
}

/**
 * Run every archived hour through the production physics call, keeping the hours it
 * forecast and noting the ones it refused.
 *
 * Skipping rather than aborting is this consumer's answer to "who does the operator
 * need to call?" (`docs/standards/error-handling.md` rule 1). A hindcast replays
 * offline over a season and has no queue to redeliver into: aborting a 730-day run
 * because one archived hour is physically implausible would throw away every other
 * hour's evidence, and the run is a measurement, not a write path. The skipped hours
 * ride out in the coverage, so the shrunken `sampleCount` has a stated cause.
 */
const replayArchive = (
  input: HindcastInput,
  archivedHours: readonly WeatherReading[],
): ArchiveReplay => {
  const scored: TimedPowerPoint[] = [];
  const implausibleHours: UtcIsoTimestamp[] = [];

  for (const weather of archivedHours) {
    // `params` is spread over `defaultPhysicsParams` downstream, so an absent
    // override and an empty one are the same run — which is why this can be a
    // `??` rather than a conditional key under `exactOptionalPropertyTypes`.
    const result = createPhysicsForecast({
      site: input.site,
      weather,
      issuedAt: input.issuedAt,
      params: input.params ?? {},
    });
    if (result.status === 'implausible') {
      implausibleHours.push(result.validTime);
    } else {
      scored.push(result.forecast);
    }
  }

  return { scored, implausibleHours };
};

/**
 * RMSE of the persistence baseline over the same instants the model is scored
 * on, or `null` when the baseline reaches none of them.
 *
 * `null` rather than 0 because the two mean opposite things: 0 is a baseline
 * that was perfect, `null` is a baseline that had nothing to say (a one-day
 * period with no run-up, so every shifted point lands outside the window).
 * `skillScore` already treats a zero-error baseline as undefined, so both cases
 * end as a `null` skill score — but only by two different arguments, and
 * collapsing them here would hide one of them.
 */
const baselineRmseKw = (
  observations: readonly GenerationReading[],
  scoredHours: readonly TimedPowerPoint[],
): number | null => {
  const pairs = alignByValidTime(persistenceBaselineSeries(observations), scoredHours);
  return pairs.length === 0 ? null : rootMeanSquareErrorKw(pairs);
};

/**
 * Replay one site over one past period and publish what the model got wrong.
 *
 * The chain, each step a consequence of the one above it:
 * 1. **Cover the archive** for every UTC day the period touches. Anything other
 *    than `ready` returns `archive-incomplete` having written nothing — see the
 *    module comment for why a partial window is worse than no answer.
 * 2. **Read the archive back** over the period's own bounds, so the hours scored
 *    are the hours the metrics row claims, not whole days spilling past its
 *    edges.
 * 3. **Replay** each hour through `createPhysicsForecast` — the production call,
 *    with the caller's `issuedAt` and model params. An hour it reports
 *    `implausible` for is skipped rather than scored, and named in the coverage.
 * 4. **Align** the replay against the in-period observations. `alignByValidTime`
 *    is an inner join, so an hour the archive has and the site does not (or the
 *    reverse) simply contributes no pair; no pairs at all means there is nothing
 *    to score, which is `no-observations` rather than a metrics row of zeroes.
 * 5. **Score and publish.** The baseline is built from *all* the input
 *    observations and then aligned back onto the in-period hours, which is what
 *    lets the window's first day be scored against the day before it.
 *
 * Two kinds of failure, split by whether this run can act on it
 * (`docs/standards/error-handling.md` rule 1). A `StorageError` from either
 * adapter is an outage and a `ZodError` from `errorMetricsSchema` means the
 * metrics are not storable: neither is something a hindcast can do anything with,
 * so both propagate and stop the run loudly instead of publishing a partial truth.
 * A physically implausible archive hour is the other kind — `createPhysicsForecast`
 * reports it as a value, and step 3 skips it, because throwing away a season's
 * evidence over one impossible hour would be its own dishonesty. Those hours come
 * back in `coverage.implausibleHours`, on the same terms as `unavailableDays`.
 */
export const runHindcast = async (
  deps: HindcastDeps,
  input: HindcastInput,
): Promise<HindcastOutcome> => {
  const { site, period, observations, issuedAt } = input;
  requireObservationsOfSite(site, observations);

  const coverage = await ensureArchiveCoverage(deps, site, utcDaysCovering(period));
  if (coverage.status !== 'ready') {
    return { status: 'archive-incomplete', detail: coverage };
  }

  const archivedHours = await deps.weatherAdapter.queryArchiveRange(
    site,
    period.startInclusive,
    period.endExclusive,
  );

  const replay = replayArchive(input, archivedHours);

  const scoredHours = observations.filter((reading) => withinPeriod(period, reading.validTime));
  const pairs = alignByValidTime(replay.scored, scoredHours);
  if (pairs.length === 0) {
    // A window whose *every* hour was implausible lands here too, and reports
    // `no-observations` — which under-describes the cause, since the actuals may
    // have been fine. Accepted rather than widened into a fourth outcome: the case
    // has never been seen, the metrics table is left untouched either way, and the
    // extra arm would have to be considered by every reader of this union forever.
    return { status: 'no-observations' };
  }

  const rmseKw = rootMeanSquareErrorKw(pairs);
  const baselineRmse = baselineRmseKw(observations, scoredHours);

  const metrics = errorMetricsSchema.parse({
    siteId: site.id,
    model: 'physics',
    period,
    baseline: PERSISTENCE_24H,
    maeKw: meanAbsoluteErrorKw(pairs),
    rmseKw,
    skillScore:
      baselineRmse === null
        ? null
        : skillScore({ modelRmseKw: rmseKw, baselineRmseKw: baselineRmse }),
    sampleCount: pairs.length,
    computedAt: issuedAt,
  });

  await deps.metricsAdapter.putMetrics(metrics);

  return {
    status: 'complete',
    metrics,
    coverage: {
      alreadyCached: coverage.alreadyCached.length,
      fetched: coverage.fetched.length,
      unavailableDays: coverage.unavailableDays,
      implausibleHours: replay.implausibleHours,
      apiCallCount: coverage.apiCallCount,
    },
  };
};
