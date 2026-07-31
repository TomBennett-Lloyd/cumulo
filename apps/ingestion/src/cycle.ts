import type { BatchWriteOutcome, SiteAdapter, WeatherAdapter } from '@cumulo/storage';

import { activeFetchLocations, type FetchLocation } from './locations';
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
);

/**
 * The cycle's result, reported honestly (`docs/standards/error-handling.md` rule 5).
 *
 * `failed` counts every location that did **not** publish, whatever the reason —
 * a rate limit, a malformed body and a thrown adapter error all mean the same thing
 * downstream: the forecast service was not told about that location this hour. So
 * `published + failed === activeLocations` always, and a caller that alarms on
 * `failed > 0` cannot be fooled by a failure mode that reported itself politely.
 */
export interface CycleReport {
  readonly locations: LocationOutcome[];
  readonly activeLocations: number;
  readonly published: number;
  readonly failed: number;
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
 * keeps a cycle's whole burst at 12 calls spread over its own duration rather than
 * 12 simultaneous ones, and it keeps this function's failure story simple enough
 * to be true: one location at a time, each independent of the last.
 *
 * `listFleetSites` is deliberately *not* wrapped. A fleet we cannot read is not a
 * per-location failure — it is a cycle that never learned what to do, so it
 * propagates to the handler and fails the invocation (rule 1). Converting it into
 * an empty, "successful" cycle is exactly the silent zero this pipeline must never
 * report.
 */
export const runCycle = async (deps: RunCycleDeps): Promise<CycleReport> => {
  const sites = await deps.sites.listFleetSites();
  const locations = activeFetchLocations(sites);

  deps.log({
    event: cycleStartedEvent,
    fleetSites: sites.length,
    activeLocations: locations.length,
  });

  const outcomes: LocationOutcome[] = [];
  for (const location of locations) {
    const outcome = await runLocation(deps, location);
    deps.log({ event: locationOutcomeEvent, ...outcome });
    outcomes.push(outcome);
  }

  const published = outcomes.filter((outcome) => outcome.status === 'published').length;

  return {
    locations: outcomes,
    activeLocations: locations.length,
    published,
    failed: outcomes.length - published,
  };
};
