import { describe, expect, it } from 'vitest';

import { RANELAGH_ID, RATHMINES_ID, fleetSite, ranelaghItem, without } from './site-fixtures';
import { COUNTERS_SORT_KEY, MIN_SITE_ID, fromItem, toItem, toUserSiteId } from './site-item';

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
      description: 'a seed site is in by-location only',
      origin: 'seed',
      indexAttributes: { gsiLocation: '53.32,-6.26' },
    },
    {
      description: 'a user site is in both indexes',
      origin: 'user',
      indexAttributes: {
        gsiLocation: '53.32,-6.26',
        gsiUserSites: 'USER',
        gsiCreatedAt: `2026-07-30T14:00:00Z#${RANELAGH_ID}`,
      },
    },
  ] as const;

  for (const { description, origin, indexAttributes } of sparseMatrix) {
    it(description, () => {
      const item: Record<string, unknown> = toItem(fleetSite({ origin }));
      const written = Object.fromEntries(
        Object.entries(item).filter(([attribute]) => attribute.startsWith('gsi')),
      );

      expect(written).toEqual(indexAttributes);
    });
  }
});

describe('fromItem', () => {
  for (const origin of ['seed', 'user'] as const) {
    it(`round-trips a ${origin} site`, () => {
      const site = fleetSite({ origin });

      expect(fromItem(toItem(site))).toEqual(site);
    });
  }

  it('returns no key attributes as domain fields', () => {
    expect(Object.keys(fromItem(ranelaghItem)).sort()).toEqual([
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

/**
 * DynamoDB's sort-key comparison, as a plain string comparison over widened
 * types — the literal-typed operands of a direct `<` would be folded by the
 * compiler, which is a check on the constants as written rather than on the
 * ordering they rely on.
 */
const sortsBefore = (left: string, right: string): boolean => left < right;

describe('COUNTERS_SORT_KEY', () => {
  it('sorts before every possible site id, so the counter cannot leak into the fleet list', () => {
    // `listFleetSites` excludes non-site items by range condition rather than
    // by filter, and this ordering is the whole mechanism: '#' (0x23) sorts
    // before '0' (0x30), which is the lowest character a uuid can start with.
    // If the counter key ever stopped satisfying this, the fleet list would
    // start handing `fleetSiteSchema.parse` a counter item.
    expect(sortsBefore(COUNTERS_SORT_KEY, MIN_SITE_ID)).toBe(true);
    for (const siteId of [RANELAGH_ID, RATHMINES_ID, '0', '00000000-0000-4000-8000-000000000000']) {
      expect(sortsBefore(COUNTERS_SORT_KEY, siteId)).toBe(true);
    }
  });
});

describe('toUserSiteId', () => {
  it('takes the base-table id out of a KEYS_ONLY index hit', () => {
    // What `user-sites-by-age` actually projects: both index keys and both
    // table keys, and nothing else.
    expect(
      toUserSiteId({
        gsiUserSites: 'USER',
        gsiCreatedAt: `2026-07-29T09:30:00Z#${RATHMINES_ID}`,
        pk: 'FLEET',
        siteId: RATHMINES_ID,
      }),
    ).toBe(RATHMINES_ID);
  });

  it('refuses a hit with no id rather than returning one to evict', () => {
    expect(() => toUserSiteId({ gsiUserSites: 'USER' })).toThrow();
    expect(() => toUserSiteId({ siteId: '' })).toThrow();
  });
});
