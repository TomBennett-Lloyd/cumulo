import type { BatchWriteOutcome, SiteAdapter, WeatherAdapter } from '@cumulo/storage';

import {
  activeFetchLocations,
  rotationOffset,
  selectCycleLocations,
  type FetchLocation,
} from './locations';
import type { FetchForecastForLocation, FetchForecastOutcome } from './open-meteo/fetch-forecast';
import type { WeatherPublisher } from './publisher/weather-publisher';
import { describeThrown } from './thrown-detail';

/**
 * One ingestion cycle: list the fleet, collapse it to the locations worth fetching
 * weather for, and — per location — fetch, store, publish.
 *
 * This module is the only place the order of those three effects is decided, and
 * the order is load-bearing: `cumulo-weather` is the durable record, the published
 * message is a trigger that happens to carry its payload (ADR 0004). Publishing
 * first would let the forecast service act on readings that were never stored, so
 * the store happens first and a store that did not fully drain stops the publish.
 *
 * Every effect arrives as a dependency. Nothing here constructs an AWS client, an
 * HTTP client or a clock, which is what lets the whole cycle — including its
 * failure paths — run in a unit test (architecture rule 3).
 */

/**
 * What became of one location this cycle, as a value.
 *
 * The six cases are not decoration: each names a different thing to do about it.
 * `published` is the success; `rate-limited` means back off and let the next hourly
 * cycle retry; `malformed` means the provider contract moved and someone must look;
 * `unreachable` is a blip the next cycle absorbs; `store-partial` means DynamoDB
 * declined writes, so the readings exist nowhere downstream *and* the message was
 * withheld; `failed` is an unexpected throw from an adapter or the publisher,
 * converted here rather than allowed to abandon the rest of the fleet.
 */
export type LocationOutcome = { readonly locationId: string } & (
  | { readonly status: 'published'; readonly readingCount: number; readonly droppedHours: number }
  | { readonly status: 'rate-limited' }
  | { readonly status: 'malformed'; readonly detail: string }
  | { readonly status: 'unreachable'; readonly detail: string }
  | { readonly status: 'store-partial'; readonly unprocessedCount: number }
  | { readonly status: 'failed'; readonly detail: string }
  | { readonly status: 'skipped'; readonly reason: SkipReason }
);

/**
 * Why a location was never attempted. The two reasons are two different
 * conversations: `location-cap` says the fleet has outgrown the Open-Meteo
 * allowance this service budgets for, and `cycle-deadline` says the cycle ran
 * out of wall clock — an infrastructure problem, since a healthy cycle finishes
 * in seconds.
 */
export type SkipReason = 'location-cap' | 'cycle-deadline';

/**
 * The cycle's result, reported honestly (`docs/standards/error-handling.md` rule 5).
 *
 * `failed` counts every location that went **wrong** — a rate limit, a malformed
 * body and a thrown adapter error all mean the same thing downstream: the forecast
 * service was not told about that location this hour, and something is amiss. A
 * caller that alarms on `failed > 0` cannot be fooled by a failure mode that
 * reported itself politely.
 *
 * `deferred` is deliberately outside that count. A fleet larger than the cap is a
 * scheduling fact rather than a fault: the locations are served by a later cycle,
 * rotation guarantees it, and nothing needs an operator. Folding them into `failed`
 * would make a legitimately over-cap fleet page every hour forever, which is an
 * alarm that trains its reader to ignore it. A deadline skip is the opposite — it
 * only happens under pathology — so those stay in `failed`.
 *
 * So the invariant is `published + failed + deferred === activeLocations`: every
 * active location is accounted for, and the three buckets mean three different
 * things to the operator.
 */
export interface CycleReport {
  readonly locations: LocationOutcome[];
  readonly activeLocations: number;
  readonly published: number;
  readonly failed: number;
  /**
   * Locations the cap held back for a later cycle. **Not** failures: a fleet
   * larger than the cap is a scheduling fact, not a fault, and rotation means a
   * deferred location is served within the next few cycles. Counted separately
   * so `failed` keeps meaning "something went wrong".
   */
  readonly deferred: number;
  /** Of `failed`, those the cycle ran out of time to attempt. */
  readonly skippedForDeadline: number;
}

/**
 * The two bounds a cycle runs under. The deadline protects the function
 * timeout; the cap protects the Open-Meteo quota; neither substitutes for the
 * other. `cycle-budget.ts` derives both and states the arithmetic.
 *
 * Injected rather than imported so the cycle is testable at a scale a test can
 * express, and so the numbers stay a decision of the composition root
 * (`docs/standards/architecture.md` rule 3).
 */
