import { describe, expect, it } from 'vitest';

import { canonicalFleetSeed, generateFleet } from './fleet';
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
  { name: 'Dublin', latitude: 53.3498, longitude: -6.2603 },
  { name: 'Cork', latitude: 51.8985, longitude: -8.4756 },
  { name: 'Galway', latitude: 53.2707, longitude: -9.0568 },
  { name: 'Limerick', latitude: 52.6638, longitude: -8.6267 },
  { name: 'Belfast', latitude: 54.5973, longitude: -5.9301 },
  { name: 'London', latitude: 51.5072, longitude: -0.1276 },
  { name: 'Manchester', latitude: 53.4808, longitude: -2.2426 },
  { name: 'Birmingham', latitude: 52.4862, longitude: -1.8904 },
  { name: 'Bristol', latitude: 51.4545, longitude: -2.5879 },
  { name: 'Leeds', latitude: 53.8008, longitude: -1.5491 },
  { name: 'Edinburgh', latitude: 55.9533, longitude: -3.1883 },
  { name: 'Cardiff', latitude: 51.4816, longitude: -3.1791 },
];

const expectedLatitudeJitter = 0.02;
const expectedLongitudeJitter = 0.03;
/** Coordinates are recorded to 5 dp, so rounding can nudge a site half a unit past the jitter box. */
const coordinateRoundingSlack = 0.000005;

function locationNameOf(site: Site): string {
  return site.name.split(' rooftop ')[0] ?? site.name;
}

function countSitesByLocation(fleet: readonly Site[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const site of fleet) {
    const locationName = locationNameOf(site);
    counts.set(locationName, (counts.get(locationName) ?? 0) + 1);
  }
  return counts;
}

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
        expectedLatitudeJitter + coordinateRoundingSlack,
      );
      expect(Math.abs(site.longitude - centre.longitude)).toBeLessThanOrEqual(
        expectedLongitudeJitter + coordinateRoundingSlack,
      );
    }
  });

  it('pins the canonical fleet: any change to seed, PRNG, or draw order fails here', () => {
    const fleet = generateFleet(canonicalFleetSeed);

    expect(fleet.at(0)).toEqual({
      id: '651ceb1d-ad75-4da3-b8f4-f6e72ead1fc8',
      name: 'Dublin rooftop 1',
      latitude: 53.35728,
      longitude: -6.24317,
      tiltDegrees: 22,
      azimuthDegrees: 121,
      capacityKw: 5.9,
    });

    expect(fleet.at(-1)).toEqual({
      id: '491b3a8f-ae77-4c32-81b4-0722e36170b1',
      name: 'Cardiff rooftop 5',
      latitude: 51.47242,
      longitude: -3.18851,
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
