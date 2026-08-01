import { describe, expect, it } from 'vitest';

import { weatherMessageSchema } from './weather-message';

/**
 * The contract both ends of ADR 0004's queue are held to. Ingestion parses a
 * body on the way out and the forecast service parses it on the way in, so what
 * is asserted here is what each of them may assume: a non-empty array of
 * forecast readings, and nothing else.
 */

/** One schema-valid forecast hour for Dublin. */
const reading = (validTime: string): Record<string, unknown> => ({
  latitude: 53.35,
  longitude: -6.26,
  validTime,
  kind: 'forecast',
  source: 'open-meteo',
  shortwaveRadiationWm2: 400,
  directRadiationWm2: 250,
  diffuseRadiationWm2: 150,
  directNormalIrradianceWm2: 600,
  temperature2mC: 18,
  windSpeed10mMs: 3,
  cloudCoverPct: 40,
});

describe('weatherMessageSchema', () => {
  it("accepts one location's horizon of forecast readings", () => {
    const result = weatherMessageSchema.safeParse([
      reading('2026-07-31T00:00:00Z'),
      reading('2026-07-31T01:00:00Z'),
    ]);

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(2);
  });

  it('rejects an empty message, because a trigger carrying nothing is a silent no-op', () => {
    // The publisher refuses to send one; this is that refusal as a property of
    // the contract rather than of one sender.
    const result = weatherMessageSchema.safeParse([]);

    expect(result.success).toBe(false);
  });

  it('rejects an archive reading, which would mean the hindcast was wired into the live path', () => {
    const result = weatherMessageSchema.safeParse([
      { ...reading('2026-07-31T00:00:00Z'), kind: 'archive' },
    ]);

    expect(result.success).toBe(false);
  });

  it('rejects a reading outside the physical bounds rather than forecasting on it', () => {
    const result = weatherMessageSchema.safeParse([
      { ...reading('2026-07-31T00:00:00Z'), temperature2mC: 999 },
    ]);

    expect(result.success).toBe(false);
  });

  it('strips fields the reading schema does not define, so the wire format is the schema', () => {
    const result = weatherMessageSchema.safeParse([
      { ...reading('2026-07-31T00:00:00Z'), internalDebugTag: 'do-not-ship' },
    ]);

    expect(result.success).toBe(true);
    expect(result.data?.[0]).not.toHaveProperty('internalDebugTag');
  });
});
