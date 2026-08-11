import type { ReactElement } from 'react';
import {
  contiguousRuns,
  xAt,
  type ChartRun,
  type ChartScale,
  type ForecastChartPoint,
} from './chart-series';

/**
 * The plot's context layers: the night wash behind the series, and a hairline at
 * each UTC midnight. Both are builders returning arrays that `ForecastChart.tsx`
 * spreads into the plot, exactly as `forecast-chart-axes.tsx` does for the
 * chrome and `-marks.tsx` for the data — a third file for the third kind of
 * thing on this canvas (`structure.md` rule 4).
 *
 * **Context is drawn, not written** (`docs/standards/design.md` rule 10). The
 * diurnal shape of a PV series has a cause, and a shaded background says "the
 * sun is down here" without spending a sentence, a legend row or a series slot
 * on it. Which hours are the fleet's night is not decided here: it arrives on
 * the point as `night`, and `dashboard/fleet-night.ts` owns both the definition
 * and the argument for it.
 *
 * **An absent flag draws nothing, and that is not the same as `false`.**
 * `ForecastChartPoint.night` is optional on purpose — absent means nobody asked
 * the question of this series, `false` means somebody did and the answer was
 * daylight. Both leave the hour unshaded, so the rendering collapses them, but
 * the predicate below is `=== true` rather than a truthiness test precisely so
 * that a future third behaviour has the distinction still available to it.
 *
 * **Accepted imprecision: an edge lands on a sample — and neither layer rounds
 * to the nearer one.** Both place their geometry at sample positions and neither
 * interpolates, but they miss in different ways, and the difference is
 * load-bearing rather than pedantic.
 *
 * The wash covers each run of dark samples from its first to its last, so its
 * edges are always samples *inside* the dark set. A twilight crossing between
 * two samples therefore goes unshaded until the next sample — late by up to a
 * full sampling step, and **always in that one direction**: fewer hours shaded
 * than are dark, never more. That one-signedness is the property
 * `dashboard/fleet-night.ts`'s whole argument rests on, since the wash sits
 * behind a curve that is non-zero wherever any site still has light. Rounding to
 * the nearer sample would be symmetric, and a symmetric rule can shade an hour
 * the classifier called daylight — the contradiction the intersection definition
 * exists to make impossible. It is not an improvement waiting to be made.
 *
 * The midnight hairline misses the other way: `startsUtcDay` below marks a
 * sample that *is* 00:00 UTC and nothing else, so a midnight falling between two
 * samples draws no line at all rather than one at the nearer sample. Nothing is
 * missing today, because everything upstream samples hourly (`modalStepMs`
 * below) and every midnight is therefore a sample; a cadence whose samples
 * stepped over midnight would lose the boundary rather than misplace it, which
 * is the direction the whole file takes — where the data cannot answer, draw
 * nothing.
 *
 * Both misses are inside the tolerance these layers are for: they explain the
 * shape of a curve, and nothing reads a sunset or a date off them. The same
 * follows for placement in general — these marks read the axis's own mapping
 * (`chart-series.ts`'s `xAt`), which since #325 is proportional to time, so a
 * wash and a boundary keep their place over the series on an axis with a missing
 * hour in it. There is no second mapping here to keep in step with that one.
 *
 * **Decoration, as far as assistive technology is concerned.** Every element
 * here is drawn inside the chart's `role="img"` svg, which collapses to its
 * `aria-label`: nothing added here enters the tab order, and the accessible
 * description is unchanged. The layer is deliberately not in the legend either —
 * a legend names series, and shading the reader's night is not one.
 */

/**
 * A run this short has no horizontal extent to wash — the two edges of the rect
 * would coincide and SVG would paint nothing. Skipped rather than drawn as a
 * hairline, which would read as one more vertical line on a canvas that already
 * has three meanings for one.
 *
 * Two ways a run gets this short, and neither wants a mark. A single dark
 * sample flanked by two light ones does not happen on an hourly series on this
 * planet; a dark sample left alone by `withinOneStep` below — its neighbour in
 * the array is not its neighbour in time — is the ordinary case at the edge of a
 * hole, and shading one sample's worth of nothing is not what would fix it.
 */
