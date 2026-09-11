import type { ReactElement } from 'react';
import { xAxisTiers, type TierLabel } from './chart-axis-ticks';
import { TIME_COLUMN_HEADER, UNIT_LABEL_KW, UNIT_LABEL_PERCENT_OF_CAPACITY } from './chart-copy';
import { axisTicks, yForKw, type PlotRect } from './chart-geometry';
import { axisTickText, xAt, type ChartScale, type ForecastChartPoint } from './chart-series';

/**
 * The plot's chrome: the value grid and its labels, the forecast-horizon rule,
 * the two tiers of the time axis, and the two axis titles — the value axis being
 * in kW or in percent of capacity since #291, which is a fact the title carries
 * and the grid is indifferent to. Chrome and marks are the two halves of that
 * plot and now sit in a file each — `forecast-chart-marks.tsx` is the other —
 * with `ForecastChart.tsx` left holding composition
 * (`docs/standards/structure.md` rule 4).
 *
 * Every number here is geometry in SVG user units, which are rendered pixels
 * (`chart-geometry.ts`'s `chartPlot`): coordinates and gaps, not styling. The
 * ink is `charts.css`'s, through the classes below. *Which* instants the time
 * axis labels is `chart-axis-ticks.ts`'s — this file only puts the answer on a
 * row.
 *
 * **Both titles run parallel to the axis they name** (#284 D10).
 */

/** SVG user units between a kW tick label and the plot's left edge. */
const Y_LABEL_GAP = 10;
/**
 * The canvas x a kW tick label's end may never come inside, whatever gutter its
 * plot was given.
 *
 * Everything to the left of it is spoken for and cannot move: the rotated
 * `Power (kW)` title's box — its far end is already *past* the canvas edge, so
 * it cannot be slid over — and the widest label `axisTicks` can print, which has
 * to sit whole or it is the #19 defect. `chart-geometry.ts`'s `PLOT_LEFT_WIDE`
 * owns that pair's measurement, the clearance they leave each other, and why
 * neither this floor nor the gutter is retuned when the unit toggles (#291).
 *
 * A floor rather than a second gap because the wide gutter already sits exactly
 * on it. So the two say one thing between them — a label sits `Y_LABEL_GAP` from
 * the plot where the gutter can afford it, and the narrow gutter
 * (`chart-geometry.ts`'s `PLOT_LEFT_NARROW`) buys its units back out of that
 * gap, which is the whole of what that gutter spends.
 */
const KW_LABEL_END_FLOOR = 46;
/**
 * Where a kW tick label ends — its `text-anchor="end"` x — in the gutter this
 * plot was given.
 *
 * `Math.max` and not a branch on the width: this file is handed a plot rather
 * than a measurement, and the constraint is a position on the canvas rather
 * than a rule about panels, so it is expressible without knowing which gutter
 * `chartPlot` chose (`docs/standards/architecture.md` rule 9 — the threshold has
 * one owner and it is not here).
 */
const kwLabelX = (plot: PlotRect): number => Math.max(KW_LABEL_END_FLOOR, plot.left - Y_LABEL_GAP);
/**
 * The three baselines under the plot's floor, spending the band
 * `chart-geometry.ts`'s `X_AXIS_BAND` reserves: the hours, the days that
 * qualify them, and the axis title under both.
 *
 * A pitch at `--text-xs`, which is one line of that text plus a hair.
 * `X_AXIS_BAND` carries why the last few units are the axis title's descenders
 * and the margin under them, and `apps/web/e2e/chart-surfaces.spec.ts` is what
 * measures the result on a rendered page, because a font with a longer descender
 * than this one's is how the arithmetic stops being true.
 */
const TIME_TIER_BASELINE = 13;
const DAY_TIER_BASELINE = 27;
const X_TITLE_BASELINE = 41;
/**
 * The rotated y title's baseline, measured from the canvas's left edge.
 *
 * Its glyphs run *across* that line once the rotation is applied — ascenders one
 * way, descenders the other — so the title occupies roughly this ± half a line
 * of text, measured on a rendered page for #430. That band is the whole reason
 * the gutter cannot be thinner than it is, and it is why this constant cannot
 * simply be moved left to make room — the ascender end is already past the
 * canvas edge, which `apps/web/e2e/chart-surfaces.spec.ts`'s
 * `LABEL_CONTAINMENT_TOLERANCE` absorbs and a smaller `Y_TITLE_X` would not.
 *
 * `KW_LABEL_END_FLOOR` above holds the label off the other end of that band, and
 * `chart-geometry.ts`'s two `PLOT_LEFT_*` constants carry the arithmetic for the
 * gutter all three share.
 */
const Y_TITLE_X = 8;

/**
 * What the y axis counts, in each of the two units the panel can put it in
 * (#291).
 *
 * The axis title, the table twin's caption and the spoken readout's frame have
 * to agree about which unit is showing, so the *words* have one owner
 * (`chart-copy.ts`) and this file keeps only the arrangement of them
 * (`docs/standards/architecture.md` rule 9).
 *
 * The two arrangements differ because the two labels do. `kW` is a unit and
 * needs the quantity named around it; `% of capacity` already names both, and
 * `Power (% of capacity)` would say it twice.
 */
