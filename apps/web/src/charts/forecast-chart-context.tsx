import type { ReactElement } from 'react';
import { contiguousRuns, xAt, type ChartScale, type ForecastChartPoint } from './chart-series';

/**
 * The plot's context layers: the night wash behind the series, and a hairline at
 * each UTC midnight — builders returning arrays that `ForecastChart.tsx` spreads
 * into the plot (`docs/standards/structure.md` rule 4). Which hours are night
 * arrives on the point as `night` (`apps/web/src/dashboard/fleet-night.ts`); where
 * each edge lands, and why neither rounds to the nearer sample, is
 * `docs/design/chart-treatment.md`'s "Context layers".
 */

/**
 * A run this short has no horizontal extent to wash — the two edges of the rect
 * would coincide and SVG would paint nothing. Skipped rather than drawn as a
 * hairline, which would read as one more vertical line on a canvas that already
 * has three meanings for one.
 *
 * Two ways a run gets this short, and neither wants a mark. A single dark
 * sample flanked by two light ones does not happen on an hourly series on this
 * planet; a dark sample cut off by `contiguousRuns`' time break is the ordinary
 * case at the edge of a hole, and shading one sample's worth of nothing is not
 * what would fix it.
 */
const MINIMUM_SHADED_SAMPLES = 2;

/**
 * Whether a sample sits exactly on a UTC day boundary. An unparseable timestamp
 * yields `NaN` for both fields and so is not a boundary — the same direction
 * `apps/web/src/dashboard/fleet-night.ts` takes with a garbled hour, because
 * drawing nothing is the safe answer for a layer whose whole contract is that
 * absence draws nothing.
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
 */
export const nightElements = (
  points: readonly ForecastChartPoint[],
  scale: ChartScale,
): readonly ReactElement[] =>
  contiguousRuns(points, (index) => points[index]?.night === true)
    .filter((run) => run.indices.length >= MINIMUM_SHADED_SAMPLES)
    .map((run) => {
      // A run's indices are consecutive by construction, so its last index
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
