import type { ReactElement } from 'react';
import { CHART_CLOCK_LABEL } from './chart-copy';
import {
  axisTicks,
  horizonLabelAnchor,
  tickLabelFor,
  xForIndex,
  xTickIndices,
  yForKw,
} from './chart-geometry';
import { axisTickText, type ChartScale, type ForecastChartPoint } from './chart-series';

/**
 * The plot's chrome: the kW grid and its labels, the forecast-horizon rule, the
 * time-axis labels, and the two axis titles. Each builder returns an array that
 * `ForecastChart.tsx` spreads straight into the `<svg>`, exactly as
 * `forecast-chart-marks.tsx` does for the data — chrome and marks are the two
 * halves of that plot and now sit in a file each, with the component left
 * holding composition (`structure.md` rule 4).
 *
 * Every number here is geometry in SVG user units, which are rendered pixels
 * (`chart-geometry.ts`'s `chartPlot`): coordinates and gaps, not styling. The
 * ink is `charts.css`'s, through the classes below.
 */

/** SVG user units between a kW tick label and the plot's left edge. */
const Y_LABEL_GAP = 10;
/** SVG user units from the plot's floor down to a time label's baseline. */
const X_LABEL_GAP = 18;
/** The horizon label's baseline, below the plot's ceiling. */
const HORIZON_LABEL_BASELINE = 8;
/** The axis titles' baseline, in the chrome band above the plot. */
const AXIS_TITLE_BASELINE = 10;

/**
 * Advance width of "forecast horizon" at `--text-xs`, rounded up. Estimated
 * rather than measured: `getComputedTextLength` needs a laid-out DOM, which
 * would make a pure render depend on the browser and jsdom report zero. Erring
 * wide only flips the label early, which is harmless; erring narrow is the
 * clipping this constant exists to prevent. Exported so a test can assert the
 * label's whole extent, not just its anchor.
 */
export const HORIZON_LABEL_WIDTH = 84;

export const gridElements = (scale: ChartScale): readonly ReactElement[] =>
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
export const horizonElements = (
  lastMeasuredIndex: number,
  scale: ChartScale,
): readonly ReactElement[] => {
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

export const xLabelElements = (
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
 * What the two axes are counting, one at each end of the chrome band above the
 * plot: kW on the left, and the clock the time axis runs on at the right.
 *
 * `width` rather than the plot's right edge, because these titles belong to the
 * canvas rather than to the plot — the clock reads to the chart's own edge, past
 * the margin the last tick label spends.
 */
export const axisTitleElements = (width: number): readonly ReactElement[] => [
  <text key="kw" className="forecast-chart-axis-title" x={0} y={AXIS_TITLE_BASELINE}>
    kW
  </text>,
  /* The clock the treatment's UTC axis owes its readers, mirroring the kW title
     across the chrome band above the plot. */
  <text
    key="clock"
    className="forecast-chart-axis-title"
    x={width}
    y={AXIS_TITLE_BASELINE}
    textAnchor="end"
  >
    {CHART_CLOCK_LABEL}
  </text>,
];
