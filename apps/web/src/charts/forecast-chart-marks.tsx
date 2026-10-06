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
 * The fleet chart's x-domain is the union of forecast hours and actual hours
 * (#264, `dashboard/fleet-series.ts`), and in live mode those two
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
 * hours either side of it are joined by one segment (#325). `docs/tech-debt.md`
 * (2026-08-11, "`contiguousRuns` splits on array adjacency, not on time
 * adjacency") owns it.
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
 * The overlay's dot, in the marker vocabulary the actuals use and the overlay's
 * own ink. One helper for both the lone-run case and the seam, so the end dot
 * cannot drift from the dot that stands in for a line too short to draw.
 */
const overlayMarker = (
  values: readonly (number | null)[],
  index: number,
  scale: ChartScale,
  key: string,
): ReactElement => (
  <circle
    key={key}
    className="forecast-chart-overlay-marker"
    cx={xAt(scale, index)}
    cy={yForKw(overlayAt(values, index), scale.axisMaxKw, scale.plot)}
    r={MARKER_RADIUS}
  />
);

/** Which side of the measurement seam a stretch of the overlay falls on. */
type OverlaySide = 'measured' | 'projected';

/** A stretch of one overlay run, all of it on one side of the seam. */
interface OverlayStretch extends ChartRun {
  readonly side: OverlaySide;
}

const OVERLAY_STRETCH_CLASS: Record<OverlaySide, string> = {
  measured: 'forecast-chart-overlay',
  projected: 'forecast-chart-overlay forecast-chart-overlay-projected',
};

/**
 * A stretch, or nothing at all where it has no path to stroke. Its one sample is
 * then the seam sample, which the stretch beside it already holds and draws — so
 * this is the one degenerate run on the canvas that is dropped rather than given
 * a marker, because a marker here would be a second mark at a drawn coordinate.
 */
const overlayStretch = (
  indices: readonly number[],
  side: OverlaySide,
): readonly OverlayStretch[] => {
  const startIndex = indices[0];
  return startIndex === undefined || indices.length < MINIMUM_PATH_VERTICES
    ? []
    : [{ startIndex, indices, side }];
};

/**
 * One overlay run cut at the seam: the stretch up to it, then the stretch from
 * it onward. **The seam sample belongs to both**, which is the whole of the
 * no-gap claim — the solid path ends at the hour the dashed one starts from, so
 * the two meet at a shared vertex rather than leaving that hour unstroked.
 *
 * No seam at all means nothing was measured, so every hour the overlay covers is
 * ahead of the horizon and the run is projected throughout. A seam at the last
 * sample is the mirror case and needs no branch: the measured stretch is the
 * whole run and the projected one is dropped above.
 */
const overlayStretches = (
  run: ChartRun,
  lastMeasuredIndex: number | undefined,
): readonly OverlayStretch[] =>
  lastMeasuredIndex === undefined
    ? [{ ...run, side: 'projected' }]
    : [
        ...overlayStretch(
          run.indices.filter((index) => index <= lastMeasuredIndex),
          'measured',
        ),
        ...overlayStretch(
          run.indices.filter((index) => index >= lastMeasuredIndex),
          'projected',
        ),
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
 *
 * **It is the one mark here carrying both measurement and projection, so it
 * carries the seam in its own stroke** (#530): measured hours solid and ending in
 * a dot, forecast hours dashed. A lone hour stays the marker it was, because a
 * dot has no pattern to carry. The reasoning is the horizon bullets' in
 * `docs/design/chart-treatment.md`; the dash pattern is `charts.css`'s.
 *
 * `lastMeasuredIndex` is the *overlay's* seam, from `overlayColumn` — never the
 * fleet's. A site with nothing measured over the window draws dashed throughout
 * even where the fleet has measurements, because the fleet's measurements say
 * nothing about this site's.
 */
export const overlayElements = (
  values: readonly (number | null)[],
  scale: ChartScale,
  lastMeasuredIndex: number | undefined,
): readonly ReactElement[] => {
  const runs = contiguousRuns(values.length, (index) => values[index] != null);
  return [
    ...runs
      .filter(spansMultipleSamples)
      .flatMap((run) => overlayStretches(run, lastMeasuredIndex))
      .map((stretch) => (
        <path
          key={`${stretch.side}-${String(stretch.startIndex)}`}
          className={OVERLAY_STRETCH_CLASS[stretch.side]}
          d={curvedLinePath(stretch.indices, (index) => overlayAt(values, index), scale)}
        />
      )),
    // The seam hour already carries its own dot below, so a run that *is* that
    // hour is skipped here rather than drawn twice — `actualsElements`' rule, for
    // the same reason.
    ...runs
      .filter((run) => !spansMultipleSamples(run) && run.startIndex !== lastMeasuredIndex)
      .map((run) => overlayMarker(values, run.startIndex, scale, `lone-${String(run.startIndex)}`)),
    ...(lastMeasuredIndex === undefined
      ? []
      : [overlayMarker(values, lastMeasuredIndex, scale, 'horizon')]),
  ];
};
