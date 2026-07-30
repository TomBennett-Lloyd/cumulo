import { describe, expect, it } from 'vitest';

import { weatherSourceSchema } from './weather-source';

describe('weatherSourceSchema', () => {
  it('accepts open-meteo, the only provider in the fleet', () => {
    const result = weatherSourceSchema.safeParse('open-meteo');
    expect(result.success).toBe(true);
  });

  it('rejects a near-miss spelling rather than silently losing provenance', () => {
    const result = weatherSourceSchema.safeParse('openmeteo');
    expect(result.success).toBe(false);
  });
});
