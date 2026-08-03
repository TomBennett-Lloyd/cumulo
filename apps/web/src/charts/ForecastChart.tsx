import {
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react';
import { CHART_CLOCK_LABEL } from './chart-copy';
import {
  axisTicks,
  horizonLabelAnchor,
  niceAxisMax,
  tickLabelFor,
  xForIndex,
  xTickIndices,
  yForKw,
  type PlotRect,
} from './chart-geometry';
import {
  axisTickText,
  contiguousRuns,
  highestValueKw,
  seriesSpanHours,
  type ChartScale,
  type ForecastChartPoint,
} from './chart-series';
import {
  ForecastChartHoverLayer,
  hoverKeyAction,
  pointerIndex,
  readoutText,
} from './forecast-chart-hover';
import { FORECAST_CHART_LEGEND } from './forecast-chart-legend';
import {
  actualsElements,
  bandElements,
  boundElements,
  medianElements,
} from './forecast-chart-marks';
import { forecastChartTable } from './forecast-chart-table';

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
 * (`error-handling.md` rule 5; `docs/tech-debt.md`, 2026-07-31). A run left
 * with a single sample has no path to stroke and becomes a marker instead of
 * disappearing — `forecast-chart-marks.tsx` holds that rule and its reasoning.
 *
 * **The readout has one source of truth.** Pointer and keyboard both do exactly
 * one thing — set `activeIndex` — and `forecast-chart-hover.tsx` draws whatever
 * that index says. There is no separate keyboard rendering path to drift from
 * the hover one, which is what the treatment's "keyboard focus shows exactly
 * what hover shows" costs when it is designed in rather than retrofitted.
 *
 * This file is composition plus the plot's chrome — grid, horizon, axes. The
 * data marks, the hover layer and the figure's furniture sit beside it —
 * `forecast-chart-marks.tsx`, `-hover.tsx`, `-legend.tsx`, `-table.tsx` — each
 * a piece of the treatment named after the piece it draws, and each well inside
 * `structure.md` rule 4's ceiling.
 */

export type { ForecastChartBand, ForecastChartPoint } from './chart-series';

export interface ForecastChartProps {
  /** May be empty — the chart then draws bare chrome; sorted ascending by `validTimeIso`. */
  readonly points: readonly ForecastChartPoint[];
  readonly ariaLabel: string;
  readonly tableCaption: string;
}

/**
 * SVG user units. Geometry is not styling: these are coordinates, not sizes.
 * Exported because anything positioning a mark against this chart — the hover
 * layer, and the tests that check where a rule landed — needs the same rect.
 * The view-box width goes with it: mapping a client pixel into this chart's
 * space is a division by the rendered width and a multiplication by this.
 */
export const CHART_PLOT: PlotRect = { left: 46, right: 452, top: 16, bottom: 164 };
export const CHART_VIEW_BOX_WIDTH = 480;
const VIEW_BOX_HEIGHT = 194;
const VIEW_BOX = `0 0 ${String(CHART_VIEW_BOX_WIDTH)} ${String(VIEW_BOX_HEIGHT)}`;
const Y_LABEL_GAP = 10;
const X_LABEL_GAP = 18;
const HORIZON_LABEL_BASELINE = 8;
/**
 * Advance width of "forecast horizon" at `--text-xs`, rounded up. Estimated
 * rather than measured: `getComputedTextLength` needs a laid-out DOM, which
 * would make a pure render depend on the browser and jsdom report zero. Erring
 * wide only flips the label early, which is harmless; erring narrow is the
 * clipping this constant exists to prevent. Exported so a test can assert the
 * label's whole extent, not just its anchor.
 */
export const HORIZON_LABEL_WIDTH = 84;
const AXIS_TITLE_BASELINE = 10;

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

/**
 * Marked once, in chrome — never by dashing the forecast line.
 *
 * The label's side is a decision, not a constant: a horizon late in the window
 * (the 7-day view puts it seven eighths across) would push a right-hand label
 * off the canvas, so `horizonLabelAnchor` flips it to read leftwards instead.
 */
const horizonElements = (lastMeasuredIndex: number, scale: ChartScale): readonly ReactElement[] => {
  const x = xForIndex(lastMeasuredIndex, scale.pointCount, scale.plot);
  const label = horizonLabelAnchor({
    ruleX: x,
    labelWidth: HORIZON_LABEL_WIDTH,
    plot: scale.plot,
  });
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
      x={label.x}
      y={scale.plot.top + HORIZON_LABEL_BASELINE}
      textAnchor={label.textAnchor}
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

export const ForecastChart = (props: ForecastChartProps): ReactElement => {
  const { points } = props;
  const svgRef = useRef<SVGSVGElement>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const scale: ChartScale = {
    plot: CHART_PLOT,
    axisMaxKw: niceAxisMax(highestValueKw(points)),
    pointCount: points.length,
  };
  const spanHours = seriesSpanHours(points);
  const activePoint = activeIndex === null ? undefined : points[activeIndex];
  const bandRuns = contiguousRuns(points.length, (index) => points[index]?.band !== undefined);
  const actualRuns = contiguousRuns(points.length, (index) => points[index]?.actualKw != null);
  const lastMeasuredIndex = actualRuns.at(-1)?.indices.at(-1);

  const clearReadout = (): void => {
    setActiveIndex(null);
  };

  const readAtPointer = (event: ReactPointerEvent<SVGRectElement>): void => {
    setActiveIndex(
      pointerIndex({
        clientX: event.clientX,
        svg: svgRef.current,
        viewBoxWidth: CHART_VIEW_BOX_WIDTH,
        scale,
      }),
    );
  };

  /** Focus opens the readout on the first sample; a live pointer readout stands. */
  const readAtFocus = (): void => {
    setActiveIndex((current) => current ?? 0);
  };

  const readAtKey = (event: ReactKeyboardEvent<SVGSVGElement>): void => {
    const action = hoverKeyAction({ key: event.key, activeIndex, pointCount: points.length });
    if (action.kind === 'ignored') {
      return;
    }
    // Only keys the chart actually acts on lose their default — arrows must not
    // scroll the page out from under a focused chart, and Tab must still tab.
    event.preventDefault();
    setActiveIndex(action.kind === 'cleared' ? null : action.activeIndex);
  };

  return (
    <figure className="forecast-chart-figure">
      {/* Draw order is back to front: grid → band → bounds → horizon → median →
          actuals → marker. Actuals are drawn last of the data and win every
          overlap; the hover chrome and its pointer target sit above all of it. */}
      <svg
        ref={svgRef}
        className="forecast-chart"
        viewBox={VIEW_BOX}
        role="img"
        aria-label={props.ariaLabel}
        tabIndex={0}
        onFocus={readAtFocus}
        onBlur={clearReadout}
        onKeyDown={readAtKey}
      >
        {gridElements(scale)}
        {bandElements(points, bandRuns, scale)}
        {boundElements(points, bandRuns, scale)}
        {lastMeasuredIndex === undefined ? null : horizonElements(lastMeasuredIndex, scale)}
        {medianElements(points, scale)}
        {actualsElements(points, actualRuns, scale, lastMeasuredIndex)}
        {xLabelElements(points, scale, spanHours)}
        <text className="forecast-chart-axis-title" x={0} y={AXIS_TITLE_BASELINE}>
          kW
        </text>
        {/* The clock the treatment's UTC axis owes its readers, mirroring the
            kW title across the chrome band above the plot. */}
        <text
          className="forecast-chart-axis-title"
          x={CHART_VIEW_BOX_WIDTH}
          y={AXIS_TITLE_BASELINE}
          textAnchor="end"
        >
          {CHART_CLOCK_LABEL}
        </text>
        <ForecastChartHoverLayer
          points={points}
          activeIndex={activeIndex}
          scale={scale}
          spanHours={spanHours}
        />
        {/* Last child, and the whole plot: the readout must never depend on the
            pointer hitting a 2px line. `charts.css` gives it the pointer-events
            it needs and no fill. */}
        <rect
          className="forecast-chart-pointer-target"
          x={CHART_PLOT.left}
          y={CHART_PLOT.top}
          width={CHART_PLOT.right - CHART_PLOT.left}
          height={CHART_PLOT.bottom - CHART_PLOT.top}
          onPointerMove={readAtPointer}
          onPointerLeave={clearReadout}
        />
      </svg>

      {/* The readout's only route to a screen reader. The svg above is a
          `role="img"` with one name, so its subtree — tooltip included — is
          collapsed to that label and the selected sample is never spoken from
          inside it. This region is mounted empty with the chart and filled only
          when a reader moves the selection, so every announcement is a real
          change rather than text that was already there (`react.md`). Both
          input routes feed it, because both set the same `activeIndex`. */}
      <p className="forecast-chart-readout" aria-live="polite">
        {activePoint === undefined ? '' : readoutText(activePoint, spanHours)}
      </p>

      {FORECAST_CHART_LEGEND}
      {forecastChartTable({ points, spanHours, caption: props.tableCaption })}
    </figure>
  );
};
