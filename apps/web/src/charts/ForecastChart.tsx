import type { ReactElement } from 'react';
import {
  axisTicks,
  niceAxisMax,
  tickLabelFor,
  xForIndex,
  xTickIndices,
  yForKw,
  type PlotRect,
} from './chart-geometry';
import {
  actualAt,
  allIndices,
  axisTickText,
  bandPolygonPoints,
  contiguousRuns,
  formatKw,
  highestValueKw,
  medianAt,
  p10At,
  p90At,
  polylinePoints,
  seriesSpanHours,
  type ChartRun,
  type ChartScale,
  type ForecastChartPoint,
} from './chart-series';

/**
 * The forecast chart, drawn to `docs/design/chart-treatment.md`: a P10–P90 band
 * as a 10% wash with hairline bounds, the median on top, measured actuals in
 * near-ink last, a horizon rule where the measurements stop, an always-present
 * legend, and the table twin the treatment requires of every chart.
 *
 * Presentational only — no fetching, no domain imports. Points arrive as plain
 * ISO strings and kW numbers, which branded `UtcIsoTimestamp` values satisfy.
 *
 * Two rules from the token preview carry over: no literal colours or sizes
 * (every visual value is a class consuming a token, in `charts.css`), and the
 * numbers below are geometry — SVG user units and kW — not styling.
 *
 * **Gaps break lines, they are never bridged.** A missing band or a missing
 * measurement inside the series is a partial result and reads as one: band and
 * actuals are drawn once per contiguous run, so a straight segment is never
 * painted across a gap to imply a value that was never modelled or measured
 * (`error-handling.md` rule 5; `docs/tech-debt.md`, 2026-07-31).
 */

export type { ForecastChartBand, ForecastChartPoint } from './chart-series';

export interface ForecastChartProps {
  /** At least one point, sorted ascending by `validTimeIso`. */
  readonly points: readonly ForecastChartPoint[];
  readonly ariaLabel: string;
  readonly tableCaption: string;
}

/**
 * SVG user units. Geometry is not styling: these are coordinates, not sizes.
 * Exported because anything positioning a mark against this chart — the hover
 * layer, and the tests that check where a rule landed — needs the same rect.
 */
export const CHART_PLOT: PlotRect = { left: 46, right: 452, top: 16, bottom: 164 };
const VIEW_BOX = '0 0 480 194';
const Y_LABEL_GAP = 10;
const X_LABEL_GAP = 18;
const HORIZON_LABEL_GAP = 6;
const HORIZON_LABEL_BASELINE = 8;
const AXIS_TITLE_BASELINE = 10;
/** ≥ 8px across, per the treatment's countable-markers rule. */
const MARKER_RADIUS = 4;

const gridElements = (scale: ChartScale): readonly ReactElement[] =>
  axisTicks(scale.axisMaxKw).map((kilowatts) => {
    const y = yForKw(kilowatts, scale.axisMaxKw, scale.plot);
    return (
      <g key={kilowatts}>
        <line
          className="forecast-chart-grid"
          x1={scale.plot.left}
          x2={scale.plot.right}
          y1={y}
          y2={y}
        />
        <text
          className="forecast-chart-axis-label"
          x={scale.plot.left - Y_LABEL_GAP}
          y={y}
          textAnchor="end"
          dominantBaseline="middle"
        >
          {axisTickText(kilowatts)}
        </text>
      </g>
    );
  });

const bandElements = (
  points: readonly ForecastChartPoint[],
  runs: readonly ChartRun[],
  scale: ChartScale,
): readonly ReactElement[] =>
  runs.map((run) => (
    <polygon
      key={run.startIndex}
      className="forecast-chart-band"
      points={bandPolygonPoints(points, run, scale)}
    />
  ));

