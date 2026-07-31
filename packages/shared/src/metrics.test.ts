import { describe, expect, it } from 'vitest';

import * as packageSurface from './index';
import {
  alignByValidTime,
  baselineSchema,
  errorMetricsSchema,
  meanAbsoluteErrorKw,
  PERSISTENCE_24H,
  persistenceBaselineSeries,
  rootMeanSquareErrorKw,
  skillScore,
  type AlignedPair,
  type ErrorMetrics,
  type TimedPowerPoint,
} from './metrics';
import { metricsSortKey } from './storage-key';
import { utcIsoTimestampSchema } from './timestamp';

const siteId = '11111234-1111-4111-8111-111111111111';

const elevenPm = '2026-07-30T23:00:00Z';
const midnight = '2026-07-31T00:00:00Z';
const noon = '2026-07-31T12:00:00Z';
const onePm = '2026-07-31T13:00:00Z';
const twoPm = '2026-07-31T14:00:00Z';

/**
 * Timestamps go through `utcIsoTimestampSchema.parse`, the only cast-free way to obtain the branded
 * type, so a fixture that could not exist in production cannot be built here either.
 */
const at = (validTime: string, acPowerKw: number): TimedPowerPoint => ({
  validTime: utcIsoTimestampSchema.parse(validTime),
  acPowerKw,
});

/** Hourly series from a start instant, one point per value given. */
const hourlySeries = (startInclusive: string, acPowerKws: readonly number[]): TimedPowerPoint[] =>
  acPowerKws.map((acPowerKw, index) =>
    at(
      new Date(Date.parse(startInclusive) + index * 3_600_000).toISOString().replace('.000Z', 'Z'),
      acPowerKw,
    ),
  );

const validTimesOf = (points: readonly (TimedPowerPoint | AlignedPair)[]): readonly string[] =>
  points.map((point) => point.validTime);

const validMetrics = {
  siteId,
  model: 'physics',
  period: { startInclusive: noon, endExclusive: twoPm },
  baseline: PERSISTENCE_24H,
  maeKw: 0.42,
  rmseKw: 0.61,
  skillScore: 0.35,
  sampleCount: 24,
  computedAt: '2026-08-01T00:00:00Z',
};

describe('alignByValidTime', () => {
  it('drops instants present in only one series and keeps the matched ones', () => {
    const pairs = alignByValidTime(
      [at(noon, 3), at(onePm, 4), at(twoPm, 5)],
      [at(onePm, 3.5), at(twoPm, 6), at('2026-07-31T15:00:00Z', 1)],
    );

    expect(pairs).toHaveLength(2);
    expect(validTimesOf(pairs)).toEqual([onePm, twoPm]);
    expect(pairs).toEqual([
      { validTime: onePm, forecastKw: 4, observedKw: 3.5 },
      { validTime: twoPm, forecastKw: 5, observedKw: 6 },
    ]);
  });

  it('returns no pairs when two series of unequal length share no instant', () => {
    expect(alignByValidTime([at(noon, 3)], [at(onePm, 1), at(twoPm, 2)])).toEqual([]);
  });

  it('returns pairs in chronological order whatever order the inputs arrive in', () => {
    const pairs = alignByValidTime(
      [at(twoPm, 1), at(noon, 2), at(onePm, 3)],
      [at(onePm, 1), at(twoPm, 1), at(noon, 1)],
    );

    expect(validTimesOf(pairs)).toEqual([noon, onePm, twoPm]);
  });

  it('throws when the forecast series repeats a validTime', () => {
    expect(() => alignByValidTime([at(noon, 3), at(noon, 4)], [at(noon, 3)])).toThrow(
      /Duplicate validTime in forecast series/,
    );
  });

  it('throws when the observed series repeats a validTime', () => {
    expect(() => alignByValidTime([at(noon, 3)], [at(noon, 3), at(noon, 3)])).toThrow(
      /Duplicate validTime in observed series/,
    );
  });
});

