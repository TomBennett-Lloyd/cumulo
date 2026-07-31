import { locationId, type GeoCoordinates } from '@cumulo/shared';

import { contiguousDayRuns, type UtcDay } from './archive-days';
import {
  MAX_ARCHIVE_REQUEST_DAYS,
  type ArchiveFetchResult,
  type ArchiveWeatherReading,
} from './open-meteo-archive';

/**
 * The quota guard between a hindcast window and Open-Meteo's archive: given the
 * days a hindcast needs, fetch **only** the ones storage has no day marker for,
 * and fetch them in as few requests as the provider's range limit allows.
 *
 * This module is the reason CLAUDE.md's "API frugality by design" is a property
 * of the data model rather than of anybody's diligence. Two rules do the work,
 * and both live here:
 * - a day is requested only when its marker is absent (`listFetchedArchiveDays`);
 * - a marker is written only with a whole day of readings, in `putArchiveDay`'s
 *   single transaction — so "this day has been fetched" can never be true of a
 *   day whose readings are not there, and re-running a backfill over a window
 *   already covered costs zero calls. `archive-cache.test.ts` proves that
 *   mechanically rather than by inspection.
 *
 * Nothing here is a factory or a client: `ensureArchiveCoverage` is a function of
 * its arguments, with its two collaborators handed to it
 * (`docs/standards/structure.md` rules 1–2), matching `fetchArchiveDays`.
 */

/**
 * Three-way answer to "which of these days has the archive fetch already
 * covered?" — the shape `@cumulo/storage`'s `WeatherAdapter.listFetchedArchiveDays`
 * returns, declared here as the *consumer's* half of the contract.
 *
 * Declared rather than imported because no module under `src/` imports
 * `@cumulo/storage`: that package is an AWS-SDK-bearing adapter layer, and this
 * one is offline orchestration over pure day math
 * (`docs/standards/architecture.md` rule 3). Inverting the dependency keeps every
 * test in this package runnable against a `Map` with no SDK in the graph, and the
 * real adapter is checked against {@link ArchiveDayStore} by the compiler at the
 * one place the two meet — `scripts/run-hindcast.ts`, the operator entry point,
 * which is the package's only importer of `@cumulo/storage` and passes a real
 * `WeatherAdapter` in. This is the port half of one contract, not a second definition of it: there
 * is no second implementation of these semantics anywhere, and if the adapter's
 * answer changed shape, that wiring site would stop compiling.
 *
 * `undetermined` is its own case for the reason the adapter documents: a day
 * DynamoDB never answered for is *unknown*, and guessing costs either quota
 * (treat as unfetched) or data (treat as fetched).
 */
export type ArchiveDayCoverage =
  | { readonly status: 'complete'; readonly fetched: ReadonlySet<UtcDay> }
  | {
      readonly status: 'incomplete';
      readonly fetched: ReadonlySet<UtcDay>;
      readonly undeterminedDays: readonly UtcDay[];
    };

/**
 * The archive-day surface of the `cumulo-weather` table, narrowed to what
 * backfill uses: ask which days are covered, store a covered day. The reading
 * path (`queryArchiveRange`) is not here because this module never reads weather
 * back — the hindcast replay does, with the adapter it already holds.
 */
export interface ArchiveDayStore {
  listFetchedArchiveDays(
    coords: GeoCoordinates,
    days: readonly UtcDay[],
  ): Promise<ArchiveDayCoverage>;
  putArchiveDay(day: UtcDay, readings: readonly ArchiveWeatherReading[]): Promise<void>;
}

/**
 * One archive HTTP request, with the request policy already bound —
 * `fetchArchiveDays` partially applied over its `ArchiveFetchDeps`.
 *
 * Function-typed rather than an object with a `fetchArchiveDays` method, and
 * bound rather than taking the deps through: this module has no opinion about
 * timeouts or which `fetch` implementation is in play, and a signature that
 * cannot express one is the clearest way to say so.
 */
export type FetchArchiveRun = (
  coords: GeoCoordinates,
  firstDay: UtcDay,
  lastDay: UtcDay,
) => Promise<ArchiveFetchResult>;

/**
 * The two collaborators {@link ensureArchiveCoverage} needs, as one named type
 * so a second entry point wanting the same pair is visibly the same rather than
 * accidentally alike (`docs/standards/typing.md` rule 6).
 *
 * The store is injected as an **object**, not as two detached methods: a method
 * pulled off a class instance loses its `this`
 * (`docs/standards/architecture.md` rule 7).
 */
export interface ArchiveCoverageDeps {
  readonly weatherAdapter: ArchiveDayStore;
  readonly fetchArchiveRun: FetchArchiveRun;
}

