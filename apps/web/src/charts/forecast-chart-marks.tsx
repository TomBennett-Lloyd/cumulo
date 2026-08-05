import type { ReactElement } from 'react';
import { xForIndex, yForKw } from './chart-geometry';
import {
  actualAt,
  allIndices,
  bandPolygonPoints,
  contiguousRuns,
  medianAt,
  overlayAt,
  p10At,
  p90At,
  polylinePoints,
  type ChartRun,
  type ChartScale,
  type ForecastChartPoint,
} from './chart-series';

/**
 * The plot's data marks: the band and its bounds, the median, the measured
 * actuals, and an optional overlay series drawn beside them. Each builder
 * returns an array that `ForecastChart.tsx` spreads straight into the `<svg>`,
 * so every element here is a direct child of the plot and draw order is the
 * order the arrays are composed in.
 *
 * **A run of one sample is a mark, not a path.** A `<polyline>` with a single
 * vertex and a band polygon whose two edges coincide are both degenerate — SVG
 * paints neither — so an isolated measured hour or a lone banded hour would
 * simply vanish and the chart would understate how much was measured. Those
 * runs render in the chart's existing marker vocabulary instead: the ringed dot
 * for a measurement, a vertical P90→P10 interval for a band
 * (`docs/design/chart-treatment.md`, "Median forecast and actuals").
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
  const x = xForIndex(run.startIndex, scale.pointCount, scale.plot);
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
      <polygon
        key={run.startIndex}
        className="forecast-chart-band"
        points={bandPolygonPoints(points, run, scale)}
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
      <polyline
        key={`p90-${String(run.startIndex)}`}
        className="forecast-chart-band-bound"
        points={polylinePoints(run.indices, (index) => p90At(points, index), scale)}
      />,
      <polyline
        key={`p10-${String(run.startIndex)}`}
        className="forecast-chart-band-bound"
        points={polylinePoints(run.indices, (index) => p10At(points, index), scale)}
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
    cx={xForIndex(index, scale.pointCount, scale.plot)}
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
      <polyline
        key={run.startIndex}
        className="forecast-chart-actuals"
        points={polylinePoints(run.indices, (index) => actualAt(points, index), scale)}
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
 * The median runs across every sample and so is never broken by a gap — but a
 * single-sample series still has no line to draw, and gets the same ringed dot
 * treatment in the forecast's own hue.
 */
export const medianElements = (
  points: readonly ForecastChartPoint[],
  scale: ChartScale,
): readonly ReactElement[] => {
  if (points.length === 0) {
    return [];
  }
  if (points.length < MINIMUM_PATH_VERTICES) {
    return [
      <circle
        key="median-marker"
        className="forecast-chart-median-marker"
        cx={xForIndex(0, scale.pointCount, scale.plot)}
        cy={yForKw(medianAt(points, 0), scale.axisMaxKw, scale.plot)}
        r={MARKER_RADIUS}
      />,
    ];
  }
  return [
    <polyline
      key="median"
      className="forecast-chart-median"
      points={polylinePoints(allIndices(points.length), (index) => medianAt(points, index), scale)}
    />,
  ];
};

/**
 * A second series on the same axis, resolved onto the forecast's x-domain
 * before it gets here. It is the first series added alongside the forecast, so
 * it takes slot 2 — slot 1 is spoken for everywhere in the product
 * (`docs/design/chart-treatment.md`, "Categorical series order").
 *
 * It obeys the two rules the actuals obey, for the same reasons: a `null` hour
 * breaks the line rather than being bridged, and a run left holding one sample
 * becomes a marker rather than the one-vertex polyline SVG declines to paint.
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
        <polyline
          key={run.startIndex}
          className="forecast-chart-overlay"
          points={polylinePoints(run.indices, (index) => overlayAt(values, index), scale)}
        />
      )),
    ...runs
      .filter((run) => !spansMultipleSamples(run))
      .map((run) => (
        <circle
          key={`lone-${String(run.startIndex)}`}
          className="forecast-chart-overlay-marker"
          cx={xForIndex(run.startIndex, scale.pointCount, scale.plot)}
          cy={yForKw(overlayAt(values, run.startIndex), scale.axisMaxKw, scale.plot)}
          r={MARKER_RADIUS}
        />
      )),
  ];
};