describe('meanAbsoluteErrorKw and rootMeanSquareErrorKw', () => {
  it('both throw on an empty set of pairs rather than reporting zero error', () => {
    expect(() => meanAbsoluteErrorKw([])).toThrow(/empty set of aligned pairs/);
    expect(() => rootMeanSquareErrorKw([])).toThrow(/empty set of aligned pairs/);
  });

  it('both equal the absolute difference for a single pair', () => {
    const pairs = alignByValidTime([at(noon, 3.25)], [at(noon, 5)]);

    expect(meanAbsoluteErrorKw(pairs)).toBeCloseTo(1.75, 12);
    expect(rootMeanSquareErrorKw(pairs)).toBeCloseTo(1.75, 12);
  });

  it('both report zero for an all-zero polar-night day, in which no error is possible', () => {
    const darkHours = Array.from({ length: 26 }, () => 0);
    const observed = hourlySeries(midnight, darkHours);
    const pairs = alignByValidTime(hourlySeries(midnight, darkHours), observed);

    expect(pairs).toHaveLength(26);
    expect(meanAbsoluteErrorKw(pairs)).toBe(0);
    expect(rootMeanSquareErrorKw(pairs)).toBe(0);
  });

  it('weights a single large miss more heavily in RMSE than in MAE', () => {
    const pairs = alignByValidTime(
      [at(noon, 0), at(onePm, 0), at(twoPm, 0)],
      [at(noon, 0), at(onePm, 0), at(twoPm, 3)],
    );

    expect(meanAbsoluteErrorKw(pairs)).toBe(1);
    expect(rootMeanSquareErrorKw(pairs)).toBeCloseTo(Math.sqrt(3), 12);
  });
});

describe('skillScore', () => {
  it('is 0 for a forecast exactly as wrong as the baseline', () => {
    expect(skillScore({ modelRmseKw: 2.5, baselineRmseKw: 2.5 })).toBe(0);
  });

  it('is 1 for a perfect forecast measured against a baseline that erred', () => {
    expect(skillScore({ modelRmseKw: 0, baselineRmseKw: 2.5 })).toBe(1);
  });

  it('is negative for a forecast worse than the baseline', () => {
    expect(skillScore({ modelRmseKw: 5, baselineRmseKw: 2.5 })).toBe(-1);
  });

  it('is null when the baseline made no error, rather than reporting zero skill', () => {
    expect(skillScore({ modelRmseKw: 1.5, baselineRmseKw: 0 })).toBeNull();
    expect(skillScore({ modelRmseKw: 0, baselineRmseKw: 0 })).toBeNull();
  });

  it('is null for a polar-night day, where the persistence baseline is exactly right', () => {
    const observed = hourlySeries(
      midnight,
      Array.from({ length: 26 }, () => 0),
    );
    const baselinePairs = alignByValidTime(persistenceBaselineSeries(observed), observed);

    expect(baselinePairs).toHaveLength(2);
    expect(
      skillScore({
        modelRmseKw: rootMeanSquareErrorKw(alignByValidTime(observed, observed)),
        baselineRmseKw: rootMeanSquareErrorKw(baselinePairs),
      }),
    ).toBeNull();
  });
});