const MINIMUM_SHADED_SAMPLES = 2;

/**
 * The series' sampling step, as the interval that occurs most often between
 * consecutive samples — `null` for a series with no two samples it can measure
 * one from.
 *
 * **Derived rather than assumed to be an hour.** Everything upstream today
 * samples hourly, but nothing in this module's types pins it: `sampleXs` places
 * samples by elapsed time and would happily draw a half-hourly or daily series,
 * and a constant here would then cut every run of it. The modal interval is what
 * the series itself says its cadence is, which is the same question the code
 * below is really asking — *is this sample the next one, or the one after a
 * hole?*
 *
 * Ties go to the shorter interval, so an ambiguous four-sample series (one step,
 * one double step) reads the double step as the hole it is rather than as the
 * cadence. Insertion order therefore decides nothing.
 *
 * Non-positive and unparseable intervals are not counted: a `NaN` difference
 * fails `> 0`, so a series whose timestamps will not parse yields `null` and —
 * by `withinOneStep`'s answer for it — no wash at all. That is the same
 * direction `startsUtcDay` takes above, and the direction the whole layer takes:
 * where the data cannot answer the question, draw nothing.
 */
const modalStepMs = (points: readonly ForecastChartPoint[]): number | null => {
  const counts = new Map<number, number>();
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    if (from === undefined || to === undefined) {
      continue;
    }
    const stepMs = Date.parse(to.validTimeIso) - Date.parse(from.validTimeIso);
    if (stepMs > 0) {
      counts.set(stepMs, (counts.get(stepMs) ?? 0) + 1);
    }
  }

  let modal: { readonly stepMs: number; readonly count: number } | null = null;
  for (const [stepMs, count] of counts) {
    if (modal === null || count > modal.count || (count === modal.count && stepMs < modal.stepMs)) {
      modal = { stepMs, count };
    }
  }
  return modal?.stepMs ?? null;
};

/**
 * Whether the sample at `index` is the one that follows its array predecessor in
 * *time* as well as in the array — no more than one sampling step later.
 *
 * `<=` rather than `===` so a series sampled slightly unevenly stays one run;
 * what this is looking for is the sample that is two or more steps out, which is
 * a sample with a hole in front of it. A `NaN` difference fails the comparison,
 * as does a `null` step, so an unanswerable question breaks the run.
 */
const withinOneStep = (
  points: readonly ForecastChartPoint[],
  index: number,
  stepMs: number | null,
): boolean => {
  const previous = points[index - 1];
  const current = points[index];
  if (previous === undefined || current === undefined || stepMs === null) {
    return false;
  }
  return Date.parse(current.validTimeIso) - Date.parse(previous.validTimeIso) <= stepMs;
};

/**
 * One array-adjacent run, cut wherever the series skips a sample.
 *
 * `contiguousRuns` breaks on *array* adjacency, which is the right cut for a
 * value that is present and null and the wrong one for an hour that is absent
 * from the series entirely: the survivors either side of the hole stay adjacent
 * in the array, so the run is not broken (recorded in `docs/tech-debt.md`,
 * 2026-08-11, "`contiguousRuns` splits on array adjacency, not on time
 * adjacency"). Every other mark on this canvas still inherits that. This layer
 * does not, because a wash is a *claim about the hours it covers* — one rect
 * spanning the hole would assert darkness at an hour nobody classified, which is
 * the same claim this file's `nightElements` docblock refuses to make half an
 * hour either side of a run's ends.
 *
 * Each segment is still a stretch of consecutive indices, since a cut of a
 * consecutive run is consecutive — which is what keeps the width arithmetic
 * below a subtraction rather than a lookup.
 */