const POWER_AXIS_TITLE = `Power (${UNIT_LABEL_KW})`;
const PERCENT_AXIS_TITLE = UNIT_LABEL_PERCENT_OF_CAPACITY;

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
          x={kwLabelX(scale.plot)}
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
 * **The dash carries the meaning alone** (owner's design round, 2026-08-11,
 * [#429](https://github.com/TomBennett-Lloyd/cumulo/issues/429)). The words went
 * and the mark stayed: a dash reads as a threshold, which is what the caption
 * was spelling out (`docs/design/chart-treatment.md`, the horizon bullet), so
 * the caption was the plot telling the reader in words what the ink already
 * said.
 *
 * Still plural and still an array, like every builder in this file: the whole
 * chrome is spread into the plot the same way, and a rule alone today is not a
 * reason for this one to be handled differently at the call site.
 */
export const horizonElements = (
  lastMeasuredIndex: number,
  scale: ChartScale,
): readonly ReactElement[] => {
  const x = xAt(scale, lastMeasuredIndex);
  return [
    <line
      key="rule"
      className="forecast-chart-horizon"
      x1={x}
      x2={x}
      y1={scale.plot.top}
      y2={scale.plot.bottom}
    />,
  ];
};

/**
 * One tier on one row. Keyed by class and x together: a tier can legitimately
 * repeat a text (a week of hours prints `00` seven times), the two tiers are
 * spread into one child list so their keys share a namespace, and an x is unique
 * within a tier by construction — the invariant `chart-axis-ticks.ts` enforces
 * puts a whole label's width between any two of them.
 */
const tierElements = (
  labels: readonly TierLabel[],
  className: string,
  y: number,
): readonly ReactElement[] =>
  labels.map((label) => (
    <text
      key={`${className}-${String(label.x)}`}
      className={className}
      x={label.x}
      y={y}
      textAnchor="middle"
    >
      {label.text}
    </text>
  ));

/**
 * The time axis: the hours, and the days that qualify them on the row below.
 *
 * No `spanHours` any more, and its absence is the point of the two tiers. The
 * single-tier axis had to be told the span so it could decide whether a bare
 * `14:00` still identified a point; a day printed once under a run of hours
 * answers that question by position instead, at every span, and in a third of
 * the width — which is what lets the labels thin to what the plot affords rather
 * than overlapping at a narrow one.
 */
export const xAxisElements = (
  points: readonly ForecastChartPoint[],
  scale: ChartScale,
): readonly ReactElement[] => {
  const tiers = xAxisTiers(points, scale);
  return [
    ...tierElements(
      tiers.times,
      'forecast-chart-axis-label forecast-chart-axis-time',
      scale.plot.bottom + TIME_TIER_BASELINE,
    ),
    ...tierElements(
      tiers.days,
      'forecast-chart-axis-label forecast-chart-axis-day',
      scale.plot.bottom + DAY_TIER_BASELINE,
    ),
  ];
};

/**
 * What the two axes are counting, each written along the axis it names.
 *
 * The kW title is rotated a quarter turn anticlockwise so it reads up the left
 * gutter, through a `transform` **attribute** and not a `style` prop — SVG
 * geometry is what this is, and inline style is a lint error in UI code
 * (`docs/standards/react.md` rule 5).
 *
 * The time title is `TIME_COLUMN_HEADER` and not a second spelling of it: the
 * axis and the table twin's time column carry the same clock, so they carry the
 * same words from one owner (`docs/standards/architecture.md` rule 9). This is
 * also where the treatment's "every chart states its clock" obligation is
 * discharged, under the axis it qualifies.
 *
 * `percent` is an explicit parameter rather than something read off the plot:
 * the geometry is identical in both units, so there is nothing in a `PlotRect`
 * that could answer the question, and a caller that forgot to pass it would draw
 * a percent chart labelled in kW. The rotation is what makes the longer string
 * free — the title runs *along* the axis, so `% of capacity` spends the plot's
 * height rather than the gutter's width, and the gutter is unchanged by the
 * unit (`chart-geometry.ts`'s `PLOT_LEFT_WIDE`).
 */
export const axisTitleElements = (plot: PlotRect, percent: boolean): readonly ReactElement[] => {
  const middleY = (plot.top + plot.bottom) / 2;
  return [
    <text
      key="power"
      className="forecast-chart-axis-title"
      x={Y_TITLE_X}
      y={middleY}
      textAnchor="middle"
      dominantBaseline="middle"
      transform={`rotate(-90 ${String(Y_TITLE_X)} ${String(middleY)})`}
    >
      {percent ? PERCENT_AXIS_TITLE : POWER_AXIS_TITLE}
    </text>,
    <text
      key="time"
      className="forecast-chart-axis-title"
      x={(plot.left + plot.right) / 2}
      y={plot.bottom + X_TITLE_BASELINE}
      textAnchor="middle"
    >
      {TIME_COLUMN_HEADER}
    </text>,
  ];
};
