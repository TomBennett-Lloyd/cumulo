import { canonicalFleetSeed, fleetSiteSchema, generateFleet, locationId } from '@cumulo/shared';
import type { FleetSite, Site } from '@cumulo/shared';
import { describe, expect, it } from 'vitest';

import {
  CYCLE_ROTATION_PERIOD_MS,
  activeFetchLocations,
  rotationOffset,
  selectCycleLocations,
  type FetchLocation,
} from './locations';

/**
 * The canonical demo fleet: 60 sites in 12 co-located clusters
 * (`docs/design/fleet-simulation.md`). Imported by seed rather than by its literal
 * value, so a fleet regenerated under a different seed moves these tests with it
 * instead of leaving them asserting a fleet that no longer exists.
 */
const canonicalSites = generateFleet(canonicalFleetSeed);

const expectedFleetSize = 60;
const expectedFetchLocations = 12;
const sitesPerCluster = 5;

/** Fixed, because nothing here depends on when a site joined — only on whether it is active. */
const seedCreatedAt = '2026-07-30T00:00:00Z';

interface FleetSiteInput {
  readonly site: Site;
  readonly active: boolean;
}

/**
 * Promote a generated `Site` to the `FleetSite` the control plane holds. Parsed
 * rather than cast: a fixture that could not survive `fleetSiteSchema` is a fixture
 * describing a site the system cannot contain.
 */
const fleetSiteOf = (input: FleetSiteInput): FleetSite =>
  fleetSiteSchema.parse({
    ...input.site,
    origin: 'seed',
    createdAt: seedCreatedAt,
    active: input.active,
  });

const activeFleetSiteOf = (site: Site): FleetSite => fleetSiteOf({ site, active: true });

const activeCanonicalFleet = canonicalSites.map(activeFleetSiteOf);

/** Dublin — the first cluster in the generator's iteration order. */
const oneCluster = activeCanonicalFleet.slice(0, sitesPerCluster);

/**
 * A site placed where `locationId` canonicalizes rather than merely rounds: a
 * latitude that formats as `-0.00` and a longitude that rounds *onto* the
 * antimeridian. Written as a literal rather than derived from the fleet because the
 * canonical fleet is deliberately confined to Ireland and the UK.
 */
const canonicalizedEdgeSite: Site = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Antimeridian rooftop',
  latitude: -0.001,
  longitude: 179.998,
  tiltDegrees: 35,
  azimuthDegrees: 180,
  capacityKw: 4,
};

describe('activeFetchLocations', () => {
  it('the canonical 60-site fleet collapses to exactly 12 fetch locations', () => {
    // The de-duplication lever the fleet exists to provide: 12 Open-Meteo calls per
    // cycle instead of 60 (docs/design/fleet-simulation.md, "Weather locations and
    // the Open-Meteo budget"). #78 made the fleet honour it; this is the consumer side.
    expect(activeCanonicalFleet).toHaveLength(expectedFleetSize);
    expect(activeFetchLocations(activeCanonicalFleet)).toHaveLength(expectedFetchLocations);
  });

  it('five co-located sites produce one fetch location', () => {
    expect(oneCluster).toHaveLength(sitesPerCluster);
    expect(activeFetchLocations(oneCluster)).toEqual([
      { locationId: '53.35,-6.26', latitude: 53.35, longitude: -6.26 },
    ]);
  });

  it('inactive sites are excluded from the fetch set', () => {
    const dublinDeactivated = canonicalSites.map((site, index) =>
      fleetSiteOf({ site, active: index >= sitesPerCluster }),
    );

    const locations = activeFetchLocations(dublinDeactivated);
    expect(locations).toHaveLength(expectedFetchLocations - 1);
    expect(locations.map((location) => location.locationId)).not.toContain('53.35,-6.26');

    const allDeactivated = canonicalSites.map((site) => fleetSiteOf({ site, active: false }));
    expect(activeFetchLocations(allDeactivated)).toEqual([]);
  });

  it("every fetch location's coordinates round-trip through locationId to its own id", () => {
    // The property the whole module rests on: a request issued at these coordinates
    // is keyed by the bucket it was issued for, so readings land in the partition
    // that reads them back (ADR 0002 §3). The edge site makes the assertion bite on
    // the two cases where locationId canonicalizes instead of rounding.
    const locations = activeFetchLocations([
      ...activeCanonicalFleet,
      activeFleetSiteOf(canonicalizedEdgeSite),
    ]);

    expect(locations).toHaveLength(expectedFetchLocations + 1);
    for (const location of locations) {
      expect(locationId(location)).toBe(location.locationId);
    }
    expect(locations.map((location) => location.locationId)).toContain('0.00,-180.00');
  });

  it('an empty fleet yields no locations', () => {
    expect(activeFetchLocations([])).toEqual([]);
  });

  it('orders the fetch set by ascending location id', () => {
    const ids = activeFetchLocations(activeCanonicalFleet).map((location) => location.locationId);
    expect(ids).toEqual([...ids].sort());
    expect(ids.at(0)).toBe('51.45,-2.59');
    expect(ids.at(-1)).toBe('55.95,-3.19');
  });
});

