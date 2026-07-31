import { describe, expect, it } from 'vitest';

import { RANELAGH_ID, fleetSite, ranelaghItem, without } from './site-fixtures';
import { fromItem, toItem } from './site-item';

/**
 * The key-attribute logic carries the real risk here — the sparse GSI
 * attributes and what does *not* survive the trip back into the domain — and it
 * is pure, so it is pinned directly on `toItem`/`fromItem` rather than only
 * through the adapter (`docs/standards/testing.md` rule 2).
 */

describe('toItem', () => {
  it('renames id to the siteId key attribute and computes pk and locationId', () => {
    expect(toItem(fleetSite())).toEqual(ranelaghItem);
  });

  const sparseMatrix = [
    {
      description: 'an active seed site is in by-location only',
      overrides: { origin: 'seed', active: true },
      indexAttributes: { gsiLocation: '53.32,-6.26' },
    },
    {
      description: 'an inactive seed site is in neither index',
      overrides: { origin: 'seed', active: false },
      indexAttributes: {},
    },
    {
      description: 'an active user site is in both indexes',
      overrides: { origin: 'user', active: true },
      indexAttributes: {
        gsiLocation: '53.32,-6.26',
        gsiUserSites: 'USER',
        gsiCreatedAt: `2026-07-30T14:00:00Z#${RANELAGH_ID}`,
      },
    },
    {
      description: 'an inactive user site stays evictable but leaves by-location',
      overrides: { origin: 'user', active: false },
      indexAttributes: {
        gsiUserSites: 'USER',
        gsiCreatedAt: `2026-07-30T14:00:00Z#${RANELAGH_ID}`,
      },
    },
  ] as const;

  for (const { description, overrides, indexAttributes } of sparseMatrix) {
    it(description, () => {
      const item: Record<string, unknown> = toItem(fleetSite(overrides));
      const written = Object.fromEntries(
        Object.entries(item).filter(([attribute]) => attribute.startsWith('gsi')),
      );

      expect(written).toEqual(indexAttributes);
    });
  }
});

describe('fromItem', () => {
  const roundTrips = [
    { description: 'seed and active', overrides: { origin: 'seed', active: true } },
    { description: 'seed and inactive', overrides: { origin: 'seed', active: false } },
    { description: 'user and active', overrides: { origin: 'user', active: true } },
    { description: 'user and inactive', overrides: { origin: 'user', active: false } },
  ] as const;

  for (const { description, overrides } of roundTrips) {
    it(`round-trips a site that is ${description}`, () => {
      const site = fleetSite(overrides);

      expect(fromItem(toItem(site))).toEqual(site);
    });
  }

  it('returns no key attributes as domain fields', () => {
    expect(Object.keys(fromItem(ranelaghItem)).sort()).toEqual([
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

  it('throws on an item the schema does not recognise', () => {
    expect(() => fromItem(without(ranelaghItem, 'origin'))).toThrow();
    expect(() => fromItem({ ...ranelaghItem, capacityKw: '4.2' })).toThrow();
  });
});
