import { utcIsoTimestampSchema, type UtcWindow } from '@cumulo/shared';
import { describe, expect, it } from 'vitest';

import { contiguousDayRuns, utcDaysCovering } from './archive-days';

/**
 * Calendar arithmetic is pure, so it gets dense edge-case tests rather than a
 * happy path (`docs/standards/testing.md` rule 2). The edges that matter here are
 * the ones a hindcast actually meets: a window that ends on a day boundary, and
 * month/year/leap-day rollovers, which is where naive `+1 day` string arithmetic
 * breaks.
 */
const period = (startInclusive: string, endExclusive: string): UtcWindow => ({
  startInclusive: utcIsoTimestampSchema.parse(startInclusive),
  endExclusive: utcIsoTimestampSchema.parse(endExclusive),
});

describe('utcDaysCovering', () => {
  it('covers the single day a window inside one day falls on', () => {
    expect(utcDaysCovering(period('2026-06-01T09:00:00Z', '2026-06-01T17:00:00Z'))).toEqual([
      '2026-06-01',
    ]);
  });

  it('excludes the day an endExclusive of exactly midnight starts', () => {
    expect(utcDaysCovering(period('2026-06-01T00:00:00Z', '2026-06-02T00:00:00Z'))).toEqual([
      '2026-06-01',
    ]);
  });

  it('includes the final day when the window ends one second into it', () => {
    expect(utcDaysCovering(period('2026-06-01T00:00:00Z', '2026-06-02T00:00:01Z'))).toEqual([
      '2026-06-01',
      '2026-06-02',
    ]);
  });

  it('covers every day a multi-day window touches, in chronological order', () => {
    expect(utcDaysCovering(period('2026-06-01T23:00:00Z', '2026-06-04T01:00:00Z'))).toEqual([
      '2026-06-01',
      '2026-06-02',
      '2026-06-03',
      '2026-06-04',
    ]);
  });

  it('rolls over a month boundary', () => {
    expect(utcDaysCovering(period('2026-01-31T12:00:00Z', '2026-02-01T12:00:00Z'))).toEqual([
      '2026-01-31',
      '2026-02-01',
    ]);
  });

  it('rolls over a year boundary', () => {
    expect(utcDaysCovering(period('2025-12-31T12:00:00Z', '2026-01-01T12:00:00Z'))).toEqual([
      '2025-12-31',
      '2026-01-01',
    ]);
  });

  it('includes 29 February in a leap year', () => {
    expect(utcDaysCovering(period('2024-02-28T00:00:00Z', '2024-03-01T00:00:00Z'))).toEqual([
      '2024-02-28',
      '2024-02-29',
    ]);
  });

  it('skips a 29 February that does not exist', () => {
    expect(utcDaysCovering(period('2026-02-28T00:00:00Z', '2026-03-01T00:00:00Z'))).toEqual([
      '2026-02-28',
    ]);
  });

  it('covers nothing for an empty window, not the day its bounds sit in', () => {
    expect(utcDaysCovering(period('2026-06-01T09:00:00Z', '2026-06-01T09:00:00Z'))).toEqual([]);
  });

  it('covers nothing for an inverted window', () => {
    expect(utcDaysCovering(period('2026-06-05T00:00:00Z', '2026-06-01T00:00:00Z'))).toEqual([]);
  });

  it('counts a whole year of days', () => {
    expect(utcDaysCovering(period('2024-01-01T00:00:00Z', '2025-01-01T00:00:00Z'))).toHaveLength(
      366,
    );
  });
});

describe('contiguousDayRuns', () => {
  it('joins consecutive days into one closed run', () => {
    expect(contiguousDayRuns(['2026-06-01', '2026-06-02', '2026-06-03'], 31)).toEqual([
      { firstDay: '2026-06-01', lastDay: '2026-06-03' },
    ]);
  });

  it('splits on a calendar gap', () => {
    expect(contiguousDayRuns(['2026-06-01', '2026-06-02', '2026-06-05', '2026-06-06'], 31)).toEqual(
      [
        { firstDay: '2026-06-01', lastDay: '2026-06-02' },
        { firstDay: '2026-06-05', lastDay: '2026-06-06' },
      ],
    );
  });

  it('splits at the maximum run length even with no gap', () => {
    expect(
      contiguousDayRuns(['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05'], 2),
    ).toEqual([
      { firstDay: '2026-06-01', lastDay: '2026-06-02' },
      { firstDay: '2026-06-03', lastDay: '2026-06-04' },
      { firstDay: '2026-06-05', lastDay: '2026-06-05' },
    ]);
  });

  it('sorts and de-duplicates before splitting, so a repeated day cannot break a run', () => {
    expect(contiguousDayRuns(['2026-06-03', '2026-06-01', '2026-06-02', '2026-06-01'], 31)).toEqual(
      [{ firstDay: '2026-06-01', lastDay: '2026-06-03' }],
    );
  });

  it('treats days either side of a month boundary as contiguous', () => {
    expect(contiguousDayRuns(['2026-02-01', '2026-01-31'], 31)).toEqual([
      { firstDay: '2026-01-31', lastDay: '2026-02-01' },
    ]);
  });

  it('treats 28 February and 1 March as contiguous outside a leap year', () => {
    expect(contiguousDayRuns(['2026-02-28', '2026-03-01'], 31)).toEqual([
      { firstDay: '2026-02-28', lastDay: '2026-03-01' },
    ]);
  });

  it('leaves a gap where a leap day is missing from the input', () => {
    expect(contiguousDayRuns(['2024-02-28', '2024-03-01'], 31)).toEqual([
      { firstDay: '2024-02-28', lastDay: '2024-02-28' },
      { firstDay: '2024-03-01', lastDay: '2024-03-01' },
    ]);
  });

  it('returns no runs for no days', () => {
    expect(contiguousDayRuns([], 31)).toEqual([]);
  });

  it('rejects a maximum run length no run could satisfy', () => {
    expect(() => contiguousDayRuns(['2026-06-01'], 0)).toThrow(/positive integer/u);
    expect(() => contiguousDayRuns(['2026-06-01'], 1.5)).toThrow(/positive integer/u);
  });

  it('rejects a day that is not zero-padded YYYY-MM-DD', () => {
    expect(() => contiguousDayRuns(['2026-6-1'], 31)).toThrow(/YYYY-MM-DD/u);
  });
});
