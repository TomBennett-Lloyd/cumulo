import type { ReactElement } from 'react';
import { xForIndex } from './chart-geometry';
import { contiguousRuns, type ChartScale, type ForecastChartPoint } from './chart-series';

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
 * **Accepted imprecision: an edge lands on a sample.** Both layers place their
 * geometry at sample positions, and the series is hourly, so a twilight crossing
 * or a midnight that falls between two samples is drawn at the nearer of them —
 * within half an hour of the truth. That is inside the tolerance the layer is
 * for: it explains the shape of a curve, and nothing reads a sunset or a date
 * off it. The same follows for placement in general — these marks use the axis's
 * own index mapping, so they are index-spaced today and would become
 * time-proportional along with everything else if #325 lands. There is exactly
 * one seam where that mapping happens ({@link xOf}), so the rewire is one line
 * rather than a hunt.
 *
 * **Decoration, as far as assistive technology is concerned.** Every element
 * here is drawn inside the chart's `role="img"` svg, which collapses to its
 * `aria-label`: nothing added here enters the tab order, and the accessible
 * description is unchanged. The layer is deliberately not in the legend either —
 * a legend names series, and shading the reader's night is not one.
 */

/**
 * A run this short has no horizontal extent to wash — the two edges of the rect
 * would coincide and SVG would paint nothing — and it is not a real case either:
 * the series is hourly, so a single dark hour flanked by two light ones does not
 * happen on this planet. Skipped rather than drawn as a hairline, which would
 * read as one more vertical line on a canvas that already has three meanings for
 * one.
 */
const MINIMUM_SHADED_SAMPLES = 2;

/**
 * The one place either layer turns a sample index into a position.
 *
 * Deliberately a named function over a single call: when the x axis becomes
 * time-proportional this is the seam that changes, and a mapping inlined at each
 * of the four use sites below would make that a search instead of an edit.
 */
const xOf = (scale: ChartScale, index: number): number =>
  xForIndex(index, scale.pointCount, scale.plot);

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
 * The fleet's night, as one rect per contiguous run of dark hours, spanning the
 * full height of the plot from the run's first sample to its last.
 *
 * The wash stops at the samples rather than reaching half an hour past them in
 * each direction: the shading is a claim about the hours it covers, and widening
 * it to the midpoints would claim darkness at an hour classified as daylight.
 */
export const nightElements = (
  points: readonly ForecastChartPoint[],
  scale: ChartScale,
): readonly ReactElement[] =>
  contiguousRuns(points.length, (index) => points[index]?.night === true)
    .filter((run) => run.indices.length >= MINIMUM_SHADED_SAMPLES)
    .map((run) => {
      // A run's indices are adjacent by construction, so its last index is its
      // first plus its length — no lookup, and no `undefined` to answer for.
      const startX = xOf(scale, run.startIndex);
      return (
        <rect
          key={run.startIndex}
          className="forecast-chart-night"
          x={startX}
          y={scale.plot.top}
          width={xOf(scale, run.startIndex + run.indices.length - 1) - startX}
          height={scale.plot.bottom - scale.plot.top}
        />
      );
    });

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
    const x = xOf(scale, index);
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