const boundElements = (
  points: readonly ForecastChartPoint[],
  runs: readonly ChartRun[],
  scale: ChartScale,
): readonly ReactElement[] =>
  runs.flatMap((run) => [
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

const actualsElements = (
  points: readonly ForecastChartPoint[],
  runs: readonly ChartRun[],
  scale: ChartScale,
): readonly ReactElement[] =>
  runs.map((run) => (
    <polyline
      key={run.startIndex}
      className="forecast-chart-actuals"
      points={polylinePoints(run.indices, (index) => actualAt(points, index), scale)}
    />
  ));

/** Marked once, in chrome — never by dashing the forecast line. */
const horizonElements = (lastMeasuredIndex: number, scale: ChartScale): readonly ReactElement[] => {
  const x = xForIndex(lastMeasuredIndex, scale.pointCount, scale.plot);
  return [
    <line
      key="rule"
      className="forecast-chart-horizon"
      x1={x}
      x2={x}
      y1={scale.plot.top}
      y2={scale.plot.bottom}
    />,
    <text
      key="label"
      className="forecast-chart-axis-label"
      x={x + HORIZON_LABEL_GAP}
      y={scale.plot.top + HORIZON_LABEL_BASELINE}
    >
      forecast horizon
    </text>,
  ];
};

const xLabelElements = (
  points: readonly ForecastChartPoint[],
  scale: ChartScale,
  spanHours: number,
): readonly ReactElement[] =>
  xTickIndices(scale.pointCount).flatMap((index) => {
    const point = points[index];
    return point === undefined
      ? []
      : [
          <text
            key={point.validTimeIso}
            className="forecast-chart-axis-label"
            x={xForIndex(index, scale.pointCount, scale.plot)}
            y={scale.plot.bottom + X_LABEL_GAP}
            textAnchor="middle"
          >
            {tickLabelFor(point.validTimeIso, spanHours)}
          </text>,
        ];
  });

/**
 * Fixed in draw order and always present: three series are on the plot, so
 * identity is never carried by colour alone. The band swatch is the one place
 * the bound stroke does double duty — at swatch size a bare 10% wash is nearly
 * invisible, and the edges are what make it read as a band.
 */
const LEGEND: ReactElement = (
  <ul className="forecast-chart-legend">
    <li>
      <svg className="forecast-chart-legend-key" viewBox="0 0 28 14" aria-hidden="true">
        <rect className="forecast-chart-band" x="0" y="2" width="28" height="10" />
        <line className="forecast-chart-band-bound" x1="0" x2="28" y1="2.5" y2="2.5" />
        <line className="forecast-chart-band-bound" x1="0" x2="28" y1="11.5" y2="11.5" />
      </svg>
      Forecast (P10–P90)
    </li>
    <li>
      <svg className="forecast-chart-legend-key" viewBox="0 0 28 14" aria-hidden="true">
        <line className="forecast-chart-median" x1="0" x2="28" y1="7" y2="7" />
      </svg>
      Forecast (median)
    </li>
    <li>
      <svg className="forecast-chart-legend-key" viewBox="0 0 28 14" aria-hidden="true">
        <line className="forecast-chart-actuals" x1="0" x2="28" y1="7" y2="7" />
      </svg>
      Actuals
    </li>
  </ul>
);

/** The WCAG-clean twin the treatment requires: every plotted value, in text. */
const tableElement = (
  points: readonly ForecastChartPoint[],
  spanHours: number,
  caption: string,
): ReactElement => (
  <table className="forecast-chart-table">
    <caption>{caption}</caption>
    <thead>
      <tr>
        <th scope="col">Time</th>
        <th scope="col">P10</th>
        <th scope="col">Median</th>
        <th scope="col">P90</th>
        <th scope="col">Actual</th>
      </tr>
    </thead>
    <tbody>
      {points.map((point) => (
        <tr key={point.validTimeIso}>
          <th scope="row">
            <time dateTime={point.validTimeIso}>{tickLabelFor(point.validTimeIso, spanHours)}</time>
          </th>
          <td>{formatKw(point.band?.p10Kw)}</td>
          <td>{formatKw(point.medianKw)}</td>
          <td>{formatKw(point.band?.p90Kw)}</td>
          <td>{formatKw(point.actualKw)}</td>
        </tr>
      ))}
    </tbody>
  </table>
);

export const ForecastChart = (props: ForecastChartProps): ReactElement => {
  const { points } = props;
  const scale: ChartScale = {
    plot: CHART_PLOT,
    axisMaxKw: niceAxisMax(highestValueKw(points)),
    pointCount: points.length,
  };
  const spanHours = seriesSpanHours(points);
  const bandRuns = contiguousRuns(points.length, (index) => points[index]?.band !== undefined);
  const actualRuns = contiguousRuns(points.length, (index) => points[index]?.actualKw != null);
  const lastMeasuredIndex = actualRuns.at(-1)?.indices.at(-1);

  return (
    <figure className="forecast-chart-figure">
      {/* Draw order is back to front: grid → band → bounds → horizon → median →
          actuals → marker. Actuals are drawn last and win every overlap. */}
      <svg className="forecast-chart" viewBox={VIEW_BOX} role="img" aria-label={props.ariaLabel}>
        {gridElements(scale)}
        {bandElements(points, bandRuns, scale)}
        {boundElements(points, bandRuns, scale)}
        {lastMeasuredIndex === undefined ? null : horizonElements(lastMeasuredIndex, scale)}
        <polyline
          className="forecast-chart-median"
          points={polylinePoints(allIndices(points.length), (i) => medianAt(points, i), scale)}
        />
        {actualsElements(points, actualRuns, scale)}
        {lastMeasuredIndex === undefined ? null : (
          <circle
            className="forecast-chart-actuals-marker"
            cx={xForIndex(lastMeasuredIndex, scale.pointCount, scale.plot)}
            cy={yForKw(actualAt(points, lastMeasuredIndex), scale.axisMaxKw, scale.plot)}
            r={MARKER_RADIUS}
          />
        )}
        {xLabelElements(points, scale, spanHours)}
        <text className="forecast-chart-axis-title" x={0} y={AXIS_TITLE_BASELINE}>
          kW
        </text>
      </svg>

      {LEGEND}
      {tableElement(points, spanHours, props.tableCaption)}
    </figure>
  );
};
