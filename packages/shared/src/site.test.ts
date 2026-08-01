import { describe, expect, it } from 'vitest';

import { canonicalFleetSeed, generateFleet } from './fleet';
import { locationId } from './location';
import {
  createSiteInputSchema,
  fleetSiteSchema,
  MAX_USER_SITES,
  siteOriginSchema,
  siteSchema,
  type Site,
} from './site';

const validSite = {
  id: 'e7b8f8a0-3c2d-4e5f-9a1b-2c3d4e5f6a7b',
  name: 'Dublin rooftop 1',
  latitude: 53.3498,
  longitude: -6.2603,
  tiltDegrees: 30,
  azimuthDegrees: 180,
  capacityKw: 4.2,
};

/** Fixture builder: the same site minus one field, for the required-field tests. */
const withoutField = (site: Record<string, unknown>, field: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(site).filter(([name]) => name !== field));

/** The site's numeric fields — every field carrying a range bound. */
type NumericField = {
  [K in keyof Site]: Site[K] extends number ? K : never;
}[keyof Site];

type RangeCase = [field: NumericField, value: number, why: string];

type NameLengthCase = [length: number, why: string];

/** `name` is `.min(1).max(120)`; the name-length cases below are built from this. */
const nameMaxLength = 120;

/**
 * One row per range bound, driven through a table rather than a wall of
 * near-identical blocks. Each row is the first value outside its bound, so
 * deleting that bound makes exactly this row pass.
 */
const outOfRangeCases: readonly RangeCase[] = [
  ['latitude', 91, 'north of the north pole'],
  ['latitude', -91, 'south of the south pole'],
  ['longitude', 181, 'past the antimeridian going east'],
  ['longitude', -181, 'past the antimeridian going west'],
  ['tiltDegrees', -1, 'a roof cannot slope below horizontal'],
  ['tiltDegrees', 91, 'past vertical is the far side of the roof'],
  ['azimuthDegrees', -1, 'bearings are unsigned; 359 is the way to face just west of north'],
  ['azimuthDegrees', 360, 'a full turn must be normalized to 0'],
  ['capacityKw', 0, 'a site with no capacity is not a site'],
  ['capacityKw', 50.1, 'above the 50 kW residential-rooftop sanity ceiling'],
];

/**
 * The boundary values themselves. Most bounds are inclusive, so a `.gte`→`.gt`
 * or `.lte`→`.lt` slip rejects a legitimate site and fails here. Two are
 * deliberately exclusive — `azimuthDegrees < 360` and `capacityKw > 0` — and
 * their rows sit just inside the bound, pinning it against a mutant that
 * tightens the interval further.
 */
const boundaryCases: readonly RangeCase[] = [
  ['latitude', 90, 'the north pole is a real place'],
  ['latitude', -90, 'so is the south pole'],
  ['longitude', 180, 'the antimeridian is addressable'],
  ['longitude', -180, 'from either side'],
  ['tiltDegrees', 0, 'a flat roof, or ground-mounted panels laid horizontal'],
  ['tiltDegrees', 90, 'a wall-mounted vertical array'],
  ['azimuthDegrees', 0, 'due north, the inclusive end of the turn'],
  ['azimuthDegrees', 359.9, 'just inside the exclusive top of the turn'],
  ['capacityKw', 0.1, 'just above the exclusive floor — a single-panel micro-install'],
  ['capacityKw', 50, 'the 50 kW ceiling is itself a valid nameplate'],
];

/** `name` is a length bound rather than a range bound, so it gets its own pair of tables. */
const outOfLengthNameCases: readonly NameLengthCase[] = [
  [0, 'a site nobody can identify in the UI'],
  [nameMaxLength + 1, 'one character past the maximum'],
];

const boundaryNameCases: readonly NameLengthCase[] = [
  [1, 'the minimum length is inclusive'],
  [nameMaxLength, 'the maximum length is inclusive'],
];

describe('siteSchema', () => {
  it('accepts a typical residential site', () => {
    const result = siteSchema.safeParse(validSite);
    expect(result.success).toBe(true);
  });

  it.each(outOfRangeCases)('rejects %s of %s — %s', (field, value) => {
    const result = siteSchema.safeParse({ ...validSite, [field]: value });
    expect(result.success).toBe(false);
  });

  it.each(boundaryCases)('accepts %s of exactly %s — %s', (field, value) => {
    const result = siteSchema.safeParse({ ...validSite, [field]: value });
    expect(result.success).toBe(true);
  });

  it.each(outOfLengthNameCases)('rejects a name of %s characters — %s', (length) => {
    const result = siteSchema.safeParse({ ...validSite, name: 'a'.repeat(length) });
    expect(result.success).toBe(false);
  });

  it.each(boundaryNameCases)('accepts a name of exactly %s characters — %s', (length) => {
    const result = siteSchema.safeParse({ ...validSite, name: 'a'.repeat(length) });
    expect(result.success).toBe(true);
  });

  it('rejects a non-uuid id', () => {
    const result = siteSchema.safeParse({ ...validSite, id: 'site-1' });
    expect(result.success).toBe(false);
  });
});