/** Four fetch locations, named by their ids, in the ascending order the cycle visits. */
const fourLocations: FetchLocation[] = [
  { locationId: 'a', latitude: 1, longitude: 1 },
  { locationId: 'b', latitude: 2, longitude: 2 },
  { locationId: 'c', latitude: 3, longitude: 3 },
  { locationId: 'd', latitude: 4, longitude: 4 },
];

const idsOf = (locations: readonly FetchLocation[]): string[] =>
  locations.map((location) => location.locationId);

const midnight = Date.parse('2026-07-31T00:00:00Z');

/** The instant a cycle starting `hoursFromMidnight` after that midnight reads. */
const hour = (hoursFromMidnight: number): number =>
  midnight + hoursFromMidnight * CYCLE_ROTATION_PERIOD_MS;

/** A fleet of `size` fetch locations, ids ascending in the order a cycle visits them. */
const locationsOfSize = (size: number): FetchLocation[] =>
  Array.from({ length: size }, (_, index) => ({
    locationId: `loc-${String(index).padStart(3, '0')}`,
    latitude: index,
    longitude: index,
  }));

/**
 * Fleet sizes and caps where the rotation actually has to work: the cap bites in
 * every case, and no cap divides its fleet size — so the windows do not land on
 * a period that would hide a stepping bug. Every cap is ≥ 2, which is what makes
 * "one window per hour" distinguishable from "one location per hour".
 */
const rotationCases = [
  { locationCount: 5, maxLocations: 2 },
  { locationCount: 7, maxLocations: 3 },
  { locationCount: 250, maxLocations: 100 },
] as const;

/** The ids the cycle starting at `hoursFromMidnight` would actually fetch. */
const servedAtHour = (
  locations: readonly FetchLocation[],
  maxLocations: number,
  hoursFromMidnight: number,
): string[] =>
  idsOf(
    selectCycleLocations(locations, {
      offset: rotationOffset(hour(hoursFromMidnight), locations.length, maxLocations),
      maxLocations,
    }).selected,
  );

/** Hour-by-hour, the set of ids each cycle over `horizonHours` serves. */
const scheduleOver = (
  locations: readonly FetchLocation[],
  maxLocations: number,
  horizonHours: number,
): Set<string>[] =>
  Array.from(
    { length: horizonHours },
    (_, hoursFromMidnight) => new Set(servedAtHour(locations, maxLocations, hoursFromMidnight)),
  );

/** How often one location was served over a schedule, and its longest gap between visits. */
interface VisitPattern {
  readonly visits: number;
  /** Zero when a location was served fewer than twice — `visits` is asserted separately. */
  readonly longestWait: number;
}

const visitPatternOf = (schedule: readonly ReadonlySet<string>[], id: string): VisitPattern => {
  let visits = 0;
  let longestWait = 0;
  let previousVisit: number | undefined;

  for (const [hoursFromMidnight, served] of schedule.entries()) {
    if (!served.has(id)) continue;
    visits += 1;
    if (previousVisit !== undefined) {
      longestWait = Math.max(longestWait, hoursFromMidnight - previousVisit);
    }
    previousVisit = hoursFromMidnight;
  }

  return { visits, longestWait };
};

