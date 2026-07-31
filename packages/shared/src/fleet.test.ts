import { describe, expect, it } from 'vitest';

import { canonicalFleetSeed, generateFleet } from './fleet';
import { locationId } from './location';
import { siteSchema } from './site';
import type { Site } from './site';

const expectedFleetSize = 60;
const expectedSitesPerLocation = 5;
const expectedLocationNames = [
  'Belfast',
  'Birmingham',
  'Bristol',
  'Cardiff',
  'Cork',
  'Dublin',
  'Edinburgh',
  'Galway',
  'Leeds',
  'Limerick',
  'London',
  'Manchester',
];

/**
 * Cluster centres, intentionally mirroring the `fleetLocations` constant in `fleet.ts` and the
 * table in `docs/design/fleet-simulation.md`. They are duplicated rather than imported because the
 * module's public surface is deliberately just `generateFleet` and `canonicalFleetSeed`; a test
 * that imported the constants could not catch them drifting from the documented design.
 */
const expectedClusterCentres = [
  { name: 'Dublin', latitude: 53.35, longitude: -6.26 },
  { name: 'Cork', latitude: 51.9, longitude: -8.48 },
  { name: 'Galway', latitude: 53.27, longitude: -9.06 },
  { name: 'Limerick', latitude: 52.66, longitude: -8.63 },
  { name: 'Belfast', latitude: 54.6, longitude: -5.93 },
  { name: 'London', latitude: 51.51, longitude: -0.13 },
  { name: 'Manchester', latitude: 53.48, longitude: -2.24 },
  { name: 'Birmingham', latitude: 52.49, longitude: -1.89 },
  { name: 'Bristol', latitude: 51.45, longitude: -2.59 },
  { name: 'Leeds', latitude: 53.8, longitude: -1.55 },
  { name: 'Edinburgh', latitude: 55.95, longitude: -3.19 },
  { name: 'Cardiff', latitude: 51.48, longitude: -3.18 },
];

/** Both axes share one half-width: the de-duplication bucket it has to fit inside is square. */
const expectedJitter = 0.004;
/** Coordinates are recorded to 5 dp, so rounding can nudge a site half a unit past the jitter box. */
const coordinateRoundingSlack = 0.000005;
/** Half of `locationId`'s 0.01° bucket — the ceiling the jitter half-width has to stay under. */
const halfLocationBucket = 0.005;

const locationNameOf = (site: Site): string => site.name.split(' rooftop ')[0] ?? site.name;

const countSitesByLocation = (fleet: readonly Site[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const site of fleet) {
    const locationName = locationNameOf(site);
    counts.set(locationName, (counts.get(locationName) ?? 0) + 1);
  }
  return counts;
};