export interface CycleBudget {
  /** Milliseconds after which no further location is *started*. */
  readonly deadlineMs: number;
  /** Locations this cycle may attempt at all. */
  readonly maxLocations: number;
}

export interface RunCycleDeps {
  /** Only the fleet listing is needed: this service reads sites and never writes them (ADR 0002). */
  readonly sites: Pick<SiteAdapter, 'listFleetSites'>;
  /** Only the forecast write: ingestion never touches archive weather (#16 owns that). */
  readonly weather: Pick<WeatherAdapter, 'putForecastWeather'>;
  readonly publisher: WeatherPublisher;
  /** The one Open-Meteo call a cycle makes; the policy behind it is bound by `main.ts`. */
  readonly fetchForecast: FetchForecastForLocation;
  /**
   * Structured-logging sink (`docs/standards/error-handling.md` rule 4). Injected
   * rather than called directly so this module stays free of a console, and so the
   * tests read the entries a reviewer would read in CloudWatch.
   */
  readonly log: (entry: Record<string, unknown>) => void;
  /**
   * Wall clock, in milliseconds. Injected because the deadline below is the one
   * piece of this module that depends on time passing, and a cycle whose
   * time-out behaviour could only be tested by actually waiting would not be
   * tested at all.
   */
  readonly now: () => number;
  readonly budget: CycleBudget;
}

/** Emitted once per cycle, before any fetch — including for a cycle with nothing to fetch. */
export const cycleStartedEvent = 'ingestion.cycle.started';

/** Emitted once per location, whatever became of it. */
export const locationOutcomeEvent = 'ingestion.location.outcome';

/**
 * The three awaited calls in a location's processing. A `failed` outcome must say
 * which of them threw, because the operator's next step differs for each
 * (`docs/standards/error-handling.md` rule 4) — and because "location X failed" on
 * its own is the kind of log line that costs an hour to act on.
 */
type LocationOperation = 'fetchForecast' | 'putForecastWeather' | 'publishLocationReadings';

const failedOutcome = (
  locationId: string,
  operation: LocationOperation,
  error: unknown,
): LocationOutcome => ({
  locationId,
  status: 'failed',
  detail: `${operation} threw — ${describeThrown(error)}`,
});

/**
 * A fetch that produced no readings, as this location's outcome: the adapter's
 * vocabulary carried across unchanged rather than collapsed into one "fetch
 * failed", since the adapter drew those distinctions precisely because the caller
 * acts differently on each.
 */
const fetchFailureOutcome = (
  locationId: string,
  fetched: Exclude<FetchForecastOutcome, { outcome: 'ok' }>,
): LocationOutcome =>
  fetched.outcome === 'rate-limited'
    ? { locationId, status: 'rate-limited' }
    : { locationId, status: fetched.outcome, detail: fetched.detail };

/**
 * Fetch, store, publish — for exactly one location, and never throwing.
 *
 * Each awaited call has its own `catch`, and every one of them converts the throw
 * into a typed value carrying the operation that produced it (rule 2a, applied at
 * the boundary of a location's work). That is what makes the fleet independent:
 * a queue outage on one location, or a DynamoDB error on another, leaves the other
 * eleven locations of the canonical fleet to publish normally.
 *
 * The store precedes the publish, and a batch that did not fully drain returns
 * before the publish — `BatchWriteItem` answers HTTP 200 while handing back items
 * it declined, so "stored" is a claim only `complete` supports (ADR 0002
 * Consequence 4). Publishing a partial store would announce readings that are not
 * in the table the forecast service and the hindcast read back.
 */
const runLocation = async (
  deps: RunCycleDeps,
  location: FetchLocation,
): Promise<LocationOutcome> => {
  const { locationId } = location;

  let fetched: FetchForecastOutcome;
  try {
    fetched = await deps.fetchForecast(location);
  } catch (error) {
    return failedOutcome(locationId, 'fetchForecast', error);
  }
  if (fetched.outcome !== 'ok') {
    return fetchFailureOutcome(locationId, fetched);
  }

  let stored: BatchWriteOutcome;
  try {
    stored = await deps.weather.putForecastWeather(fetched.readings);
  } catch (error) {
    return failedOutcome(locationId, 'putForecastWeather', error);
  }
  if (stored.status === 'partial') {
    return { locationId, status: 'store-partial', unprocessedCount: stored.unprocessedCount };
  }

  try {
    await deps.publisher.publishLocationReadings(fetched.readings);
  } catch (error) {
    return failedOutcome(locationId, 'publishLocationReadings', error);
  }

  return {
    locationId,
    status: 'published',
    readingCount: fetched.readings.length,
    droppedHours: fetched.droppedHours,
  };
};

