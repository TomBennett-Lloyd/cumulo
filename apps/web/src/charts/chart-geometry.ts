/**
 * Pure chart geometry: kW → SVG user unit, axis choice, and the plot rect every
 * mark is placed in. No React, no DOM — every function here is a plain
 * input/output pair, so the chart's arithmetic is testable without rendering
 * one and the component is left holding only composition.
 *
 * **Where the time axis's own labelling went.** Choosing which instants the x
 * axis labels, and proving that those labels cannot collide, is
 * `chart-axis-ticks.ts` — it needs a width model for text and a search over
 * candidate tick steps, which is a different kind of arithmetic from the
 * coordinate mapping here (`structure.md` rule 4). What stays here is the
 * vocabulary both share: `utcWeekdayLabel`, and `tickLabelFor`'s day-qualified
 * long form, which the table twin and the hover readout still print at full
 * `HH:mm` precision even though the axis itself no longer does.
 *
 * **The time axis runs on UTC.** `docs/design/chart-treatment.md` specifies the
 * horizon boundary, the series treatment and the colour roles but never names a
 * clock (`docs/tech-debt.md`, 2026-07-31); #19 settles it as UTC. Two reasons:
 * the forecast payload carries UTC instants (`UtcIsoTimestamp`) and nothing
 * upstream carries a per-site timezone through to the axis, and UTC is the one
 * clock with no DST transition, so every rendered day is 24 hours and no hour is
 * silently dropped or duplicated. Labels are therefore always UTC wall time,
 * never the reader's local zone — `getUTC*` accessors below, never `getHours`.
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
 * **The value is what fits, measured rather than chosen.** #284 D15 asks that a
 * desktop viewport hold the map, the row of chrome over the chart and the whole
 * plot without scrolling, and the chart gets whatever the stack above it leaves.
 * On the demo fleet at the viewport that case pins
 * (`e2e/chart-surfaces.spec.ts`'s `D15_VIEWPORT`, which owns both numbers), that
 * stack is the header bar, the map band (`dashboard.css`'s `.dashboard-map`) and
 * the chart section's own top padding and controls row
 * (`dashboard/fleet-panel.css`) — and it puts the plot's top at 636px of the 900
 * that viewport is tall, leaving 264.
 *
 * **Re-measured for #323, which took a heading row, a padding step and a gap out
 * of that stack.** The derivation this docblock used to carry was made against
 * the taller one and read 702px and 198px left; both are history now, and the
 * plot's bottom sits 80px clear of the fold rather than 14.
 *
 * **Those 80px are not headroom the plot may grow into, which is why 184 stayed
 * put.** The plot is not the bottom of the figure — the legend and the folded
 * data table's disclosure hang below it, and at the same reading the figure ends
 * at 894px, 6px short of the fold, with the section's own bottom padding
 * finishing 2px past it. So what fits is about 190; the slack is 6px rather than
 * the 14 it was, and 184 remains very nearly the measured answer. The 200 that
 * overflowed on the old stack still overflows on this one, by 10px of the figure
 * where it used to be 6px of the plot. #323 was asked for width and not height,
 * and nothing above asks the height to change.
 *
 * **The row changed twice on 2026-08-11, and 184 stands because neither change
 * made it taller.** The owner reversed #323's heading-and-stats half, so the
 * controls row carries four items where it carried two, and then folded the
 * window picker into a calendar trigger (`dashboard/FleetPanel.tsx` and
 * `dashboard/range-picker.tsx` carry the two arguments). It is one flex line
 * throughout, and a flex line is as tall as its tallest item. The heading was
 * never that item and still is not — its line box sits under the controls' on
 * both sides of the change. What did change is which control is tallest: the (i)
 * and the picker's trigger now are, level with each other and a pixel under what
 * the segmented picker used to be.
 *
 * So the row did not grow, which is the whole of what this derivation asks of it,
 * and none of the numbers above were re-derived here. The pixel it gave back
 * leaves the paragraph above conservative rather than stale — the figure's bottom
 * and the slack over it each move by it, in the direction that fits. The
 * px-by-px reading behind all of this is deliberately not repeated here:
 * `dashboard/fleet-panel.css` owns the row's own arithmetic — every item's
 * measured box, which of them sets the height, and the container width below
 * which the stats line hides — and points at this constant for the height rather
 * than restating it (`architecture.md` rule 9). This passage carried four of
 * those literals before the fold and now carries a single relative figure; the
 * pointer is what replaced them, not detail lost.
 *
 * **The disclosure and the legend both left the figure later that same day, and
 * the tighter reading above is no longer a reading of the same box.** The
 * raw-data twin is a panel *after* the figure now rather than a row inside it
 * (`ForecastChart.tsx`), and it wears a padding step of its own on top of the
 * body grid's gap (`charts.css`); the legend went to the fleet panel's (i)
 * (`dashboard/FleetPanel.tsx`). Nothing above the plot moved, so the stack, the
 * 636 and the 264 are untouched and 184 still fits by exactly the argument
 * above. What moved is what the tighter reading was of: the figure ends at the
 * plot's own visually hidden readout now, which takes no height at all, and what
 * actually finishes the section is the panel below it, which sits lower than the
 * figure's old bottom by the gap and the padding it gained. Those
 * pixels are deliberately not restated, because nothing has re-measured them on
 * a rendered page — the D15 case measures the *plot*, the reading that was never
 * in question here, and it passes unchanged across the move. So "894px, 6px
 * short of the fold" is a dated reading of a box that no longer exists; re-measure
 * before reasoning from the tighter figure again.
 *
 * That is a claim about a rendered row, made from a measurement of the row alone
 * rather than of the dashboard: **the browser wave re-measures the D15 fold on a
 * real page**, which is where a discrepancy would show up and where it would be
 * fixed. Stated rather than assumed, because the whole value of this docblock is
 * that it says which of its numbers came from where.
 *
 * The arithmetic here is the reasoning; `e2e/chart-surfaces.spec.ts` measuring a
 * rendered page is the evidence, and it imports this constant rather than
 * restating it. What that case pins is the *plot's* bottom against the fold,
 * which is the looser of the two readings above and only gained room in #323;
 * the tighter one — where the reading actually finishes, which since 2026-08-11
 * is the raw-data panel below the figure rather than the figure itself — is
 * asserted by no spec in either lane today (`testing.md` rule 10's closing rule).
 */
