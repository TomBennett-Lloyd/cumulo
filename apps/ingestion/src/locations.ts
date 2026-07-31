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