/** A location the cycle never attempted, as an outcome rather than as silence. */
const skippedOutcome = (location: FetchLocation, reason: SkipReason): LocationOutcome => ({
  locationId: location.locationId,
  status: 'skipped',
  reason,
});

const countSkipped = (outcomes: readonly LocationOutcome[], reason: SkipReason): number =>
  outcomes.filter((outcome) => outcome.status === 'skipped' && outcome.reason === reason).length;

/**
 * Run one cycle over the fleet's active locations.
 *
 * Resolves for every fleet the cycle can enumerate, including an empty one: zero
 * active locations is a successful cycle that issues no calls at all, which is the
 * API-frugality constraint in CLAUDE.md observed at its limit — and it is logged,
 * because a cycle that quietly did nothing is indistinguishable from a cycle that
 * failed to run.
 *
 * Locations are processed **sequentially**. The fleet's fetches are a shared draw
 * on one third-party quota (`docs/design/fleet-simulation.md`), so a serial loop
 * keeps a cycle's whole burst spread over its own duration rather than issued at
 * once, and it keeps this function's failure story simple enough to be true: one
 * location at a time, each independent of the last.
 *
 * **Two bounds, and every location accounted for either way** (#115). The budget's
 * cap decides how many locations this cycle may attempt at all; its deadline, checked
 * before each location, decides when to stop starting more. Neither shortens the
 * report: a location the cap deferred and a location the deadline cut off both
 * appear in `locations` with a `skipped` status, so
 * `published + failed + deferred === activeLocations` holds and a cycle that ran out
 * of budget still says exactly which locations published. A Lambda killed at its
 * timeout says none of that, which is why the deadline exists at all.
 *
 * The two skip reasons land in different buckets on purpose — see {@link CycleReport}.
 *
 * The deadline is checked *before* a location and never interrupts one in flight —
 * `cycle-budget.ts` reserves a whole location's worst case behind it for exactly
 * that. Checking elapsed time rather than counting locations is also what makes
 * `listFleetSites`'s own cost part of the budget without needing a term of its own.
 *
 * One consequence worth stating: during a total outage the first locations report
 * their individual failures and the rest report `skipped`, so the log shows a
 * handful of `unreachable` entries rather than one per location. That is the design
 * working — the cycle stopped spending an exhausted budget — and the summary's
 * counts still add up to the whole fleet.
 *
 * `listFleetSites` is deliberately *not* wrapped. A fleet we cannot read is not a
 * per-location failure — it is a cycle that never learned what to do, so it
 * propagates to the handler and fails the invocation (rule 1). Converting it into
 * an empty, "successful" cycle is exactly the silent zero this pipeline must never
 * report.
 */
export const runCycle = async (deps: RunCycleDeps): Promise<CycleReport> => {
  // Read before the fleet listing, not after. `listFleetSites` is itself at
  // least one fully-retried DynamoDB request and pages in principle, so a clock
  // started after it would leave that cost outside the budget entirely — and the
  // function timeout reachable again by exactly the amount the fleet read took.
  // This is what makes the docstring's claim true rather than aspirational.
  const startedAt = deps.now();
  const sites = await deps.sites.listFleetSites();
  const active = activeFetchLocations(sites);

  const { selected, deferred: deferredLocations } = selectCycleLocations(active, {
    offset: rotationOffset(startedAt, active.length),
    maxLocations: deps.budget.maxLocations,
  });

  deps.log({
    event: cycleStartedEvent,
    fleetSites: sites.length,
    activeLocations: active.length,
    attemptedLocations: selected.length,
  });

  const outcomes: LocationOutcome[] = [];
  const record = (outcome: LocationOutcome): void => {
    deps.log({ event: locationOutcomeEvent, ...outcome });
    outcomes.push(outcome);
  };

  for (const [index, location] of selected.entries()) {
    if (deps.now() - startedAt > deps.budget.deadlineMs) {
      for (const unreached of selected.slice(index)) {
        record(skippedOutcome(unreached, 'cycle-deadline'));
      }
      break;
    }
    record(await runLocation(deps, location));
  }

  for (const location of deferredLocations) {
    record(skippedOutcome(location, 'location-cap'));
  }

  const published = outcomes.filter((outcome) => outcome.status === 'published').length;
  const deferred = countSkipped(outcomes, 'location-cap');

  return {
    locations: outcomes,
    activeLocations: active.length,
    published,
    failed: outcomes.length - published - deferred,
    deferred,
    skippedForDeadline: countSkipped(outcomes, 'cycle-deadline'),
  };
};
