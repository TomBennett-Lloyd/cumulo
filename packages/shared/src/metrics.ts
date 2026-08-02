import { z } from 'zod';

import { forecastModelSchema } from './forecast';
import { utcIsoTimestampSchema, type UtcIsoTimestamp } from './timestamp';

/**
 * Forecast error metrics — the numbers that answer "is the forecast any good?".
 *
 * Pure by construction (`architecture.md` rule 3): no I/O, no clock, no ambient state. Every value
 * here is a function of its arguments alone, which is what makes the accuracy story cheap to test
 * and safe to run inside a Lambda, a script or a browser.
 *
 * Two deliberate `throw`s, both violated invariants rather than domain outcomes
 * (`error-handling.md` rule 1): a duplicate `validTime` within one series, and a metric asked for
 * over an empty set. Neither is a value a caller could act on — both mean the caller assembled the
 * wrong inputs. The one genuinely undefined *result*, a skill score against a baseline that made no
 * error, is a value (`null`), because "the baseline was perfect" is a real state of the world.
 *
 * MAE and RMSE are in kW because both compared series carry `acPowerKw`; the unit suffix on every
 * field name is the convention from #10.
 */

/**
 * Which reference series a skill score is measured against.
 *
 * An enum rather than a free string for two reasons: new baselines (clear-sky, climatology) are
 * additions here rather than a format renegotiation, and enum membership guarantees no `#` can
 * enter the value — the metrics sort key is `#`-delimited and a baseline containing one would
 * silently reshape the key.
 */
export const baselineSchema = z.enum(['persistence-24h']);

export type Baseline = z.infer<typeof baselineSchema>;

/** The baseline #16 ships: today's observation at hour *t* predicts hour *t* + 24 h. */
export const PERSISTENCE_24H = 'persistence-24h' satisfies Baseline;

const PERSISTENCE_24H_OFFSET_HOURS = 24;

/**
 * The half-open evaluation window, refined here rather than on `errorMetricsSchema` itself so the
 * top level stays a plain `ZodObject` and keeps `.extend()` / `.pick()` — the same precedent
 * `uncertaintyBandSchema` sets in `forecast.ts`.
 *
 * The shape deliberately matches `metricsSortKey`'s `UtcWindow` parameter, so a parsed metrics
 * row composes into its own storage key: `metricsSortKey(m.period, m.model, m.baseline)`.
 */
const metricsPeriodSchema = z
  .object({
    startInclusive: utcIsoTimestampSchema,
    endExclusive: utcIsoTimestampSchema,
  })
  .refine((period) => period.startInclusive < period.endExclusive, {
    message: 'startInclusive must be strictly before endExclusive',
    path: ['startInclusive'],
  });

/**
 * One evaluation result: how one model scored over one period against one baseline.
 *
 * Per ADR 0002's "one schema per concept", no field here is a storage key — the key is derived from
 * `siteId`, `period`, `model` and `baseline` by `storage-key.ts`, never stored alongside them.
 *
 * `skillScore` is nullable because the score is genuinely undefined in two cases the caller cannot
 * distinguish from a bad forecast: the baseline made zero error (division by zero), or no
 * forecast/observation pairs aligned with the baseline at all. `null` says "no comparison
 * available"; it never means zero skill, which is a real and different result.
 *
 * The upper bound of 1 on `skillScore` is exact — a perfect forecast scores 1 — while the score is
 * unbounded below: a model twice as wrong as the baseline scores −1.
 */
export const errorMetricsSchema = z.object({
  siteId: z.uuid(),
  model: forecastModelSchema,
  period: metricsPeriodSchema,
  baseline: baselineSchema,
  maeKw: z.number().gte(0),
  rmseKw: z.number().gte(0),
  skillScore: z.number().lte(1).nullable(),
  sampleCount: z.number().int().positive(),
  computedAt: utcIsoTimestampSchema,
});

export type ErrorMetrics = z.infer<typeof errorMetricsSchema>;

/**
 * A point of AC power at an instant — the one shape both compared series share.
 *
 * Named and exported rather than inlined per signature so forecasts, generation readings and
 * synthesised baselines all conform to one contract (`typing.md` rule 6).
 */
export interface TimedPowerPoint {
  readonly validTime: UtcIsoTimestamp;
  readonly acPowerKw: number;
}

/** A forecast and an observation known to describe the same instant. */
export interface AlignedPair {
  readonly validTime: UtcIsoTimestamp;
  readonly forecastKw: number;
  readonly observedKw: number;
}

const indexByValidTime = (
  points: readonly TimedPowerPoint[],
  seriesName: string,
): Map<UtcIsoTimestamp, number> => {
  const byValidTime = new Map<UtcIsoTimestamp, number>();

  for (const point of points) {
    if (byValidTime.has(point.validTime)) {
      throw new Error(
        `Duplicate validTime in ${seriesName} series: ${JSON.stringify(point.validTime)}`,
      );
    }
    byValidTime.set(point.validTime, point.acPowerKw);
  }

  return byValidTime;
};

/**
 * Inner-join two series on `validTime`, ascending.
 *
 * This is the one place misalignment is handled, and it is handled by exclusion: an instant present
 * in only one series contributes no pair. Every metric below therefore receives pairs that are
 * matched by construction and can never see two series of unequal length.
 *
 * Throws if either series repeats a `validTime`. Two power values for one instant is a violated
 * invariant of the caller's query, and silently picking one would change the metric it is about to
 * report.
 */
