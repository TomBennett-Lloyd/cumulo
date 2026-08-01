import { locationId } from '@cumulo/shared';
import { describe, expect, it } from 'vitest';

import { toItem } from '../../src/adapters/site/site-item';

import { SEED_CREATED_AT, buildSeedFleet } from './seed-sites';

/**
 * What the operator seed script relies on, pinned where it is cheap to pin.
 *
 * `seed-fleet.ts` itself needs a live table and an operator session, so it is
 * absent from `pnpm test` — but everything it depends on being true is pure, and
 * lives here: the fleet's size and shape, its determinism (which is what makes a
 * re-run an idempotent overwrite rather than 60 rewritten rows), the weather
 * budget its co-location buys, and the structural eviction exemption that is the
 * whole reason the demo fleet is safe to leave in a table alongside user sites.
 */

const fleet = buildSeedFleet();

describe('buildSeedFleet', () => {
  it('builds the 60 canonical sites', () => {
    expect(fleet).toHaveLength(60);
  });

  it('marks every site as seed-origin', () => {
    expect(fleet.every((site) => site.origin === 'seed')).toBe(true);
  });

  it('marks every site active, so the whole fleet is forecast', () => {
    expect(fleet.every((site) => site.active)).toBe(true);
  });

  it('stamps every site with the canonical seed date', () => {
    expect(fleet.every((site) => site.createdAt === SEED_CREATED_AT)).toBe(true);
  });

  it('is deterministic, so re-seeding overwrites each site with itself', () => {
    // The idempotence claim in `seed-fleet.ts`: `putFleetSite` is a plain
    // overwrite, so "safe to re-run" is exactly "two builds are equal".
    expect(buildSeedFleet()).toEqual(buildSeedFleet());
  });

  it('covers exactly 12 locations, so one cycle costs 12 Open-Meteo calls', () => {
    const locations = new Set(fleet.map((site) => locationId(site)));
    expect(locations.size).toBe(12);
  });
});

describe('the stored form of a seed site', () => {
  it('carries no gsiUserSites attribute, so eviction cannot see the seed fleet', () => {
    // The #29 cap evicts by querying `user-sites-by-age`. An item without the
    // index's partition attribute is not in the index, so no filter, no flag and
    // no future caller can select a seed site for eviction — the exemption is
    // structural. This is the assertion that would fail first if `origin` were
    // ever dropped from the seed build.
    const withUserPartition = fleet.filter((site) => 'gsiUserSites' in toItem(site));
    expect(withUserPartition).toEqual([]);
  });

  it('carries no gsiCreatedAt attribute, the eviction sort key', () => {
    const withEvictionOrder = fleet.filter((site) => 'gsiCreatedAt' in toItem(site));
    expect(withEvictionOrder).toEqual([]);
  });

  it('carries gsiLocation, so the forecast cycle finds it by location', () => {
    const missingLocationIndex = fleet.filter((site) => toItem(site).gsiLocation === undefined);
    expect(missingLocationIndex).toEqual([]);
  });
});
