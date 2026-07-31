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

describe('rotationOffset', () => {
  it('advances by one location per hour and wraps', () => {
    const midnight = Date.parse('2026-07-31T00:00:00Z');
    const hour = (n: number): number => midnight + n * CYCLE_ROTATION_PERIOD_MS;

    // Midnight on this date is an exact multiple of four hours since the epoch,
    // which is why the sequence starts at 0 — asserted rather than assumed.
    expect(rotationOffset(hour(0), 4)).toBe(0);
    expect(rotationOffset(hour(1), 4)).toBe(1);
    expect(rotationOffset(hour(3), 4)).toBe(3);
    expect(rotationOffset(hour(4), 4)).toBe(0);
  });

  it('holds steady within an hour, so two cycles in one hour agree', () => {
    const start = Date.parse('2026-07-31T05:00:00Z');

    expect(rotationOffset(start, 7)).toBe(rotationOffset(start + 59 * 60_000, 7));
  });

  it('an empty fleet has nowhere to rotate to', () => {
    expect(rotationOffset(Date.now(), 0)).toBe(0);
  });
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
