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
 * desktop viewport hold the map, the panel's heading row and the whole plot
 * without scrolling, and the chart gets whatever the stack above it leaves. On
 * the demo fleet at the viewport that case pins, that stack — the header bar,
 * the map band (`dashboard.css`'s `.dashboard-map`) and the fleet panel's own
 * chrome and gaps (`dashboard/fleet-panel.css`) — puts the chart's top at 702px
 * of the 900 that viewport is tall (`e2e/chart-surfaces.spec.ts`'s
 * `D15_VIEWPORT`, which owns both numbers), leaving 198px. 184 therefore leaves
 * 14px of slack, which is the margin an image whose `system-ui` sets those
 * text-driven boxes a little taller needs.
 *
 * **The 200 that overflowed was measured on a taller stack**, and saying so is
 * what makes the arithmetic above close: it overflowed by 6px against a chart
 * top of 706px, before the gaps above the panel were tightened. Against today's
 * 702 the same 200 would overflow by 2 — still an overflow, so the choice
 * stands, but a reader checking 900 − 702 − 200 against "6px" is checking two
 * different stacks. The arithmetic here is the reasoning;
 * `e2e/chart-surfaces.spec.ts` measuring a rendered page is the evidence, and it
 * imports this constant rather than restating it.
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
 * turned both of them parallel to the axis they name; what it does now is keep
 * the top gridline — and a mark that reaches the axis maximum — off the canvas
 * edge, and give the horizon label a line to sit on inside the plot.
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
 * Horizontal position of sample `index` of `count`. A lone sample has no extent
 * to spread across the plot, so it sits in the middle of it.
 */
export const xForIndex = (index: number, count: number, plot: PlotRect): number =>
  count <= 1
    ? (plot.left + plot.right) / 2
    : plot.left + ((plot.right - plot.left) * index) / (count - 1);

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
 * Named rather than positional: `snapToNearestIndex(x, 46, 452, 5)` is four
 * interchangeable numbers at the call site, and swapping two of them is a bug
 * no type can catch.
 */
export interface SnapToIndexParams {
  /** Pointer position in SVG user units — the space the plot rect lives in. */
  readonly pointerX: number;
  readonly plot: PlotRect;
  readonly count: number;
}

/**
 * The sample index nearest `pointerX`, clamped into `[0, count - 1]` so a
 * pointer drifting into the axis margins keeps reading the end sample instead
 * of dropping the readout. Readers aim at a time, not at a 2px line.
 *
 * **A pointer exactly halfway between two samples snaps to the later one.**
 * `Math.round` breaks the tie upward; the direction matters less than the fact
 * that it is fixed, because a pixel that reported two different hours on two
 * passes would make the crosshair look broken.
 */
export const snapToNearestIndex = ({ pointerX, plot, count }: SnapToIndexParams): number => {
  const lastIndex = count - 1;
  const plotWidth = plot.right - plot.left;
  // A lone sample (or a plot with no width to divide by) has one answer.
  if (lastIndex <= 0 || plotWidth <= 0) {
    return 0;
  }
  const exactIndex = ((pointerX - plot.left) / plotWidth) * lastIndex;
  return Math.min(lastIndex, Math.max(0, Math.round(exactIndex)));
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

/** SVG user units between the horizon rule and the words naming it. */
const HORIZON_LABEL_GAP = 6;

export interface HorizonLabelParams {
  /** The horizon rule's x, in SVG user units. */
  readonly ruleX: number;
  /** Rendered advance width of the label text — an estimate, from the caller. */
  readonly labelWidth: number;
  readonly plot: PlotRect;
}

export interface HorizonLabelAnchor {
  readonly x: number;
  /** SVG `text-anchor`: which end of the label sits at `x`. */
  readonly textAnchor: 'start' | 'end';
}

/**
 * Where the "forecast horizon" label goes, given where the rule landed.
 *
 * The same decision `tooltipAnchorX` makes, in the form text needs: the label
 * reads rightwards from the rule until that would push it past the plot, then
 * flips and reads leftwards into the rule instead. Without the flip a late
 * horizon runs off the canvas — a 7-day window puts the rule seven eighths
 * across the plot, and the label rendered as "forecast hori…".
 *
 * The limit is the plot rect, not the view box, even though the view box is
 * wider: the margin beyond the plot belongs to the last x-axis tick label,
 * which is centred on `plot.right` and already spends it.
 *
 * A label too wide for the plot on either side pins its left edge to the left
 * plot edge, matching the tooltip's rule — a label overlapping its own rule is
 * still readable, one whose first word is off the canvas is not.
 */
export const horizonLabelAnchor = ({
  ruleX,
  labelWidth,
  plot,
}: HorizonLabelParams): HorizonLabelAnchor => {
  const rightAnchor = ruleX + HORIZON_LABEL_GAP;
  if (rightAnchor + labelWidth <= plot.right) {
    return { x: rightAnchor, textAnchor: 'start' };
  }
  // End-anchored, so the text runs from `x` leftwards and its far edge is
  // `x - labelWidth` — which is what the floor below keeps inside the plot.
  return {
    x: Math.max(plot.left + labelWidth, ruleX - HORIZON_LABEL_GAP),
    textAnchor: 'end',
  };
};
