import { describe, expect, it } from 'vitest';

import { weatherReadingSchema } from './weather-reading';

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

describe('weatherReadingSchema', () => {
  it('accepts a realistic Dublin noon forecast reading', () => {
    const result = weatherReadingSchema.safeParse(validReading);
    expect(result.success).toBe(true);
  });

  it('rejects negative shortwave radiation — irradiance has no negative branch', () => {
    const result = weatherReadingSchema.safeParse({
      ...validReading,
      shortwaveRadiationWm2: -1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects shortwave radiation above the 1500 W/m² sanity ceiling', () => {
    const result = weatherReadingSchema.safeParse({
      ...validReading,
      shortwaveRadiationWm2: 1501,
    });
    expect(result.success).toBe(false);
  });

  it('rejects direct radiation above the 1500 W/m² sanity ceiling', () => {
    const result = weatherReadingSchema.safeParse({
      ...validReading,
      directRadiationWm2: 1501,
    });
    expect(result.success).toBe(false);
  });

  it('rejects diffuse radiation above the 1500 W/m² sanity ceiling', () => {
    const result = weatherReadingSchema.safeParse({
      ...validReading,
      diffuseRadiationWm2: 1501,
    });
    expect(result.success).toBe(false);
  });

  it('rejects direct normal irradiance above the 1500 W/m² sanity ceiling', () => {
    const result = weatherReadingSchema.safeParse({
      ...validReading,
      directNormalIrradianceWm2: 1501,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a temperature above the 60 °C terrestrial-extreme ceiling', () => {
    const result = weatherReadingSchema.safeParse({ ...validReading, temperature2mC: 61 });
    expect(result.success).toBe(false);
  });

  it('rejects a wind speed above the 120 m/s sanity ceiling', () => {
    const result = weatherReadingSchema.safeParse({ ...validReading, windSpeed10mMs: 121 });
    expect(result.success).toBe(false);
  });

  it('rejects cloud cover above 100 percent', () => {
    const result = weatherReadingSchema.safeParse({ ...validReading, cloudCoverPct: 101 });
    expect(result.success).toBe(false);
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
