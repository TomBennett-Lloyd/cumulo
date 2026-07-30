import { describe, expect, it } from 'vitest';

import { forecastSchema } from './forecast';

const forecastMissingWeatherSource = {
  siteId: 'e7b8f8a0-3c2d-4e5f-9a1b-2c3d4e5f6a7b',
  model: 'physics',
  validTime: '2026-07-30T14:00:00Z',
  issuedAt: '2026-07-30T06:00:00Z',
  poaIrradianceWm2: 612.4,
  acPowerKw: 2.7,
};

const validForecast = { ...forecastMissingWeatherSource, weatherSource: 'open-meteo' };

describe('forecastSchema', () => {
  it('accepts a physics point forecast with no uncertainty band', () => {
    const result = forecastSchema.safeParse(validForecast);

    expect(result.success).toBe(true);
    expect(result.data?.uncertainty).toBeUndefined();
  });

  it('accepts an ml forecast carrying both quantiles of an uncertainty band', () => {
    const result = forecastSchema.safeParse({
      ...validForecast,
      model: 'ml',
      uncertainty: { p10AcPowerKw: 1.1, p90AcPowerKw: 3.2 },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an inverted band where p10 exceeds p90', () => {
    const result = forecastSchema.safeParse({
      ...validForecast,
      model: 'ml',
      uncertainty: { p10AcPowerKw: 3.2, p90AcPowerKw: 1.1 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a model outside the physics/ml pair', () => {
    const result = forecastSchema.safeParse({ ...validForecast, model: 'persistence' });
    expect(result.success).toBe(false);
  });

  it('rejects negative ac power — a site never consumes through its inverter', () => {
    const result = forecastSchema.safeParse({ ...validForecast, acPowerKw: -0.1 });
    expect(result.success).toBe(false);
  });

  it('rejects a non-uuid siteId', () => {
    const result = forecastSchema.safeParse({ ...validForecast, siteId: 'site-1' });
    expect(result.success).toBe(false);
  });

  it('rejects a forecast missing its weatherSource, which would lose attribution provenance', () => {
    const result = forecastSchema.safeParse(forecastMissingWeatherSource);
    expect(result.success).toBe(false);
  });
});
