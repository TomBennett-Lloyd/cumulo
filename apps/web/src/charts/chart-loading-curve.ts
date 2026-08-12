import type { PlotRect } from './chart-geometry';
import { curvedLinePath, type ChartScale } from './chart-series';

/**
 * The one path the chart draws while it is waiting for numbers — a stylised
 * solar day, and deliberately not a forecast.
 *
 * The owner's 2026-08-12 round asked for the wait to be *shown* rather than
 * spelled: *"graph loading state needs to be visual not words"*, and of four
 * mockups they chose the self-tracing curve — *"it's nice and subtle and
 * clean"*. `docs/design/chart-treatment.md`'s Loading section is where that
 * decision is recorded; this module is the geometry half of it and `charts.css`
 * is the motion half.
 *
 * **Fixed, and that is the point rather than a shortcut.** Nothing here reads a
 * series, because there is no series yet: what is on screen is a placeholder for
 * a shape, and a placeholder drawn from whatever partial data happened to have
 * arrived would be a claim about the fleet made before the fleet answered. So
 * the curve is a plausible day and says nothing — `aria-hidden` where it is
 * rendered (`ForecastChart.tsx`), so it is not offered to a reader who cannot
 * see it either.
 *
 * **Built through `curvedLinePath` rather than by writing a `d` here**, so the
 * trace is the same monotone curve family every real series on this plot is
 * drawn with (`chart-series.ts`; `forecast-chart-marks.tsx`'s "one monotone
 * curve, never a chain of segments"). A hand-written cubic would be a second
 * curve vocabulary on one canvas, told apart by nothing a reader could name.
 *
 * Pure geometry, no React and no DOM: the same division `chart-geometry.ts`
 * keeps, and what lets the shape be asserted without rendering a chart.
 */

/**
 * How many points the bell is sampled at before the curve is fitted through
 * them.
 *
 * High enough that the fitted curve is the bell rather than the polygon: the
 * monotone fit is exact at every sample and interpolates between them, so the
 * sampling density is what decides whether the shoulders read as a curve. Low
 * enough that the emitted `d` stays a short attribute — this path is rebuilt on
 * every render of a loading chart, at whatever width the column currently is.
 */
const TRACE_SAMPLES = 25;

/**
 * The trace's peak, as a fraction of the plot's height.
 *
 * Short of the top on purpose. The trace is a placeholder standing where data
 * will be, and a placeholder that touched the axis maximum would be the loudest
 * thing the plot ever draws — the opposite of the "subtle and clean" the shape
 * was chosen for. It also leaves the head of the curve clear of the top
 * gridline, so the two do not sit on each other while the trace sweeps past.
 */
const TRACE_PEAK_FRACTION = 0.75;

/**
 * A stylised solar day at `dayFraction` through the drawn span, as a fraction of
 * the plot's height.
 *
 * A raised cosine *squared*, which is the whole of the shape: the raised cosine
 * alone is zero at both ends and peaks at the middle, and squaring it flattens
 * the shoulders into something that reads as night while leaving the peak round
 * rather than pointed. That is the silhouette a residential PV day actually
 * has — flat, a rise, a broad top, a fall, flat — and it costs one operator
 * rather than a piecewise definition with two joins in it to get wrong.
 *
 * Zero at both ends by construction, so the trace starts and finishes on the
 * plot's baseline without either end being special-cased. `chart-loading-curve.test.ts`
 * asserts that rather than reading it off this paragraph.
 */
const solarDayHeight = (dayFraction: number): number =>
  TRACE_PEAK_FRACTION * ((1 - Math.cos(2 * Math.PI * dayFraction)) / 2) ** 2;

/**
 * The `d` for the loading trace, in the plot it will be drawn in.
 *
 * The plot is a parameter rather than a module constant because there is no one
 * plot — `chartPlot` answers a different rect at every measured width, and the
 * left gutter is width-dependent besides (`chart-geometry.ts`). A trace built
 * against a stale rect would start and end somewhere other than the baseline it
 * is supposed to sit on.
 *
 * The samples are spread evenly across the plot rather than through
 * `sampleXs`, which maps *instants*: this curve has no time base to be
 * proportional to, and inventing one would be inventing a window the chart has
 * not been told yet.
 */
export const loadingCurvePath = (plot: PlotRect): string => {
  const indices = Array.from({ length: TRACE_SAMPLES }, (_sample, index) => index);
  const lastIndex = TRACE_SAMPLES - 1;
  const scale: ChartScale = {
    plot,
    // The bell is already expressed as a fraction of the plot's height, so the
    // axis it is mapped against is the unit one and `yForKw` becomes exactly
    // that fraction. No kW is claimed anywhere on this path.
    axisMaxKw: 1,
    xs: indices.map((index) => plot.left + ((plot.right - plot.left) * index) / lastIndex),
  };

  return curvedLinePath(indices, (index) => solarDayHeight(index / lastIndex), scale);
};
