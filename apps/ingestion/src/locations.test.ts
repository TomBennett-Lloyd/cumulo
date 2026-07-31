import { canonicalFleetSeed, fleetSiteSchema, generateFleet, locationId } from '@cumulo/shared';
import type { FleetSite, Site } from '@cumulo/shared';
import { describe, expect, it } from 'vitest';

import { activeFetchLocations } from './locations';

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
