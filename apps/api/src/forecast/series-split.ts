import type { Forecast, GenerationReading } from '@cumulo/shared';
import type { SeriesPoint } from '@cumulo/storage';

/**
 * Splitting the interleaved series into the two kinds a response body names.
 *
 * `SeriesAdapter.querySeriesRange` hands back forecasts and actuals interleaved
 * in one chronological list, which is exactly the property ADR 0002's sort key
 * exists to provide — one Query rather than three. The wire contract is two
 * arrays, so the split happens here, once, rather than inside each of the two
 * handlers that need it: change what a `SeriesPoint` is and both are wrong
 * until both change (`docs/standards/structure.md` rule 7).
 *
 * Both passes preserve the query's chronological order, so `forecasts[0]` is
 * still the earliest forecast in the window. Two traversals rather than one
 * accumulating reduce: over an already-materialized array the cost is not worth
 * naming, and a fold whose purpose lives in its accumulator reads far worse
 * than two functions whose names say what comes out.
 *
 * `flatMap` rather than `filter` then `map` because it narrows the union and
 * extracts the payload in the same step, leaving nothing for the type system to
 * carry between two traversals.
 */

export const forecastsIn = (points: readonly SeriesPoint[]): Forecast[] =>
  points.flatMap((point) => (point.type === 'forecast' ? [point.forecast] : []));

export const actualsIn = (points: readonly SeriesPoint[]): GenerationReading[] =>
  points.flatMap((point) => (point.type === 'generation' ? [point.reading] : []));