const validCreateSiteInput = withoutField(validSite, 'id');

describe('createSiteInputSchema', () => {
  it('accepts a proposed site carrying every domain field but no id', () => {
    const result = createSiteInputSchema.safeParse(validCreateSiteInput);

    expect(result.success).toBe(true);
  });

  // Derived by `.omit`, so the physics bounds are the *same* bounds. Driving the
  // siteSchema table through this schema is the assertion: a bound relaxed on
  // the request shape alone — the classic parallel-DTO drift — fails here.
  it.each(outOfRangeCases)('rejects %s of %s — %s', (field, value) => {
    const result = createSiteInputSchema.safeParse({ ...validCreateSiteInput, [field]: value });

    expect(result.success).toBe(false);
  });

  it.each(boundaryCases)('accepts %s of exactly %s — %s', (field, value) => {
    const result = createSiteInputSchema.safeParse({ ...validCreateSiteInput, [field]: value });

    expect(result.success).toBe(true);
  });

  it('rejects a proposed site missing a required field', () => {
    const result = createSiteInputSchema.safeParse(
      withoutField(validCreateSiteInput, 'capacityKw'),
    );

    expect(result.success).toBe(false);
  });

  /**
   * The id belongs to the server. `.omit()` enforces that by *stripping* the
   * key rather than failing the parse, so this asserts on the parsed output: a
   * client that sends an id gets it dropped, not honoured, and nothing
   * downstream can mistake a caller's guess for an id.
   *
   * The exact key set, rather than only `id`'s absence, is what makes this bite
   * in both directions — a schema that dropped a real field, or grew one, fails
   * here too.
   */
  it('drops an id a caller tries to choose for itself, and keeps every other field', () => {
    const result = createSiteInputSchema.safeParse(validSite);

    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty('id');
    expect(result.data && Object.keys(result.data).sort()).toEqual([
      'azimuthDegrees',
      'capacityKw',
      'latitude',
      'longitude',
      'name',
      'tiltDegrees',
    ]);
  });
});

const validFleetSite = {
  ...validSite,
  origin: 'seed',
  createdAt: '2026-07-30T14:00:00Z',
  active: true,
};

describe('MAX_USER_SITES', () => {
  /** Open-Meteo's free tier, as CLAUDE.md states it. */
  const DAILY_CALL_ALLOWANCE = 10_000;
  const CYCLES_PER_DAY = 24;

  const seedFleet = generateFleet(canonicalFleetSeed);

  /**
   * The worst case, not the likely one: every user site at coordinates of its
   * own, so the fleet's location count grows one-for-one with the cap.
   *
   * The seed half is *computed* from the generated fleet rather than written
   * down, which is what makes these assertions load-bearing in both directions
   * — the cap is what they are here to bound, but a seed fleet that grew, or a
   * jitter box widened until a cluster stopped rounding into one bucket, moves
   * the same number and fails the same way.
   */
  const worstCaseLocations =
    new Set(seedFleet.map((site) => locationId(site))).size + MAX_USER_SITES;

  it('prices the worst case at 52 locations — the seed fleet’s own plus one bucket per user site', () => {
    expect(worstCaseLocations).toBe(52);

    // 100 is ingestion's `MAX_LOCATIONS_PER_CYCLE`, restated because packages
    // never import apps (architecture rule 1). The authoritative comparison, in
    // terms of the constant itself, is in `apps/ingestion/src/cycle-budget.test.ts`
    // — which is the side of the dependency edge that can see both numbers.
    expect(worstCaseLocations).toBeLessThanOrEqual(100);
  });

  it('keeps a full day of hourly cycles inside the Open-Meteo daily allowance', () => {
    expect(worstCaseLocations * CYCLES_PER_DAY).toBe(1_248);
    expect(worstCaseLocations * CYCLES_PER_DAY).toBeLessThanOrEqual(DAILY_CALL_ALLOWANCE);
  });

  it('keeps the whole fleet inside the largest size ADR 0002 priced for writes', () => {
    // 60 seed + 40 user = the ADR's 100-site headroom row, 14% of the free
    // write allowance. Raising the cap past this point is allowed, but not
    // silently: it means re-running that table, which is what this fails for.
    expect(seedFleet.length + MAX_USER_SITES).toBeLessThanOrEqual(100);
  });
});

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
