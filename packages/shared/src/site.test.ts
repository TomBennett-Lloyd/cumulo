import { describe, expect, it } from 'vitest';

import { siteSchema, type Site } from './site';

const validSite = {
  id: 'e7b8f8a0-3c2d-4e5f-9a1b-2c3d4e5f6a7b',
  name: 'Dublin rooftop 1',
  latitude: 53.3498,
  longitude: -6.2603,
  tiltDegrees: 30,
  azimuthDegrees: 180,
  capacityKw: 4.2,
};

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
