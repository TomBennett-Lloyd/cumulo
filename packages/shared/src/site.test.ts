import { describe, expect, it } from 'vitest';

import { siteSchema } from './site';

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
