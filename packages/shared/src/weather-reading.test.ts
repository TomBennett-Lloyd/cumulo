import { describe, expect, it } from 'vitest';

import { weatherReadingSchema, type WeatherReading } from './weather-reading';

/**
 * A Dublin midsummer noon hour — plausible clear-ish sky values, everything but
 * `kind`, so the missing-`kind` case below is an omission by construction rather
 * than a delete after the fact.
 */
const readingWithoutKind = {
  latitude: 53.3498,
  longitude: -6.2603,
  validTime: '2026-07-30T12:00:00Z',
  source: 'open-meteo',
  shortwaveRadiationWm2: 414,
  directRadiationWm2: 219,
  diffuseRadiationWm2: 195,
  directNormalIrradianceWm2: 520,
  temperature2mC: 18.8,
  windSpeed10mMs: 3.6,
  cloudCoverPct: 66,
};

const validReading = { ...readingWithoutKind, kind: 'forecast' };

/** The reading's numeric fields — every field carrying a range bound. */
type NumericField = {
  [K in keyof WeatherReading]: WeatherReading[K] extends number ? K : never;
}[keyof WeatherReading];

type RangeCase = [field: NumericField, value: number, why: string];

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
  ['shortwaveRadiationWm2', -1, 'irradiance has no negative branch'],
  ['shortwaveRadiationWm2', 1501, 'above the 1500 W/m² sanity ceiling'],
  ['directRadiationWm2', -1, 'irradiance has no negative branch'],
  ['directRadiationWm2', 1501, 'above the 1500 W/m² sanity ceiling'],
  ['diffuseRadiationWm2', -1, 'irradiance has no negative branch'],
  ['diffuseRadiationWm2', 1501, 'above the 1500 W/m² sanity ceiling'],
  ['directNormalIrradianceWm2', -1, 'irradiance has no negative branch'],
  ['directNormalIrradianceWm2', 1501, 'above the 1500 W/m² sanity ceiling'],
  ['temperature2mC', -91, 'colder than the Vostok record'],
  ['temperature2mC', 61, 'above the 60 °C terrestrial-extreme ceiling'],
  ['windSpeed10mMs', -1, 'speed is unsigned; direction is a separate axis'],
  ['windSpeed10mMs', 121, 'above the 120 m/s sanity ceiling'],
  ['cloudCoverPct', -1, 'a percentage floor of zero'],
  ['cloudCoverPct', 101, 'a percentage ceiling of one hundred'],
];

/**
 * Every bound is inclusive; these rows are the boundary values themselves, so a
 * `.gte`→`.gt` or `.lte`→`.lt` slip rejects a legitimate reading and fails here.
 */
const boundaryCases: readonly RangeCase[] = [
  ['latitude', 90, 'the north pole is a real place'],
  ['latitude', -90, 'so is the south pole'],
  ['longitude', 180, 'the antimeridian is addressable'],
  ['longitude', -180, 'from either side'],
  ['shortwaveRadiationWm2', 0, 'night'],
  ['shortwaveRadiationWm2', 1500, 'the cloud-enhancement headroom reaches the cap itself'],
  ['directRadiationWm2', 0, 'night, or fully diffuse overcast'],
  ['directRadiationWm2', 1500, 'the cap is a sanity ceiling, not a rejection threshold'],
  ['diffuseRadiationWm2', 0, 'night'],
  ['diffuseRadiationWm2', 1500, 'the cap is a sanity ceiling, not a rejection threshold'],
  ['directNormalIrradianceWm2', 0, 'night'],
  ['directNormalIrradianceWm2', 1500, 'the cap is a sanity ceiling, not a rejection threshold'],
  ['temperature2mC', -90, 'the Vostok record is a valid reading'],
  ['temperature2mC', 60, 'so is the Furnace Creek end'],
  ['windSpeed10mMs', 0, 'dead calm is the commonest still-air hour'],
  ['windSpeed10mMs', 120, 'the sanity ceiling is itself a readable speed'],
  ['cloudCoverPct', 0, 'a cloudless sky'],
  ['cloudCoverPct', 100, 'full overcast'],
];

describe('weatherReadingSchema', () => {
  it('accepts a realistic Dublin noon forecast reading', () => {
    const result = weatherReadingSchema.safeParse(validReading);
    expect(result.success).toBe(true);
  });

  it.each(outOfRangeCases)('rejects %s of %s — %s', (field, value) => {
    const result = weatherReadingSchema.safeParse({ ...validReading, [field]: value });
    expect(result.success).toBe(false);
  });

  it.each(boundaryCases)('accepts %s of exactly %s — %s', (field, value) => {
    const result = weatherReadingSchema.safeParse({ ...validReading, [field]: value });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown weather source', () => {
    const result = weatherReadingSchema.safeParse({ ...validReading, source: 'met-eireann' });
    expect(result.success).toBe(false);
  });

  it('rejects a validTime carrying a numeric offset rather than Z', () => {
    const result = weatherReadingSchema.safeParse({
      ...validReading,
      validTime: '2026-07-30T12:00:00+01:00',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a reading with no kind — forecast and archive must never be conflated', () => {
    const result = weatherReadingSchema.safeParse(readingWithoutKind);
    expect(result.success).toBe(false);
  });
});