const splitAtTimeGaps = (
  run: ChartRun,
  points: readonly ForecastChartPoint[],
  stepMs: number | null,
): readonly ChartRun[] => {
  const segments: { startIndex: number; indices: number[] }[] = [];
  for (const index of run.indices) {
    const open = segments.at(-1);
    if (open !== undefined && withinOneStep(points, index, stepMs)) {
      open.indices.push(index);
    } else {
      segments.push({ startIndex: index, indices: [index] });
    }
  }
  return segments;
};

/**
 * Whether a sample sits exactly on a UTC day boundary. An unparseable timestamp
 * yields `NaN` for both fields and so is not a boundary — the same direction
 * `fleet-night.ts` takes with a garbled hour, because drawing nothing is the
 * safe answer for a layer whose whole contract is that absence draws nothing.
 */
const startsUtcDay = (validTimeIso: string): boolean => {
  const at = new Date(validTimeIso);
  return at.getUTCHours() === 0 && at.getUTCMinutes() === 0;
};

/**
 * The fleet's night, as one rect per run of dark hours that are consecutive in
 * time, spanning the full height of the plot from the run's first sample to its
 * last.
 *
 * The wash stops at the samples rather than reaching half an hour past them in
 * each direction: the shading is a claim about the hours it covers, and widening
 * it to the midpoints would claim darkness at an hour classified as daylight.
 *
 * **In time, not in the array, and the difference is a whole hour wide.** A
 * series can be missing an hour outright rather than carrying it with null
 * values — `joinFleetSeries` builds its x-domain from the hours either source
 * knows about, so an hour neither forecast nor measured is simply not there.
 * Since #325 that hour still costs its width on the axis, so the two samples
 * either side of it are drawn an hour apart while remaining neighbours in the
 * array. Shading straight across would be the widening this docblock's second
 * paragraph refuses, only larger and about an hour whose classification is not
 * merely daylight but unknown. `splitAtTimeGaps` above is what stops it.
 */
export const nightElements = (
  points: readonly ForecastChartPoint[],
  scale: ChartScale,
): readonly ReactElement[] => {
  const stepMs = modalStepMs(points);
  return contiguousRuns(points.length, (index) => points[index]?.night === true)
    .flatMap((run) => splitAtTimeGaps(run, points, stepMs))
    .filter((run) => run.indices.length >= MINIMUM_SHADED_SAMPLES)
    .map((run) => {
      // A segment's indices are consecutive by construction, so its last index
      // is its first plus its length — no lookup, and no `undefined` to answer
      // for.
      const startX = xAt(scale, run.startIndex);
      return (
        <rect
          key={run.startIndex}
          className="forecast-chart-night"
          x={startX}
          y={scale.plot.top}
          width={xAt(scale, run.startIndex + run.indices.length - 1) - startX}
          height={scale.plot.bottom - scale.plot.top}
        />
      );
    });
};

/**
 * Where the days turn: one full-height hairline at every sample that is exactly
 * UTC midnight.
 *
 * Solid grid ink, which is the third of the three vertical meanings this plot
 * carries and is told from the other two by treatment rather than by position
 * (`charts.css`, and `docs/design/chart-treatment.md`'s "Context layers"): the
 * horizon rule is dashed at the same weight, the crosshair is full ink at twice
 * it. Keyed by the timestamp rather than the index, because the timestamp is
 * what makes this sample the one it is.
 */
export const dayBoundaryElements = (
  points: readonly ForecastChartPoint[],
  scale: ChartScale,
): readonly ReactElement[] =>
  points.flatMap((point, index) => {
    if (!startsUtcDay(point.validTimeIso)) {
      return [];
    }
    const x = xAt(scale, index);
    return [
      <line
        key={point.validTimeIso}
        className="forecast-chart-day-boundary"
        x1={x}
        x2={x}
        y1={scale.plot.top}
        y2={scale.plot.bottom}
      />,
    ];
  });
