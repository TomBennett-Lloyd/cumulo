import { describe, expect, it } from 'vitest';

import { generationReadingSchema } from './generation-reading';

const validReading = {
  siteId: 'e7b8f8a0-3c2d-4e5f-9a1b-2c3d4e5f6a7b',
  validTime: '2026-07-30T14:00:00Z',
  acPowerKw: 3.1,
};

describe('generationReadingSchema', () => {
  it('accepts a mid-afternoon reading from a residential site', () => {
    const result = generationReadingSchema.safeParse(validReading);
    expect(result.success).toBe(true);
  });

  it('accepts a night-time zero-generation reading', () => {
    const result = generationReadingSchema.safeParse({ ...validReading, acPowerKw: 0 });
    expect(result.success).toBe(true);
  });

  it('accepts a reading at exactly the 50 kW cap — output clips at nameplate', () => {
    const result = generationReadingSchema.safeParse({ ...validReading, acPowerKw: 50 });
    expect(result.success).toBe(true);
  });

  it('rejects negative AC power — a site does not generate backwards', () => {
    const result = generationReadingSchema.safeParse({ ...validReading, acPowerKw: -0.1 });
    expect(result.success).toBe(false);
  });

  it('rejects AC power above the 50 kW residential sanity cap', () => {
    const result = generationReadingSchema.safeParse({ ...validReading, acPowerKw: 51 });
    expect(result.success).toBe(false);
  });

  it('rejects a non-uuid siteId', () => {
    const result = generationReadingSchema.safeParse({ ...validReading, siteId: 'site-1' });
    expect(result.success).toBe(false);
  });

  it('rejects a validTime with fractional seconds', () => {
    const result = generationReadingSchema.safeParse({
      ...validReading,
      validTime: '2026-07-30T14:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });
});