export const alignByValidTime = (
  forecast: readonly TimedPowerPoint[],
  observed: readonly TimedPowerPoint[],
): AlignedPair[] => {
  const forecastByValidTime = indexByValidTime(forecast, 'forecast');
  const observedByValidTime = indexByValidTime(observed, 'observed');

  const pairs = [...forecastByValidTime].flatMap(([validTime, forecastKw]) => {
    const observedKw = observedByValidTime.get(validTime);
    return observedKw === undefined ? [] : [{ validTime, forecastKw, observedKw }];
  });

  // Map keys are unique, so no two pairs share a `validTime` and a two-way comparator is total
  // here; `UtcIsoTimestamp` is fixed-width UTC, so lexicographic order is chronological order
  // (see `timestamp.ts`).
  return pairs.sort((left, right) => (left.validTime < right.validTime ? -1 : 1));
};

const requirePairs = (pairs: readonly AlignedPair[], metricName: string): void => {
  if (pairs.length === 0) {
    throw new Error(`Cannot compute ${metricName} over an empty set of aligned pairs`);
  }
};

/**
 * Mean absolute error in kW — the average miss, in the unit the product talks in.
 *
 * Throws on no pairs: the mean of an empty set is undefined, so asking for it is a caller bug, not
 * a zero.
 */
export const meanAbsoluteErrorKw = (pairs: readonly AlignedPair[]): number => {
  requirePairs(pairs, 'mean absolute error');

  let totalAbsoluteErrorKw = 0;
  for (const pair of pairs) {
    totalAbsoluteErrorKw += Math.abs(pair.forecastKw - pair.observedKw);
  }

  return totalAbsoluteErrorKw / pairs.length;
};

/**
 * Root mean square error in kW — the same miss, weighted so that a few large errors dominate.
 *
 * Reported alongside MAE rather than instead of it: RMSE ≥ MAE always, and the gap between them is
 * itself the signal that the errors are bursty (a blown cloud forecast) rather than uniform.
 *
 * Throws on no pairs, for the same reason `meanAbsoluteErrorKw` does.
 */
export const rootMeanSquareErrorKw = (pairs: readonly AlignedPair[]): number => {
  requirePairs(pairs, 'root mean square error');

  let totalSquaredErrorKw2 = 0;
  for (const pair of pairs) {
    const errorKw = pair.forecastKw - pair.observedKw;
    totalSquaredErrorKw2 += errorKw * errorKw;
  }

  return Math.sqrt(totalSquaredErrorKw2 / pairs.length);
};

/** The two RMSEs a skill score compares. Both must come from the same aligned period. */
export interface SkillScoreInput {
  readonly modelRmseKw: number;
  readonly baselineRmseKw: number;
}

/**
 * Skill score: `1 − modelRmse / baselineRmse`.
 *
 * 1 is a perfect forecast, 0 is exactly as good as the baseline, negative is worse than the
 * baseline. `null` iff `baselineRmseKw` is 0 — a baseline that made no error leaves the ratio
 * undefined, and there is no defensible value to invent for it.
 */
export const skillScore = (input: SkillScoreInput): number | null =>
  input.baselineRmseKw === 0 ? null : 1 - input.modelRmseKw / input.baselineRmseKw;

const MILLISECONDS_PER_HOUR = 60 * 60 * 1000;

/**
 * Exactly `.000`, never `\.\d{3}`.
 *
 * `toISOString()` always emits milliseconds, which `utcIsoTimestampSchema` rejects on purpose
 * (variable width breaks the chronological string ordering ADR 0002's range queries rely on), so a
 * whole-second instant has to have its `.000` removed before the parse. The narrowness is the point:
 * a pattern matching *any* three digits would strip `.360` just as happily, which silently rounds a
 * sub-second offset down to the second instead of rejecting it — and a baseline point quietly moved
 * off the instant it claims is precisely the corruption these metrics exist to measure. Matching
 * only the zero case leaves every other millisecond value in the string, where the parse below
 * refuses it.
 */
const ZERO_MILLISECONDS = /\.000Z$/;

/**
 * `Date` arithmetic, re-serialised to the fixed-width form the domain uses.
 *
 * Throws, via the parse, on any offset that is not a whole number of seconds — see
 * {@link ZERO_MILLISECONDS} for why that is a refusal rather than a rounding.
 */
const shiftHours = (validTime: UtcIsoTimestamp, offsetHours: number): UtcIsoTimestamp => {
  const shifted = new Date(new Date(validTime).getTime() + offsetHours * MILLISECONDS_PER_HOUR);

  return utcIsoTimestampSchema.parse(shifted.toISOString().replace(ZERO_MILLISECONDS, 'Z'));
};

/**
 * The persistence baseline: what you would have predicted by assuming today repeats. The point at
 * `t + offsetHours` carries the observation made at `t`.
 *
 * 24 hours is the default because it is the only offset that preserves the diurnal cycle — a
 * shorter shift would compare noon against morning and beat itself on solar geometry alone, which
 * would flatter any model measured against it.
 *
 * Input order is preserved (the shift is monotonic, so a sorted input stays sorted), and the caller
 * aligns the result against observations to score it. An offset that is not a whole number of
 * seconds throws, because the shifted instant would not be representable as a `UtcIsoTimestamp`.
 */
export const persistenceBaselineSeries = (
  observed: readonly TimedPowerPoint[],
  offsetHours: number = PERSISTENCE_24H_OFFSET_HOURS,
): TimedPowerPoint[] =>
  observed.map((point) => ({
    validTime: shiftHours(point.validTime, offsetHours),
    acPowerKw: point.acPowerKw,
  }));
