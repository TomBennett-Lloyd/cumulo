import { utcIsoTimestampSchema } from '@cumulo/shared';
import { describe, expect, it } from 'vitest';

import { SERIES_RETENTION_DAYS, expiresAtEpochSeconds } from './ttl';

const at = (instant: string) => utcIsoTimestampSchema.parse(instant);

describe('expiresAtEpochSeconds', () => {
  it('is the instant plus the retention window, in whole epoch seconds', () => {
    // 2026-07-30T14:00:00Z is epoch 1_785_420_000; + 90 * 86400 = 1_793_196_000,
    // which is 2026-10-28T14:00:00Z.
    expect(expiresAtEpochSeconds(at('2026-07-30T14:00:00Z'), SERIES_RETENTION_DAYS)).toBe(
      1_793_196_000,
    );
  });

  it('counts days as exactly 86400 seconds across a local DST boundary', () => {
    // 29 March 2026 is the European clock change. In UTC it is an ordinary day,
    // and TTL arithmetic must agree: 2026-03-28T23:00:00Z + 2 days is
    // 2026-03-30T23:00:00Z, not an hour either side of it.
    expect(expiresAtEpochSeconds(at('2026-03-28T23:00:00Z'), 2)).toBe(1_774_911_600);
  });

  it('produces seconds, not milliseconds — DynamoDB never expires a millisecond TTL', () => {
    const expiresAt = expiresAtEpochSeconds(at('2026-07-30T14:00:00Z'), 1);

    expect(Number.isInteger(expiresAt)).toBe(true);
    // A millisecond value for the same instant would be ~1.79e12.
    expect(expiresAt).toBeLessThan(1e11);
  });

  it('handles the epoch itself', () => {
    expect(expiresAtEpochSeconds(at('1970-01-01T00:00:00Z'), 1)).toBe(86_400);
  });

  it('refuses a retention window that is not a positive whole number of days', () => {
    const validTime = at('2026-07-30T14:00:00Z');

    expect(() => expiresAtEpochSeconds(validTime, 0)).toThrow(/positive integer/);
    expect(() => expiresAtEpochSeconds(validTime, -90)).toThrow(/positive integer/);
    expect(() => expiresAtEpochSeconds(validTime, 1.5)).toThrow(/positive integer/);
  });
});

describe('SERIES_RETENTION_DAYS', () => {
  it('is the 90-day accuracy-tracking window ADR 0002 sized the table for', () => {
    expect(SERIES_RETENTION_DAYS).toBe(90);
  });
});
