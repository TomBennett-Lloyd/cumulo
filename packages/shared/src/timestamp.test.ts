import { describe, expect, it } from 'vitest';

import { utcIsoTimestampSchema } from './timestamp';

describe('utcIsoTimestampSchema', () => {
  it('accepts a UTC instant given to whole seconds', () => {
    const result = utcIsoTimestampSchema.safeParse('2026-07-30T14:00:00Z');
    expect(result.success).toBe(true);
  });

  it('rejects fractional seconds — they break fixed-width lexicographic ordering', () => {
    const result = utcIsoTimestampSchema.safeParse('2026-07-30T14:00:00.000Z');
    expect(result.success).toBe(false);
  });

  it('rejects minute-only precision — seconds are not optional', () => {
    const result = utcIsoTimestampSchema.safeParse('2026-07-30T14:00Z');
    expect(result.success).toBe(false);
  });

  it('rejects a numeric UTC offset — only the Z designator is allowed', () => {
    const result = utcIsoTimestampSchema.safeParse('2026-07-30T14:00:00+00:00');
    expect(result.success).toBe(false);
  });

  it('rejects a timestamp with no zone designator', () => {
    const result = utcIsoTimestampSchema.safeParse('2026-07-30T14:00:00');
    expect(result.success).toBe(false);
  });
});