describe('rotationOffset', () => {
  it('advances by one window per hour and wraps', () => {
    // Midnight on this date is an exact multiple of four hours since the epoch,
    // which is why the sequence starts at 0 — asserted rather than assumed.
    // Four locations two at a time: the second hour serves what the first
    // deferred, and the third is back where it began — full coverage in
    // ceil(4 / 2) = 2 cycles rather than the 4 a one-location step would take.
    expect(rotationOffset(hour(0), 4, 2)).toBe(0);
    expect(rotationOffset(hour(1), 4, 2)).toBe(2);
    expect(rotationOffset(hour(2), 4, 2)).toBe(0);
  });

  it('holds steady within an hour, so two cycles in one hour agree', () => {
    const start = Date.parse('2026-07-31T05:00:00Z');

    expect(rotationOffset(start, 7, 3)).toBe(rotationOffset(start + 59 * 60_000, 7, 3));
  });

  it('an empty fleet has nowhere to rotate to', () => {
    expect(rotationOffset(Date.now(), 0, 2)).toBe(0);
  });

  it.each(rotationCases)(
    'an over-cap fleet of $locationCount is fully covered within ceil(n / $maxLocations) consecutive cycles',
    ({ locationCount, maxLocations }) => {
      // The property the whole rotation exists for, asserted against the cap it
      // pairs with rather than against the offset arithmetic alone: consecutive
      // windows abut, so ceil(n / c) of them exhaust the list from *any* start.
      const locations = locationsOfSize(locationCount);
      const cyclesToCover = Math.ceil(locationCount / maxLocations);
      const everyId = idsOf(locations).sort();

      for (let startHour = 0; startHour <= 2 * cyclesToCover; startHour += 1) {
        const covered = new Set<string>();
        for (let offsetHour = 0; offsetHour < cyclesToCover; offsetHour += 1) {
          for (const id of servedAtHour(locations, maxLocations, startHour + offsetHour)) {
            covered.add(id);
          }
        }

        expect([...covered].sort()).toEqual(everyId);
      }
    },
  );

  it.each(rotationCases)(
    "a location's worst-case wait between visits is ceil($locationCount / $maxLocations) hours",
    ({ locationCount, maxLocations }) => {
      // Coverage within a window says nothing about the gap *between* windows,
      // and the gap is what the 48 h stored horizon has to outlive (#163).
      const locations = locationsOfSize(locationCount);
      const cyclesToCover = Math.ceil(locationCount / maxLocations);
      const schedule = scheduleOver(locations, maxLocations, 3 * locationCount);
      const patterns = idsOf(locations).map((id) => visitPatternOf(schedule, id));

      // Every location is served at least twice over the horizon, so each wait
      // below is a measured gap rather than a vacuously absent one.
      expect(Math.min(...patterns.map((pattern) => pattern.visits))).toBeGreaterThanOrEqual(2);
      expect(Math.max(...patterns.map((pattern) => pattern.longestWait))).toBeLessThanOrEqual(
        cyclesToCover,
      );
    },
  );
});

describe('selectCycleLocations', () => {
  it('takes the whole fleet when it fits under the cap', () => {
    const selection = selectCycleLocations(fourLocations, { offset: 0, maxLocations: 10 });

    expect(idsOf(selection.selected)).toEqual(['a', 'b', 'c', 'd']);
    expect(selection.deferred).toEqual([]);
  });

  it('defers everything past the cap rather than dropping it', () => {
    // Both halves come back, because the cycle reports on every active
    // location — a cap that shortened the list would be the same silent
    // truncation #115 was filed about.
    const selection = selectCycleLocations(fourLocations, { offset: 0, maxLocations: 2 });

    expect(idsOf(selection.selected)).toEqual(['a', 'b']);
    expect(idsOf(selection.deferred)).toEqual(['c', 'd']);
  });

  it('rotates the window so a later offset serves what an earlier one deferred', () => {
    const first = selectCycleLocations(fourLocations, { offset: 0, maxLocations: 2 });
    const third = selectCycleLocations(fourLocations, { offset: 2, maxLocations: 2 });

    expect(idsOf(third.selected)).toEqual(['c', 'd']);
    expect(idsOf(third.selected)).toEqual(idsOf(first.deferred));
  });

  it('wraps the rotation without losing or duplicating a location', () => {
    for (let offset = 0; offset < fourLocations.length; offset += 1) {
      const selection = selectCycleLocations(fourLocations, { offset, maxLocations: 3 });
      const covered = [...idsOf(selection.selected), ...idsOf(selection.deferred)];

      expect(covered.sort()).toEqual(['a', 'b', 'c', 'd']);
    }
  });

  it('rejects a cap that would starve the whole cycle', () => {
    // A zero cap skips everything while looking like a configured value; it is
    // a violated invariant, so it throws at the composition root's first cycle
    // rather than producing a fleet-wide skip nobody asked for.
    expect(() => selectCycleLocations(fourLocations, { offset: 0, maxLocations: 0 })).toThrow(
      /positive integer/,
    );
  });

  it('rejects an offset outside the list', () => {
    expect(() => selectCycleLocations(fourLocations, { offset: 9, maxLocations: 2 })).toThrow(
      /outside/,
    );
  });
});
