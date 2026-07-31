/**
 * Active-location de-duplication: the fleet collapsed to the set of coordinates
 * the forecast cycle actually has to fetch weather for.
 *
 * This is where CLAUDE.md's API-frugality constraint is enforced in code — "only
 * ever fetch weather for locations where active fleet sites exist" is exactly the
 * filter plus the bucketing below. For the canonical fleet that is 12 calls per
 * cycle instead of 60.
 *
 * Pure: no I/O, no clock. The caller supplies the fleet and fetches the result.
 */

import { locationId } from '@cumulo/shared';
import type { FleetSite } from '@cumulo/shared';

/**
 * One weather fetch: the de-duplication key and the coordinates to request it at.
 *
 * `latitude`/`longitude` are the *canonical* coordinates of the bucket, not any
 * one site's. Readings are stored under `locationId` (ADR 0002 §3), so a request
 * issued at a site's own coordinates would key its response by a bucket the
 * request was not centred on. Taking both from the id makes that impossible.
 */
export interface FetchLocation {
  readonly locationId: string;
  readonly latitude: number;
  readonly longitude: number;
}

/** `locationId` formats its two axes as `"<lat>,<lon>"`. */
const axisSeparator = ',';

/**
 * Recover a bucket's coordinates from the id that names it.
 *
 * The parse is safe without validation because the input is never external: it is
 * `locationId`'s own output, produced a few lines below. Reading the axes back out
 * of the id — rather than rounding a site's coordinates again here — is what
 * guarantees `locationId(fetchLocation) === fetchLocation.locationId` for every
 * result, including the coordinates `locationId` canonicalizes rather than merely
 * rounds (`-0.00` → `0.00`, and 180°E → 180°W).
 */
const fetchLocationOf = (id: string): FetchLocation => {
  const separatorIndex = id.indexOf(axisSeparator);
  return {
    locationId: id,
    latitude: Number(id.slice(0, separatorIndex)),
    longitude: Number(id.slice(separatorIndex + 1)),
  };
};

/**
 * The distinct location ids of the sites still worth fetching for.
 *
 * `locationId` is imported rather than reimplemented: it is simultaneously the
 * `cumulo-weather` partition key and this de-duplication key, and a drift between
 * the two would either double the fetch volume or write readings into a partition
 * nothing reads back (ADR 0002 §3).
 */
const activeLocationIds = (sites: readonly FleetSite[]): Set<string> =>
  new Set(sites.filter((site) => site.active).map((site) => locationId(site)));

/**
 * The weather fetches one ingestion cycle should issue for `sites`.
 *
 * Inactive sites contribute nothing, co-located sites contribute one entry, and
 * the result is ordered by id — stable output for a cycle whose logs and metrics
 * are read by humans, and a deterministic fixture for tests downstream.
 */
export const activeFetchLocations = (sites: readonly FleetSite[]): FetchLocation[] =>
  [...activeLocationIds(sites)].sort().map(fetchLocationOf);

/**
 * The rotation period: one hour, matching the ingestion cadence, so consecutive
 * cycles advance the starting point by exactly one location.
 */
export const CYCLE_ROTATION_PERIOD_MS = 3_600_000;

/**
 * Where in the sorted list this cycle begins.
 *
 * Rotation exists because the cap has to skip *someone*, and always skipping
 * the same tail of an ascending-id list would starve it permanently — a fleet
 * of 130 locations would have 30 that never get weather at all. Since
 * `locationId` sorts by latitude, that tail is a geographic band, and #17's
 * visitor sites land wherever visitors are.
 *
 * Derived from the clock rather than from stored state: ingestion has nowhere
 * to keep a cursor, and a cursor would make two cycles in the same hour
 * disagree about what they had covered. Deterministic for a given hour, which
 * is what lets a test assert the mapping instead of observing a shuffle.
 */
export const rotationOffset = (nowMs: number, length: number): number =>
  length === 0 ? 0 : Math.floor(nowMs / CYCLE_ROTATION_PERIOD_MS) % length;

/** How a cycle's locations split into the ones it will attempt and the ones the cap defers. */
export interface CycleLocationSelection {
  readonly selected: FetchLocation[];
  /** Beyond the cap this cycle — reported, never silently dropped. */
  readonly deferred: FetchLocation[];
}

/** Where the rotation starts, and how many locations the cycle may attempt. */
export interface CycleSelectionSpec {
  /** In `[0, locations.length)` — {@link rotationOffset} produces exactly that. */
  readonly offset: number;
  readonly maxLocations: number;
}

/**
 * Split the active locations into the ones this cycle attempts and the ones it
 * defers to the next, rotating the starting point so no location is starved.
 *
 * Both halves are returned because the cycle reports on every active location,
 * not only the ones it reached: a cap that silently shortened the list would be
 * the same shape of failure as the Lambda timeout it exists to prevent (#115).
 *
 * Pure, and separate from the clock on purpose — the caller resolves `offset`
 * from `now()` and hands in a number, so the rotation arithmetic and the
 * capping arithmetic are both testable without a fake clock between them.
 */
export const selectCycleLocations = (
  locations: readonly FetchLocation[],
  spec: CycleSelectionSpec,
): CycleLocationSelection => {
  if (!Number.isInteger(spec.maxLocations) || spec.maxLocations < 1) {
    throw new Error(
      `selectCycleLocations: maxLocations must be a positive integer, got ${String(spec.maxLocations)}`,
    );
  }
  if (!Number.isInteger(spec.offset) || spec.offset < 0 || spec.offset > locations.length) {
    throw new Error(
      `selectCycleLocations: offset ${String(spec.offset)} is outside [0, ${String(locations.length)}]`,
    );
  }

  const rotated = [...locations.slice(spec.offset), ...locations.slice(0, spec.offset)];
  return {
    selected: rotated.slice(0, spec.maxLocations),
    deferred: rotated.slice(spec.maxLocations),
  };
};
