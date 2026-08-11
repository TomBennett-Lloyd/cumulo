import type { ReactElement } from 'react';
import { yForKw } from './chart-geometry';
import {
  actualAt,
  contiguousRuns,
  curvedBandPath,
  curvedLinePath,
  medianAt,
  overlayAt,
  p10At,
  p90At,
  xAt,
  type ChartRun,
  type ChartScale,
  type ForecastChartPoint,
} from './chart-series';

/**
 * The plot's data marks: the band and its bounds, the median, the measured
 * actuals, and an optional overlay series drawn beside them. Each builder
 * returns an array that `ForecastChart.tsx` spreads straight into the plot —
 * since #331 by handing it down to `forecast-chart-hover-boundary.tsx`, which
 * owns the `<svg>` — so every element here is still a direct child of that
 * element and draw order is still the order the arrays are composed in.
 *
 * **A run of one sample is a mark, not a path.** A `<path>` with a single vertex
 * and a band area whose two edges coincide are both degenerate — SVG paints
 * neither — so an isolated measured hour or a lone banded hour would simply
 * vanish and the chart would understate how much was measured. Those runs render
 * in the chart's existing marker vocabulary instead: the ringed dot for a
 * measurement, a vertical P90→P10 interval for a band
 * (`docs/design/chart-treatment.md`, "Median forecast and actuals").
 *
 * **Every line here is one monotone curve, never a chain of segments.** The
 * `d` strings come from `chart-series.ts`, which carries why monotone is the one
 * interpolation this data can take; what it buys the elements below is that the
 * band's two edges and the two stroked bounds are the same curve over the same
 * points, so a hairline can never drift off the wash it is supposed to edge.
 */

/** Below this a stroked path has no extent, so nothing is painted. */
const MINIMUM_PATH_VERTICES = 2;
/** ≥ 8px across, per the treatment's countable-markers rule. */
const MARKER_RADIUS = 4;

const spansMultipleSamples = (run: ChartRun): boolean =>
  run.indices.length >= MINIMUM_PATH_VERTICES;

/**
 * The band of a lone hour, drawn as its own bounds: a 2px round-capped stroke
 * from P90 down to P10, with the wash omitted. A 10% fill one column wide is
 * invisible, which is the defect this branch exists to fix — and bounds whose
 * values coincide collapse to the cap, which still reads as an hour.
 */
const bandInterval = (
  points: readonly ForecastChartPoint[],
  run: ChartRun,
  scale: ChartScale,
): ReactElement => {
  const x = xAt(scale, run.startIndex);
  return (
    <line
      key={run.startIndex}
      className="forecast-chart-band-interval"
      x1={x}
      x2={x}
      y1={yForKw(p90At(points, run.startIndex), scale.axisMaxKw, scale.plot)}
      y2={yForKw(p10At(points, run.startIndex), scale.axisMaxKw, scale.plot)}
    />
  );
};

export const bandElements = (
  points: readonly ForecastChartPoint[],
  runs: readonly ChartRun[],
  scale: ChartScale,
): readonly ReactElement[] =>
  runs.map((run) =>
    spansMultipleSamples(run) ? (
      <path
        key={run.startIndex}
        className="forecast-chart-band"
        d={curvedBandPath(points, run, scale)}
      />
    ) : (
      bandInterval(points, run, scale)
    ),
  );

/** Only runs with a path to stroke: a lone hour's interval carries its own bounds. */
export const boundElements = (
  points: readonly ForecastChartPoint[],
  runs: readonly ChartRun[],
  scale: ChartScale,
): readonly ReactElement[] =>
  runs
    .filter(spansMultipleSamples)
    .flatMap((run) => [
      <path
        key={`p90-${String(run.startIndex)}`}
        className="forecast-chart-band-bound"
        d={curvedLinePath(run.indices, (index) => p90At(points, index), scale)}
      />,
      <path
        key={`p10-${String(run.startIndex)}`}
        className="forecast-chart-band-bound"
        d={curvedLinePath(run.indices, (index) => p10At(points, index), scale)}
      />,
    ]);

const actualsMarker = (
  points: readonly ForecastChartPoint[],
  index: number,
  scale: ChartScale,
  key: string,
): ReactElement => (
  <circle
    key={key}
    className="forecast-chart-actuals-marker"
    cx={xAt(scale, index)}
    cy={yForKw(actualAt(points, index), scale.axisMaxKw, scale.plot)}
    r={MARKER_RADIUS}
  />
);

/**
 * Lines, then the dots that stand in for lines too short to draw, then the end
 * dot at the horizon — the treatment's back-to-front order within the series.
 *
 * The last measured hour already has its end dot, so an isolated run that _is_
 * that hour is skipped here rather than drawn twice at the same coordinates.
 */