export const CHART_VIEW_BOX_HEIGHT = 184;

/**
 * The band under the plot that belongs to the time axis: two tiers of tick
 * labels — the hours, then the days that qualify them — and the axis title
 * beneath both (#284 D9/D10). C5 sized it for that whole stack before the
 * second tier existed, which is why the tiers landed in space the plot had
 * already given up rather than over the last gridline; the three baselines that
 * spend it are `forecast-chart-axes.tsx`'s and are stated there, not here.
 *
 * 48 rather than the 44 reserved in advance, and the extra four units are all
 * descender. Three rows at a 14-unit pitch is 41 units to the last baseline, and
 * the axis title is `Time (UTC)` — whose parentheses reach further below that
 * baseline than any letter does. At 44 the title's ink finished about half a
 * unit inside the canvas, which an image with a longer descender turns into a
 * title clipped by the view box; the plot gives up four units of height for the
 * margin. `CHART_VIEW_BOX_HEIGHT` does not move, so D15's fold arithmetic is
 * untouched.
 */
const X_AXIS_BAND = 48;
/**
 * Room to the left of the plot for the two things that share that gutter: the
 * `Power (kW)` title running up the canvas edge, and the widest kW tick label
 * with its gap.
 *
 * Measured for the pair rather than for the label alone, which is what moved it
 * from 48 in #284 D10. The title is rotated `--text-xs` text, so its *height*
 * is its width on screen — about 13 user units against the canvas edge — and
 * `axisTicks` can produce a four-character label (`0.25`, `1000`) which the
 * width model in `chart-axis-ticks.ts` puts at ~25. 13 + 25 + `Y_LABEL_GAP`
 * leaves the title kissing the label at 48; at 56 the two clear each other by
 * about 6 units, which is the slack an image whose `system-ui` sets wider
 * glyphs needs. The plot loses those 8 units from its left edge and nothing
 * else moves.
 */