/**
 * What a coverage attempt achieved, as a value rather than a throw
 * (`docs/standards/error-handling.md` rule 1). The caller's next move differs
 * per case, which is why these are three cases and not one bag of optionals:
 *
 * - `ready` — coverage is as complete as the archive allows. `unavailableDays`
 *   is still `ready`: those days are ones Open-Meteo has no whole day of data
 *   for, and no amount of asking again *now* changes that. They carry no marker,
 *   so a later run retries them; whether a hindcast over a window with holes in
 *   it is worth computing is the caller's judgement, not this function's
 *   (`docs/standards/error-handling.md` rule 5 — the hole is reported, never
 *   filled).
 * - `coverage-unknown` — storage could not say what is cached, so nothing was
 *   fetched at all. Retry when DynamoDB is answering again.
 * - `rate-limited` — the quota is spent. Everything in `fetched` is durably
 *   stored, and `remainingDays` is what the next scheduled run picks up.
 *
 * `apiCallCount` counts archive *requests* issued, which is what this module
 * controls. Open-Meteo bills a long range as several weighted calls (see
 * `MAX_ARCHIVE_REQUEST_DAYS`), so it is a lower bound on quota spent, not the
 * quota figure itself.
 */
export type ArchiveCoverageOutcome =
  | {
      readonly status: 'ready';
      readonly alreadyCached: readonly UtcDay[];
      readonly fetched: readonly UtcDay[];
      readonly unavailableDays: readonly UtcDay[];
      readonly apiCallCount: number;
    }
  | { readonly status: 'coverage-unknown'; readonly undeterminedDays: readonly UtcDay[] }
  | {
      readonly status: 'rate-limited';
      readonly fetched: readonly UtcDay[];
      readonly remainingDays: readonly UtcDay[];
      readonly apiCallCount: number;
    };

/**
 * Make sure every day in `days` is either cached in `cumulo-weather` or known to
 * be unavailable, fetching the gaps and nothing else.
 *
 * Order of operations, each step load-bearing:
 * 1. **Ask storage first.** An `incomplete` coverage answer returns
 *    `coverage-unknown` having fetched *nothing* — not even the days that were
 *    definitely absent. Half a backfill against an unknown cache is how the same
 *    day gets fetched twice, and the run is cheap to repeat once storage is
 *    healthy.
 * 2. **Group the misses into contiguous runs**, capped at
 *    {@link MAX_ARCHIVE_REQUEST_DAYS} — the frugality step, turning hundreds of
 *    missing days into tens of requests.
 * 3. **Fetch sequentially.** No parallel fan-out: Open-Meteo allows 600 calls a
 *    minute (CLAUDE.md) and backfill is not time-critical, so concurrency here
 *    would buy minutes and risk tripping the very limit that stops the run. It
 *    also makes "stop on the first rate limit" mean something — a fan-out would
 *    already have spent the calls it was going to spend.
 *
 * Each complete day is stored as it arrives rather than after the whole run, so
 * a rate limit mid-backfill leaves everything before it durably cached and
 * marked. A `rejected` result throws: the request is built from constants and a
 * day range this module computed, so a refusal means a bug or a moved provider
 * contract, and repeating it verbatim could only fail identically. A
 * `StorageError` from `putArchiveDay` propagates for the same reason — it is an
 * outage, not an outcome backfill can act on.
 */
export const ensureArchiveCoverage = async (
  deps: ArchiveCoverageDeps,
  coords: GeoCoordinates,
  days: readonly UtcDay[],
): Promise<ArchiveCoverageOutcome> => {
  // Sorted and de-duplicated once, here, so every list this function returns is
  // in calendar order regardless of what order the caller's window produced.
  const requestedDays = [...new Set(days)].sort();

  const coverage = await deps.weatherAdapter.listFetchedArchiveDays(coords, requestedDays);
  if (coverage.status === 'incomplete') {
    return { status: 'coverage-unknown', undeterminedDays: [...coverage.undeterminedDays] };
  }

  const alreadyCached = requestedDays.filter((day) => coverage.fetched.has(day));
  const missingDays = new Set(requestedDays.filter((day) => !coverage.fetched.has(day)));

  const storedDays: UtcDay[] = [];
  const unavailableDays: UtcDay[] = [];
  let apiCallCount = 0;

  for (const run of contiguousDayRuns([...missingDays], MAX_ARCHIVE_REQUEST_DAYS)) {
    const result = await deps.fetchArchiveRun(coords, run.firstDay, run.lastDay);
    apiCallCount += 1;

    if (result.status === 'rate-limited') {
      const stored = new Set(storedDays);
      // Days the provider called incomplete are *not* excluded here: they carry
      // no marker either, so the next run has to look at them again, and this
      // outcome's job is to say what is left to do.
      return {
        status: 'rate-limited',
        fetched: storedDays,
        remainingDays: [...missingDays].filter((day) => !stored.has(day)),
        apiCallCount,
      };
    }

    if (result.status === 'rejected') {
      throw new Error(
        `Open-Meteo archive refused the backfill request for ${locationId(coords)} ` +
          `${run.firstDay}..${run.lastDay} with HTTP ${String(result.httpStatus)}: ${result.reason}`,
      );
    }

    for (const [day, readings] of result.completeDays) {
      // A day outside the missing set is a day this run did not ask for. Storing
      // it would be harmless data but a dishonest count, and a marker written
      // for a day nobody vetted is exactly the claim this module exists to keep
      // trustworthy.
      if (!missingDays.has(day)) {
        continue;
      }
      await deps.weatherAdapter.putArchiveDay(day, readings);
      storedDays.push(day);
    }

    unavailableDays.push(...result.incompleteDays.filter((day) => missingDays.has(day)));
  }

  return {
    status: 'ready',
    alreadyCached,
    fetched: storedDays,
    unavailableDays,
    apiCallCount,
  };
};
