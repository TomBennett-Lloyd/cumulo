import { describe, expect, it } from 'vitest';

import { fleetSiteSchema, siteOriginSchema, siteSchema } from './site';

const validSite = {
  id: 'e7b8f8a0-3c2d-4e5f-9a1b-2c3d4e5f6a7b',
  name: 'Dublin rooftop 1',
  latitude: 53.3498,
  longitude: -6.2603,
  tiltDegrees: 30,
  azimuthDegrees: 180,
  capacityKw: 4.2,
};

describe('siteSchema', () => {
  it('accepts a typical residential site', () => {
    const result = siteSchema.safeParse(validSite);
    expect(result.success).toBe(true);
  });

  it('rejects a latitude beyond the poles', () => {
    const result = siteSchema.safeParse({ ...validSite, latitude: 90.1 });
    expect(result.success).toBe(false);
  });

  it('rejects tilt past vertical', () => {
    const result = siteSchema.safeParse({ ...validSite, tiltDegrees: 90.5 });
    expect(result.success).toBe(false);
  });

  it('rejects azimuth 360 — it must be normalized to 0', () => {
    const result = siteSchema.safeParse({ ...validSite, azimuthDegrees: 360 });
    expect(result.success).toBe(false);
  });

  it('rejects non-positive capacity', () => {
    const result = siteSchema.safeParse({ ...validSite, capacityKw: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects a non-uuid id', () => {
    const result = siteSchema.safeParse({ ...validSite, id: 'site-1' });
    expect(result.success).toBe(false);
  });
});

const validFleetSite = {
  ...validSite,
  origin: 'seed',
  createdAt: '2026-07-30T14:00:00Z',
  active: true,
};

/** Fixture builder: the same fleet site minus one field, for the required-field tests. */
function withoutField(site: Record<string, unknown>, field: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(site).filter(([name]) => name !== field));
}

describe('siteOriginSchema', () => {
  it.each(['seed', 'user'])('accepts origin %s', (origin) => {
    expect(siteOriginSchema.safeParse(origin).success).toBe(true);
  });

  it('rejects an origin outside the two the fleet knows about', () => {
    expect(siteOriginSchema.safeParse('imported').success).toBe(false);
  });
});

describe('fleetSiteSchema', () => {
  it.each(['seed', 'user'])('accepts a fleet site of origin %s', (origin) => {
    const result = fleetSiteSchema.safeParse({ ...validFleetSite, origin });

    expect(result.success).toBe(true);
    expect(result.data?.origin).toBe(origin);
  });

  // `origin` in particular: eviction (#29) exempts the seed fleet by this field,
  // so a site that reaches storage without one is not a site the fleet can hold.
  it.each(['origin', 'createdAt', 'active'])('rejects a fleet site missing %s', (field) => {
    expect(fleetSiteSchema.safeParse(withoutField(validFleetSite, field)).success).toBe(false);
  });

  it('rejects a createdAt that is not the fixed-width UTC form', () => {
    const result = fleetSiteSchema.safeParse({
      ...validFleetSite,
      createdAt: '2026-07-30T14:00:00.000Z',
    });

    expect(result.success).toBe(false);
  });

  it('inherits the physics constraints instead of redeclaring them', () => {
    expect(fleetSiteSchema.safeParse({ ...validFleetSite, latitude: 90.1 }).success).toBe(false);
    expect(fleetSiteSchema.safeParse({ ...validFleetSite, azimuthDegrees: 360 }).success).toBe(
      false,
    );
  });

  it('carries no key attributes — the adapter computes those and they never round-trip', () => {
    const result = fleetSiteSchema.safeParse({
      ...validFleetSite,
      pk: 'FLEET',
      locationId: '53.35,-6.26',
      gsiLocation: '53.35,-6.26',
    });

    expect(result.success).toBe(true);
    expect(result.data && Object.keys(result.data).sort()).toEqual([
      'active',
      'azimuthDegrees',
      'capacityKw',
      'createdAt',
      'id',
      'latitude',
      'longitude',
      'name',
      'origin',
      'tiltDegrees',
    ]);
  });
});