describe('generateFleet', () => {
  it('produces an identical fleet for the same seed', () => {
    expect(generateFleet(1)).toEqual(generateFleet(1));
  });

  it('produces different fleets for different seeds', () => {
    expect(generateFleet(1)).not.toEqual(generateFleet(2));
  });

  it('produces sites that all satisfy the site schema', () => {
    const invalid = generateFleet(canonicalFleetSeed).filter(
      (site) => !siteSchema.safeParse(site).success,
    );
    expect(invalid).toEqual([]);
  });

  it('produces 60 sites with unique ids', () => {
    const fleet = generateFleet(canonicalFleetSeed);
    expect(fleet).toHaveLength(expectedFleetSize);
    expect(new Set(fleet.map((site) => site.id)).size).toBe(expectedFleetSize);
  });

  it('places exactly five sites at each of the twelve locations', () => {
    const counts = countSitesByLocation(generateFleet(canonicalFleetSeed));
    expect([...counts.keys()].sort()).toEqual(expectedLocationNames);
    expect([...counts.values()]).toEqual(expectedLocationNames.map(() => expectedSitesPerLocation));
  });

  it('keeps capacity, tilt and azimuth inside their design ranges', () => {
    for (const site of generateFleet(canonicalFleetSeed)) {
      expect(site.capacityKw).toBeGreaterThanOrEqual(2);
      expect(site.capacityKw).toBeLessThanOrEqual(10);
      expect(site.tiltDegrees).toBeGreaterThanOrEqual(20);
      expect(site.tiltDegrees).toBeLessThanOrEqual(50);
      expect(site.azimuthDegrees).toBeGreaterThanOrEqual(90);
      expect(site.azimuthDegrees).toBeLessThanOrEqual(270);
    }
  });

  it('clusters every site within the jitter box of the centre named in its own name', () => {
    for (const site of generateFleet(canonicalFleetSeed)) {
      const locationName = locationNameOf(site);
      const centre = expectedClusterCentres.find((candidate) => candidate.name === locationName);
      expect(centre, `no cluster centre named ${locationName}`).toBeDefined();
      if (centre === undefined) {
        continue;
      }
      expect(Math.abs(site.latitude - centre.latitude)).toBeLessThanOrEqual(
        expectedJitter + coordinateRoundingSlack,
      );
      expect(Math.abs(site.longitude - centre.longitude)).toBeLessThanOrEqual(
        expectedJitter + coordinateRoundingSlack,
      );
    }
  });

  it('keeps every cluster centre at the centre of its own locationId bucket', () => {
    // Half of the co-location invariant below. A centre that is not bucket-exact puts its
    // jitter box across a bucket boundary, and the cluster stops being one weather fetch.
    for (const centre of expectedClusterCentres) {
      expect(locationId(centre)).toBe(
        `${centre.latitude.toFixed(2)},${centre.longitude.toFixed(2)}`,
      );
    }
  });

  it('gives every cluster one shared locationId, so 60 sites are 12 weather fetches', () => {
    // The de-duplication lever the fleet exists to provide (docs/design/fleet-simulation.md,
    // "Weather locations and the Open-Meteo budget"). It holds because the jitter half-width is
    // strictly under half a bucket — asserted here rather than assumed, since widening the
    // jitter is the change that would quietly break it (#78).
    expect(expectedJitter + coordinateRoundingSlack).toBeLessThan(halfLocationBucket);

    const fleet = generateFleet(canonicalFleetSeed);
    const idsByCluster = new Map<string, Set<string>>();
    for (const site of fleet) {
      const cluster = locationNameOf(site);
      const ids = idsByCluster.get(cluster) ?? new Set<string>();
      ids.add(locationId(site));
      idsByCluster.set(cluster, ids);
    }

    for (const [cluster, ids] of idsByCluster) {
      expect([...ids], `${cluster} spans more than one weather location`).toHaveLength(1);
    }
    expect(new Set(fleet.map((site) => locationId(site))).size).toBe(expectedClusterCentres.length);
  });

  it('pins the canonical fleet: any change to seed, PRNG, or draw order fails here', () => {
    const fleet = generateFleet(canonicalFleetSeed);

    expect(fleet.at(0)).toEqual({
      id: '651ceb1d-ad75-4da3-b8f4-f6e72ead1fc8',
      name: 'Dublin rooftop 1',
      latitude: 53.3515,
      longitude: -6.25772,
      tiltDegrees: 22,
      azimuthDegrees: 121,
      capacityKw: 5.9,
    });

    expect(fleet.at(-1)).toEqual({
      id: '491b3a8f-ae77-4c32-81b4-0722e36170b1',
      name: 'Cardiff rooftop 5',
      latitude: 51.47816,
      longitude: -3.18126,
      tiltDegrees: 31,
      azimuthDegrees: 195,
      capacityKw: 4,
    });
  });

  it('records coordinates at 5 decimal places, not raw float precision', () => {
    for (const site of generateFleet(canonicalFleetSeed)) {
      expect(site.latitude).toBe(Math.round(site.latitude * 1e5) / 1e5);
      expect(site.longitude).toBe(Math.round(site.longitude * 1e5) / 1e5);
    }
  });
});
