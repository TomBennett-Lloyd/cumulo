/**
 * Pure chart geometry: value → SVG user unit, axis choice, and the plot rect
 * every mark is placed in. No React, no DOM, so the chart's arithmetic is
 * testable without rendering one.
 *
 * **The `Kw` spellings below are historical**: since #291 the values are in
 * whichever unit the panel is showing, because `dashboard/` normalises a
 * percent before it reaches this module. The one place the unit is a fact here
 * is `percentAxisMax` (#560).
 *
 * Choosing which instants the x axis labels, and proving those labels cannot
 * collide, is `apps/web/src/charts/chart-axis-ticks.ts` (`structure.md`
 * rule 4). What stays here is
 * the vocabulary both share: `utcWeekdayLabel`, and `tickLabelFor`'s
 * day-qualified long form, which the table twin and the hover readout still
 * print even though the axis itself no longer does.
 *
 * **The time axis runs on UTC** — #19 settles it. Labels are therefore always
 * UTC wall time, never the reader's local zone — `getUTC*` accessors below,
 * never `getHours` (`chart-geometry.test.ts`'s "labels the same instant
 * identically under a non-UTC ambient timezone").
 */

/** The plot rectangle in SVG user units. Coordinates, not sizes: not styling. */
export interface PlotRect {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/**
 * The chart's height, in SVG user units — and therefore in rendered pixels,
 * because the chart is drawn 1:1 with the width it is measured at (`chartPlot`
 * below, and `docs/design/chart-treatment.md`). It is a constant while the width
 * is not: a chart owes its reader a stable vertical scale as the window changes,
 * and a height that tracked the width would make every resize a rescaling of the
 * kW axis.
 *
 * Owned here, and consumed by the component's view box and by the e2e case that
 * measures the 1:1 claim on a rendered page. Anything wanting the chart's height
 * imports this rather than restating it (`architecture.md` rule 9).
 *
 * **The value is what fits, measured rather than chosen** (#284 D15). The
 * clearance under the plot was never headroom the plot may grow into: the plot
 * is not the bottom of the section — the raw-data panel below the figure is
 * (`apps/web/src/charts/ForecastChart.tsx`).
 *
 * The evidence for the fit is `apps/web/e2e/chart-surfaces.spec.ts`'s D15 case
 * measuring a rendered page: it imports this constant and asserts the plot's
 * bottom against its own `D15_VIEWPORT`, so no figure written here has to stay
 * true for the gate to hold. Where the *section* ends — the tighter reading,
 * below the plot — is asserted by no case in either lane today
 * (`testing.md` rule 10's closing rule); re-measure before reasoning from it.
 */
export const CHART_VIEW_BOX_HEIGHT = 184;

/**
 * The band under the plot that belongs to the time axis: two tiers of tick
 * labels — the hours, then the days that qualify them — and the axis title
 * beneath both (#284 D9/D10). The three baselines that spend it are
 * `apps/web/src/charts/forecast-chart-axes.tsx`'s and are stated there, not
 * here.
 *
 * It is deeper than three rows of text need, and the surplus is all descender:
 * the axis title is `Time (UTC)`, whose parentheses reach further below the last
 * baseline than any letter does. The plot gives up the height for that margin;
 * `CHART_VIEW_BOX_HEIGHT` does not move, so D15's fold arithmetic is untouched.
 * `chart-geometry.test.ts`'s "gives the time axis a fixed band under the plot,
 * whatever the width" asserts the depth.
 */
const X_AXIS_BAND = 48;
/**
 * Room to the left of the plot for the two things that share that gutter: the
 * `Power (kW)` title running up the canvas edge, and the widest kW tick label
 * with its gap.
 *
 * Measured for the pair rather than for the label alone (#284 D10), and
 * re-measured on a rendered page for #430. The title is rotated `--text-xs`
 * text, so its *height* is its width on screen; and the widest label
 * `axisTicks` can print is `1000`, which is wider than the mean-advance model in
 * `apps/web/src/charts/chart-axis-ticks.ts` predicts. The two together clear
 * each other by a couple of units (`chart-geometry.test.ts`'s "leaves the
 * rotated title and a whole kW label to the left, half a time label to the
 * right").
 *
 * **The gutter is the worst case across both units and does not move with the
 * one on show** (#291). `1000` is the widest label either mode can print, so the
 * percent mode is strictly narrower here and this measurement still binds. A
 * gutter that changed width with the unit would shift the plot under a reader
 * who only pressed a toggle.
 */
const PLOT_LEFT_WIDE = 56;
/**
 * The same gutter on a chart too narrow to spend the wide one on it. The
 * owner's 2026-08-11 round: on a phone the gutter "takes up too much of the
 * screen".
 *
 * It is the floor the measurement above leaves, not a taste. The only thing a
 * thinner gutter can spend is the *gap* between the label and the plot — and
 * that is all it spends:
 * `apps/web/src/charts/forecast-chart-axes.tsx`'s `KW_LABEL_END_FLOOR` holds the
 * label's end where the wide gutter puts it, leaving the title's clearance
 * untouched. Any narrower and the label would have to move left into the title,
 * and there is nothing else left to take.
 * `chart-geometry.test.ts`'s "spends the kW label gap, and only that, on a chart
 * too narrow for the wide gutter" asserts both halves.
 */
const PLOT_LEFT_NARROW = 50;
/**
 * The chart width at or below which the thinner gutter is used.
 *
 * **Measured, and a container width rather than a viewport one** — the chart
 * already asks its own column how wide it is
 * (`apps/web/src/charts/use-chart-width.ts`), so this is `design.md` rule 7's
 * container-inward default implemented in the geometry.
 *
 * It sits in the gap between two clusters of measured widths, with tens of units
 * of room on each side: a phone and the narrow window
 * `apps/web/e2e/chart-surfaces.spec.ts` uses fall below it; a desktop column and
 * `DEFAULT_CHART_WIDTH` fall above. That is more margin than a scrollbar or
 * a platform's own padding can move either way, which is what keeps this from
 * being a cliff a real window can sit on.
 */
const NARROW_GUTTER_MAX_CHART_WIDTH = 520;
/**
 * Room to the right of the plot for half of the last time-axis label, which is
 * centred on `plot.right` rather than tucked inside it.
 *
 * Half a label and not a whole one, which is why this is narrower than the left
 * gutter — the kW labels hang entirely to the left of the plot, the time labels
 * straddle their sample.
 *
 * **Narrowed in #430, where the owner named the leftover as a gap "equivalent to
 * the width of the y axis".** What is here now is what the label actually needs,
 * measured rather than modelled: the widest thing either tier can centre on
 * `plot.right` is a day label of the `Wed NN` family, and half of one is very
 * nearly this whole margin.
 *
 * The slack is thin on purpose, and thin in *modelled* terms only. What an image
 * whose
 * `system-ui` sets wider glyphs costs is the label reaching the canvas edge, and
 * that is what `apps/web/e2e/chart-surfaces.spec.ts`'s containment poll exists to
 * catch: it fails once a label escapes by more than a quarter of its own height,
 * so it tolerates several percent of glyph growth rather than the first
 * hundredth.
 */
const PLOT_RIGHT_MARGIN = 24;
/**
 * Headroom above the plot's ceiling. What it does now is keep the top gridline
 * — and a mark that reaches the axis maximum — off the canvas edge.
 */
const PLOT_TOP = 12;

/**
 * Mantissas a "nice" axis maximum may take, ascending within a decade. 3, 6, 7
 * and 9 are excluded: they produce quarter-steps nobody reads off a gridline.
 */
const AXIS_MANTISSAS: readonly number[] = [1, 2, 4, 5, 8];
const AXIS_TICK_COUNT = 5;
/** An all-zero series still gets an axis rather than a degenerate 0–0 scale. */
const MINIMUM_AXIS_MAX_KW = 1;
/**
 * From a full day of span onwards a wall-clock time can repeat, so a bare
 * `HH:mm` stops identifying a point and the label needs a weekday.
 *
 * A day exactly, not two (`chart-geometry.test.ts`'s "prefixes the weekday from
 * a full day of span, where a time can first repeat"). Below a day no time can
 * appear twice and the prefix would be noise on every tick.
 */
const WEEKDAY_PREFIX_MINIMUM_SPAN_HOURS = 24;
const MS_PER_HOUR = 3_600_000;
const WEEKDAY_LABELS: readonly string[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Largest power of ten that does not exceed `value` (`value >= 1`). */
const decadeAtOrBelow = (value: number): number => {
  let decade = 1;
  while (decade * 10 <= value) {
    decade *= 10;
  }
  return decade;
};

const padded = (value: number): string => value.toString().padStart(2, '0');

/**
 * The plot rect for a chart rendered `width` pixels wide.
 *
 * **One user unit is one rendered pixel** (#284 D15). Drawing at 1:1 makes the
 * margins above real distances rather than ratios — the left gutter is room for a rotated title and
 * a tick label in the units those are set in, not a fraction of the width that
 * means a different distance in every panel.
 *
 * A function rather than a constant for the same reason: there is no one plot any
 * more, only the plot at the width the chart currently has. Callers that need a
 * plot without a measurement — tests, fixtures — ask for the one at
 * `DEFAULT_CHART_WIDTH` (`apps/web/src/charts/use-chart-width.ts`) rather than
 * keeping a rect of their own.
 *
 * **The left margin is width-dependent too since #430, and only that one is.**
 * `PLOT_LEFT_NARROW` and `NARROW_GUTTER_MAX_CHART_WIDTH` carry that argument.
 */
export const chartPlot = (width: number): PlotRect => ({
  left: width <= NARROW_GUTTER_MAX_CHART_WIDTH ? PLOT_LEFT_NARROW : PLOT_LEFT_WIDE,
  right: width - PLOT_RIGHT_MARGIN,
  top: PLOT_TOP,
  bottom: CHART_VIEW_BOX_HEIGHT - X_AXIS_BAND,
});

/**
 * The one thing the x mapping asks of a sample: when it is.
 *
 * A structural minimum rather than `ForecastChartPoint`, and deliberately so —
 * that type lives in `chart-series.ts`, which imports this module, so naming it
 * from here would be a cycle. Every series point satisfies it by shape.
 */
export interface TimedSample {
  /** A UTC ISO-8601 instant — `packages/shared`'s `UtcIsoTimestamp` form. */
  readonly validTimeIso: string;
}

/** The middle of the plot: where a sample with no extent to sit in goes. */
const plotCentreX = (plot: PlotRect): number => (plot.left + plot.right) / 2;

/**
 * Where every sample of a series sits horizontally — **proportional to time,
 * not to position in the array**:
 *
 *     x_i = left + (right − left) · (t_i − t_0) / (t_n − t_0)
 *
 * **An hour with no data still costs its width on the axis** (#325,
 * `chart-geometry.test.ts`'s "a missing hour keeps its width on the axis").
 *
 * **What that does not do is break the line across the hole.** An hour that is
 * *present* in the series carrying null values does break its marks, because the
 * run predicate rejects its index. An hour *absent from the series* does not:
 * `contiguousRuns` (`apps/web/src/charts/chart-series.ts`) cuts runs on adjacency
 * in the array, and the two survivors either side of a missing hour are still
 * array-adjacent, so the curve is drawn straight through. So what #325 removes
 * is the compression artefact, not the bridge — `docs/tech-debt.md`
 * (2026-08-11, "`contiguousRuns` splits on array adjacency, not on time
 * adjacency") owns the fix for the half that is left.
 *
 * **The arithmetic is on epoch milliseconds, and is therefore DST-safe**
 * (`chart-geometry.test.ts`'s "spaces a series evenly across a DST transition,
 * which local time would not").
 *
 * Two degenerate answers, both the plot's middle: a lone sample has no extent to
 * spread across the plot, and neither does a series whose first and last samples
 * are the same instant. A sample whose own timestamp will not parse gets the
 * middle too.
 */
export const sampleXs = (points: readonly TimedSample[], plot: PlotRect): readonly number[] => {
  const first = points[0];
  const last = points.at(-1);
  if (first === undefined || last === undefined) {
    return [];
  }
  const startMs = Date.parse(first.validTimeIso);
  const spanMs = Date.parse(last.validTimeIso) - startMs;
  // Negated rather than `<= 0`, so a NaN span — unparseable ends — lands here
  // instead of dividing every sample into one.
  if (!(spanMs > 0)) {
    return points.map(() => plotCentreX(plot));
  }
  return points.map((point) => {
    const elapsedMs = Date.parse(point.validTimeIso) - startMs;
    return Number.isFinite(elapsedMs)
      ? plot.left + ((plot.right - plot.left) * elapsedMs) / spanMs
      : plotCentreX(plot);
  });
};

/** Vertical position of a kW value. `axisMaxKw` comes from `niceAxisMax`, so > 0. */
export const yForKw = (kilowatts: number, axisMaxKw: number, plot: PlotRect): number =>
  plot.bottom - ((plot.bottom - plot.top) * kilowatts) / axisMaxKw;

/**
 * Smallest mantissa-times-decade at or above the series maximum, floored at 1 kW.
 * A non-finite maximum (an empty reduce, a NaN reading) falls back to the floor
 * rather than looping for a decade that does not exist.
 */
export const niceAxisMax = (maxValueKw: number): number => {
  const target = Number.isFinite(maxValueKw)
    ? Math.max(maxValueKw, MINIMUM_AXIS_MAX_KW)
    : MINIMUM_AXIS_MAX_KW;
  const decade = decadeAtOrBelow(target);
  const mantissa = AXIS_MANTISSAS.find((candidate) => candidate * decade >= target);
  // Nothing in the decade reaches the target — the next decade's 1 does.
  return mantissa === undefined ? decade * 10 : mantissa * decade;
};

/**
 * Capacity, which a percent chart's axis always reaches (#291).
 *
 * It is the number a reader of a percent-of-capacity chart compares against, so
 * it is the axis's floor rather than something the data has to earn. Without it
 * a fleet at half capacity would fill the plot exactly as one at capacity does.
 */
export const PERCENT_AXIS_FLOOR = 100;

/**
 * The axis maximum for a chart drawn in percent of capacity: capacity always
 * visible, and the nice ladder above it.
 *
 * **A floor under the axis, never a clamp on the marks.** A site can exceed its
 * own capacity, and when it does the reader has to see it, so a peak above
 * capacity climbs the `niceAxisMax` ladder rather than being drawn on top of the
 * capacity gridline. `MINIMUM_AXIS_MAX_KW`'s degenerate-scale guard is subsumed
 * rather than repeated.
 */
export const percentAxisMax = (peakPercent: number): number =>
  Math.max(PERCENT_AXIS_FLOOR, niceAxisMax(peakPercent));

/** Evenly spaced tick values from 0 to `axisMaxKw` inclusive. */
export const axisTicks = (axisMaxKw: number): readonly number[] =>
  Array.from(
    { length: AXIS_TICK_COUNT },
    (_unused, step) => (axisMaxKw * step) / (AXIS_TICK_COUNT - 1),
  );

/**
 * Short UTC weekday name for an instant, or `undefined` for a day index the
 * table does not carry — which `getUTCDay` cannot produce, but the compiler
 * cannot know that under `noUncheckedIndexedAccess`, and an assertion here
 * would be a suppression rather than a proof (`typing.md` rule 2). Each caller
 * says what it prints without one instead.
 *
 * Exported because the axis prints weekdays too: the day tier of
 * `apps/web/src/charts/chart-axis-ticks.ts` spells them out of the same table
 * `tickLabelFor` uses, so the product has one set of short weekday names rather
 * than two that agree today (`structure.md` rule 7).
 */
export const utcWeekdayLabel = (instant: Date): string | undefined =>
  WEEKDAY_LABELS[instant.getUTCDay()];

/**
 * UTC wall-clock label for an instant. Series spanning a day or more get a
 * short weekday prefix, because `14:00` alone stops identifying a point as soon
 * as the axis can carry two of them.
 *
 * **This is the long form, and since #284 D9 the x axis is no longer one of its
 * readers**. What still prints the long form is every
 * surface showing one instant alone, with no neighbouring tick to qualify it:
 * the table twin's row headers, the hover tooltip, and the spoken readout.
 */
export const tickLabelFor = (validTimeIso: string, spanHours: number): string => {
  const instant = new Date(validTimeIso);
  const time = `${padded(instant.getUTCHours())}:${padded(instant.getUTCMinutes())}`;
  if (spanHours < WEEKDAY_PREFIX_MINIMUM_SPAN_HOURS) {
    return time;
  }
  const weekday = utcWeekdayLabel(instant);
  return weekday === undefined ? time : `${weekday} ${time}`;
};

/** Hours from one UTC ISO instant to another; drives the label form above. */
export const spanHoursBetween = (startIso: string, endIso: string): number =>
  (Date.parse(endIso) - Date.parse(startIso)) / MS_PER_HOUR;

/**
 * Named rather than positional: a pointer position and a list of sample
 * positions are both "x in plot space", and nothing but the parameter name
 * distinguishes the one being aimed from the ones being aimed at.
 */
export interface SnapToXParams {
  /** Pointer position in SVG user units — the space the plot rect lives in. */
  readonly pointerX: number;
  /** Sample positions, in sample order — `sampleXs` above. */
  readonly xs: readonly number[];
}

/**
 * The index of the sample nearest `pointerX`, by absolute distance.
 *
 * Distance and not arithmetic on the plot rect, which is what makes this work on
 * an axis whose samples are unevenly spread (#325, `chart-geometry.test.ts`'s
 * "snaps to the nearer sample across an uneven gap"). A pointer beyond either end
 * reads that end sample — readers aim
 * at a time, not at a hairline.
 *
 * **A pointer exactly halfway between two samples snaps to the later one**, and
 * the direction is specified rather than incidental: a pixel that reported two
 * different hours on two passes would make the crosshair look broken. A `NaN`
 * distance never wins either comparison, so an unplaceable sample is skipped
 * rather than swallowing the readout.
 *
 * An empty series answers 0 — there is no sample to name.
 */
export const snapToNearestX = ({ pointerX, xs }: SnapToXParams): number => {
  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const [index, x] of xs.entries()) {
    const distance = Math.abs(pointerX - x);
    if (distance <= nearestDistance) {
      nearestIndex = index;
      nearestDistance = distance;
    }
  }
  return nearestIndex;
};

export interface TooltipAnchorParams {
  /**
   * The x the panel is placed beside, in SVG user units — **not** a snapped
   * one: the panel follows the pointer, the data snaps (#284 D7). The caller
   * passes the continuous pointer position while hovering, and the crosshair's x
   * only for a keyboard selection, which has no pointer.
   */
  readonly followX: number;
  readonly tooltipWidth: number;
  readonly plot: PlotRect;
}

/** SVG user units between the point the panel follows and the panel itself. */
const TOOLTIP_GAP = 8;

/**
 * Left edge of the tooltip panel. It sits to the right of the point it follows
 * until that would push it past the right plot edge, then flips to the left side
 * — the readout follows the pointer without ever running off the canvas.
 *
 * If the panel fits on neither side it pins to the left plot edge.
 * `tooltipPanelWidth` caps the panel at the plot's width, so that arm is
 * the defensive one rather than a state the chart reaches.
 */
export const tooltipAnchorX = ({ followX, tooltipWidth, plot }: TooltipAnchorParams): number => {
  const rightAnchor = followX + TOOLTIP_GAP;
  return rightAnchor + tooltipWidth <= plot.right
    ? rightAnchor
    : Math.max(plot.left, followX - TOOLTIP_GAP - tooltipWidth);
};