export const actualsElements = (
  points: readonly ForecastChartPoint[],
  runs: readonly ChartRun[],
  scale: ChartScale,
  lastMeasuredIndex: number | undefined,
): readonly ReactElement[] => [
  ...runs
    .filter(spansMultipleSamples)
    .map((run) => (
      <path
        key={run.startIndex}
        className="forecast-chart-actuals"
        d={curvedLinePath(run.indices, (index) => actualAt(points, index), scale)}
      />
    )),
  ...runs
    .filter((run) => !spansMultipleSamples(run) && run.startIndex !== lastMeasuredIndex)
    .map((run) => actualsMarker(points, run.startIndex, scale, `lone-${String(run.startIndex)}`)),
  ...(lastMeasuredIndex === undefined
    ? []
    : [actualsMarker(points, lastMeasuredIndex, scale, 'horizon')]),
];

/**
 * The median, broken at any hour that carries no forecast.
 *
 * It used to run across every sample unbroken, and that was true of every series
 * this chart had ever been given: a point existed because a forecast existed.
 * #264 ended it. The fleet chart's x-domain is now the union of forecast hours
 * and actual hours (`dashboard/fleet-series.ts`), and in live mode those two
 * windows do not overlap at all — the hours behind the horizon were measured and
 * never forecast. So the median obeys the same two rules the actuals and the
 * overlay obey, for the same reasons: an hour carrying `medianKw: null` breaks
 * the line rather than being bridged, because a segment drawn across it is a
 * forecast nobody made, and a run left holding one sample becomes a ringed dot
 * rather than the one-vertex path SVG declines to paint.
 *
 * **An hour missing from the series is the case that rule does not reach.** The
 * union domain has no row at all for an hour that was neither forecast nor
 * measured, so there is no `null` for `contiguousRuns` to break on and the two
 * hours either side of it are joined by one segment — at the hole's full width
 * since #325, which is what makes the bridge visible rather than compressed
 * away. Systemic and not fixed here, because every mark in this file inherits
 * it: `docs/tech-debt.md` (2026-08-11, "`contiguousRuns` splits on array
 * adjacency, not on time adjacency") owns it.
 */
export const medianElements = (
  points: readonly ForecastChartPoint[],
  runs: readonly ChartRun[],
  scale: ChartScale,
): readonly ReactElement[] => [
  ...runs
    .filter(spansMultipleSamples)
    .map((run) => (
      <path
        key={run.startIndex}
        className="forecast-chart-median"
        d={curvedLinePath(run.indices, (index) => medianAt(points, index), scale)}
      />
    )),
  ...runs
    .filter((run) => !spansMultipleSamples(run))
    .map((run) => (
      <circle
        key={`lone-${String(run.startIndex)}`}
        className="forecast-chart-median-marker"
        cx={xAt(scale, run.startIndex)}
        cy={yForKw(medianAt(points, run.startIndex), scale.axisMaxKw, scale.plot)}
        r={MARKER_RADIUS}
      />
    )),
];

/**
 * A second series on the same axis, resolved onto the forecast's x-domain
 * before it gets here. It is the first series added alongside the forecast, so
 * it takes slot 2 — slot 1 is spoken for everywhere in the product
 * (`docs/design/chart-treatment.md`, "Categorical series order").
 *
 * It obeys the two rules the actuals obey, for the same reasons: a `null` hour
 * breaks the line rather than being bridged, and a run left holding one sample
 * becomes a marker rather than the one-vertex path SVG declines to paint.
 * The runs are derived here rather than passed in because nothing outside this
 * builder needs them — the overlay has no horizon and no end dot.
 */
export const overlayElements = (
  values: readonly (number | null)[],
  scale: ChartScale,
): readonly ReactElement[] => {
  const runs = contiguousRuns(values.length, (index) => values[index] != null);
  return [
    ...runs
      .filter(spansMultipleSamples)
      .map((run) => (
        <path
          key={run.startIndex}
          className="forecast-chart-overlay"
          d={curvedLinePath(run.indices, (index) => overlayAt(values, index), scale)}
        />
      )),
    ...runs
      .filter((run) => !spansMultipleSamples(run))
      .map((run) => (
        <circle
          key={`lone-${String(run.startIndex)}`}
          className="forecast-chart-overlay-marker"
          cx={xAt(scale, run.startIndex)}
          cy={yForKw(overlayAt(values, run.startIndex), scale.axisMaxKw, scale.plot)}
          r={MARKER_RADIUS}
        />
      )),
  ];
};