describe('persistenceBaselineSeries', () => {
  it('carries each observation forward 24 hours across a UTC day and month boundary', () => {
    const baseline = persistenceBaselineSeries([at(elevenPm, 1.5), at(midnight, 2.5)]);

    expect(baseline).toEqual([
      { validTime: '2026-07-31T23:00:00Z', acPowerKw: 1.5 },
      { validTime: '2026-08-01T00:00:00Z', acPowerKw: 2.5 },
    ]);
  });

  it('shifts by a caller-supplied offset when the default does not apply', () => {
    expect(persistenceBaselineSeries([at(elevenPm, 4)], 1)).toEqual([
      { validTime: midnight, acPowerKw: 4 },
    ]);
  });

  it('yields nothing overlapping the observations it came from within a single day', () => {
    const observed = hourlySeries(midnight, [1, 2, 3]);

    expect(alignByValidTime(persistenceBaselineSeries(observed), observed)).toEqual([]);
  });

  it('produces no points for no observations', () => {
    expect(persistenceBaselineSeries([])).toEqual([]);
  });

  it('shifts by a sub-hour offset that still lands on a whole second', () => {
    expect(persistenceBaselineSeries([at(elevenPm, 4)], 0.5)).toEqual([
      { validTime: '2026-07-30T23:30:00Z', acPowerKw: 4 },
    ]);
  });

  it('throws on an offset that is not a whole number of seconds rather than truncating it', () => {
    // 0.0001 h is 360 ms. Truncating that to the second would hand back a point
    // labelled with an instant it is not from — a silent one-off in every metric
    // computed against it — so the instant has to be unrepresentable, not rounded.
    expect(() => persistenceBaselineSeries([at(elevenPm, 4)], 0.0001)).toThrow();
  });
});

describe('errorMetricsSchema', () => {
  it('accepts a complete metrics row and composes into its own metrics sort key', () => {
    const metrics: ErrorMetrics = errorMetricsSchema.parse(validMetrics);

    expect(metrics.baseline).toBe(PERSISTENCE_24H);
    expect(metricsSortKey(metrics.period, metrics.model, metrics.baseline)).toBe(
      `${noon}#${twoPm}#physics#persistence-24h`,
    );
  });

  it('accepts a null skill score, which is how an undefined comparison is recorded', () => {
    expect(errorMetricsSchema.parse({ ...validMetrics, skillScore: null }).skillScore).toBeNull();
  });

  it('rejects a period whose start is not strictly before its end', () => {
    const notBefore = { startInclusive: twoPm, endExclusive: noon };
    const identical = { startInclusive: noon, endExclusive: noon };

    expect(errorMetricsSchema.safeParse({ ...validMetrics, period: notBefore }).success).toBe(
      false,
    );
    expect(errorMetricsSchema.safeParse({ ...validMetrics, period: identical }).success).toBe(
      false,
    );
  });

  it('rejects a negative mean absolute error', () => {
    expect(errorMetricsSchema.safeParse({ ...validMetrics, maeKw: -0.1 }).success).toBe(false);
  });

  it('rejects a skill score above 1, which no forecast can beat', () => {
    expect(errorMetricsSchema.safeParse({ ...validMetrics, skillScore: 1.01 }).success).toBe(false);
    expect(errorMetricsSchema.safeParse({ ...validMetrics, skillScore: 1 }).success).toBe(true);
  });

  it('rejects a sample count of zero, because a metric over no samples does not exist', () => {
    expect(errorMetricsSchema.safeParse({ ...validMetrics, sampleCount: 0 }).success).toBe(false);
    expect(errorMetricsSchema.safeParse({ ...validMetrics, sampleCount: 2.5 }).success).toBe(false);
  });

  it('rejects a baseline it does not name', () => {
    expect(baselineSchema.safeParse('persistence-24h').success).toBe(true);
    expect(errorMetricsSchema.safeParse({ ...validMetrics, baseline: 'clear-sky' }).success).toBe(
      false,
    );
  });
});

describe('@cumulo/shared surface', () => {
  it('exports every metrics function and schema from the package root', () => {
    expect(packageSurface.alignByValidTime).toBe(alignByValidTime);
    expect(packageSurface.meanAbsoluteErrorKw).toBe(meanAbsoluteErrorKw);
    expect(packageSurface.rootMeanSquareErrorKw).toBe(rootMeanSquareErrorKw);
    expect(packageSurface.skillScore).toBe(skillScore);
    expect(packageSurface.persistenceBaselineSeries).toBe(persistenceBaselineSeries);
    expect(packageSurface.baselineSchema).toBe(baselineSchema);
    expect(packageSurface.errorMetricsSchema).toBe(errorMetricsSchema);
    expect(packageSurface.PERSISTENCE_24H).toBe(PERSISTENCE_24H);
  });
});
