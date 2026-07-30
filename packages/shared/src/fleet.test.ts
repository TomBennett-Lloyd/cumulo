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

  it('reproduces the canonical demo fleet on every invocation', () => {
    expect(generateFleet(canonicalFleetSeed)).toEqual(generateFleet(canonicalFleetSeed));
  });
});