const PLOT_LEFT = 56;
/**
 * Room to the right of the plot for half of the last time-axis label, which is
 * centred on `plot.right` rather than tucked inside it.
 *
 * Half a label and not a whole one, which is why this is narrower than
 * `PLOT_LEFT` — the kW labels hang entirely to the left of the plot, the time
 * labels straddle their sample.
 *
 * The requirement fell with #284 D9 and the number deliberately did not. The
 * widest label the axis could put on `plot.right` used to be a weekday-prefixed
 * `Wed 12:00`, about 52px, so 26 was the bare half; the two tiers print `18` and
 * `Wed 16` instead, and the widest of those is ~38px, needing 19. Keeping 32
 * spends the difference on slack rather than on plot width — the last label is
 * the one that gets clipped, and the failure is silent until somebody looks at
 * the right edge of the canvas.
 *
 * It matters now in a way it did not before #284 D15. The chart used to be drawn
 * in a fixed view box and scaled up, so a margin of 12 user units became ~28
 * rendered pixels in a wide panel and the label fitted by accident of the scale;
 * at 1:1 a user unit is a pixel and 12 clipped the last label by 13.8px —
 * measured on the demo fleet, and the exact defect `e2e/chart-surfaces.spec.ts`
 * exists to catch.
 */
const PLOT_RIGHT_MARGIN = 32;
/**
 * Headroom above the plot's ceiling. It held the two axis titles until #284 D10
 * turned both of them parallel to the axis they name, and a line for the horizon
 * label to sit on until #429 deleted those words; what it does now is keep the
 * top gridline — and a mark that reaches the axis maximum — off the canvas edge.
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
 * A day exactly, not two: the default 24 h view spans 24 hours of ticks and
 * therefore prints its first and last tick as the same time — which is the
 * moment the treatment's criterion bites, not some later one. Below a day no
 * time can appear twice and the prefix would be noise on every tick.
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
 * **One user unit is one rendered pixel.** The chart used to be drawn in a fixed
 * view box and scaled to whatever width its column gave it, which scaled the
 * *text* with it: the same axis label was 12 units everywhere and 27px in a wide
 * panel, 14px in a narrow one, so the chrome grew and shrank with the window
 * while nothing else on the page did. Measuring the width and drawing at 1:1 is
 * what fixes that, and it makes the margins below real distances rather than
 * ratios — `PLOT_LEFT` is 56px of room for the rotated axis title and a tick
 * label at every viewport, not a fraction of the width that means a different
 * distance in every panel.
 *
 * A function rather than a constant for the same reason: there is no one plot
 * any more, only the plot at the width the chart currently has. Callers that
 * need a plot without a measurement — tests, fixtures — ask for the one at
 * `DEFAULT_CHART_WIDTH` (`use-chart-width.ts`) rather than keeping a rect of
 * their own.
 */
export const chartPlot = (width: number): PlotRect => ({
  left: PLOT_LEFT,
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
 * **An hour with no data still costs its width on the axis** (#325). The axis
 * used to be index-spaced, which meant a series missing 03:00 drew 02:00 and
 * 04:00 as neighbours: the gap in the marks closed up, and the compression was
 * itself a shape the reader could mistake for data. Time-proportional placement
 * leaves the hole where the hole is, so the marks no longer draw two instants
 * two hours apart as if they were an hour apart.
 *
 * **What that does not do is break the line across the hole, and the difference
 * is worth being exact about.** An hour that is *present* in the series carrying
 * null values does break its marks, because the run predicate rejects its index.
 * An hour *absent from the series* does not: `contiguousRuns`
 * (`chart-series.ts`) cuts runs on adjacency in the array, and the two survivors
 * either side of a missing hour are still array-adjacent, so the curve is drawn
 * straight through. Under index spacing that bridge had no width and the claim
 * was harmless; this mapping is what gives it one. So what #325 removes is the
 * compression artefact, not the bridge — recorded in `docs/tech-debt.md`
 * (2026-08-11, "`contiguousRuns` splits on array adjacency, not on time
 * adjacency"), which owns the fix for the half that is left.
 *
 * **The arithmetic is on epoch milliseconds, and is therefore DST-safe.**
 * `Date.parse` on a UTC ISO-8601 instant answers an absolute offset from the
 * epoch, so a difference of two of them is elapsed time with no calendar in it —
 * which is what the UK/Ireland fleet needs, since its clocks change twice a year
 * and the axis must not gain or lose an hour of width when they do. It pairs
 * with the file's UTC labelling above rather than duplicating it: this decides
 * *where* a sample goes, `tickLabelFor` decides what it is called, and both read
 * the same instant the same way.
 *
 * Two degenerate answers, both the plot's middle: a lone sample has no extent to
 * spread across the plot, and neither does a series whose first and last samples
 * are the same instant. A sample whose own timestamp will not parse gets the
 * middle too — a position had to be chosen, and the middle is the same answer
 * this module already gives whenever time cannot order the samples.
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
 * Exported because the axis prints weekdays too: `chart-axis-ticks.ts`'s day
 * tier spells `Wed 6` out of the same table that spells `Wed 14:00` below, so
 * the product has one set of short weekday names rather than two that agree
 * today (`structure.md` rule 7).
 */
export const utcWeekdayLabel = (instant: Date): string | undefined =>
  WEEKDAY_LABELS[instant.getUTCDay()];

/**
 * UTC wall-clock label for an instant. Series spanning a day or more get a
 * short weekday prefix, because `14:00` alone stops identifying a point as soon
 * as the axis can carry two of them.
 *
 * **This is the long form, and since #284 D9 the x axis is no longer one of its
 * readers.** The axis splits the same information across two tiers — a bare
 * hour over the day that qualifies it — so nothing there needs a prefix. What
 * still prints `Wed 14:00` is every surface showing one instant alone, with no
 * neighbouring tick to qualify it: the table twin's row headers, the hover
 * tooltip, and the spoken readout, where the long form is the whole of what
 * identifies the sample.
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
 * an axis whose samples are unevenly spread: with a gap in the series the
 * midpoint between two neighbours is no longer halfway across the plot, so the
 * old index-space rounding would have handed back the wrong hour on either side
 * of every hole (#325). A pointer beyond either end is nearest to that end
 * sample and reads it, which is the clamping the previous version did
 * explicitly — readers aim at a time, not at a 2px line.
 *
 * **A pointer exactly halfway between two samples snaps to the later one.** The
 * comparison below is `<=` rather than `<` precisely so that it does, and the
 * direction is specified rather than incidental: a pixel that reported two
 * different hours on two passes would make the crosshair look broken. A `NaN`
 * distance never wins either comparison, so an unplaceable sample is skipped
 * rather than swallowing the readout.
 *
 * An empty series answers 0 — there is no sample to name, and the callers that
 * could ask have no readout to draw at that index anyway.
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
   * one. Its only caller passes the continuous pointer position while a pointer
   * is hovering and the crosshair's x only for a keyboard selection, which has
   * no pointer (#284 D7): the panel follows the pointer, the data snaps. So this
   * takes any x in the plot's space, and nothing here rounds it to a sample.
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
 * If the panel fits on neither side it pins to the left plot edge: a readout
 * overlapping the point it labels is still readable, one half off the chart is
 * not. `tooltipPanelWidth` caps the panel at the plot's width, so that arm is
 * the defensive one rather than a state the chart reaches.
 */
export const tooltipAnchorX = ({ followX, tooltipWidth, plot }: TooltipAnchorParams): number => {
  const rightAnchor = followX + TOOLTIP_GAP;
  return rightAnchor + tooltipWidth <= plot.right
    ? rightAnchor
    : Math.max(plot.left, followX - TOOLTIP_GAP - tooltipWidth);
};
