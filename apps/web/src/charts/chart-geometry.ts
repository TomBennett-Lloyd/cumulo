/**
 * Pure chart geometry: kW → SVG user unit, axis choice, tick thinning, and
 * time-axis labelling. No React, no DOM — every function here is a plain
 * input/output pair, so the chart's arithmetic is testable without rendering
 * one and the component is left holding only composition.
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
 * Mantissas a "nice" axis maximum may take, ascending within a decade. 3, 6, 7
 * and 9 are excluded: they produce quarter-steps nobody reads off a gridline.
 */
const AXIS_MANTISSAS: readonly number[] = [1, 2, 4, 5, 8];
const AXIS_TICK_COUNT = 5;
const DEFAULT_MAX_X_LABELS = 8;
/** An all-zero series still gets an axis rather than a degenerate 0–0 scale. */
const MINIMUM_AXIS_MAX_KW = 1;
/** Above this span a bare `HH:mm` repeats often enough to need a weekday. */
const MULTI_DAY_SPAN_HOURS = 48;
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
 * Sample indices that get an x-axis label: evenly thinned to at most
 * `maxLabels`, and always including the first and the last sample so the axis
 * states the range it covers.
 */
export const xTickIndices = (
  count: number,
  maxLabels = DEFAULT_MAX_X_LABELS,
): readonly number[] => {
  if (count <= 0) {
    return [];
  }
  if (count <= maxLabels) {
    return Array.from({ length: count }, (_unused, index) => index);
  }
  const step = Math.ceil((count - 1) / (maxLabels - 1));
  const stepped = Array.from({ length: Math.ceil((count - 1) / step) }, (_unused, k) => k * step);
  return [...stepped, count - 1];
};

/**
 * UTC wall-clock label for an instant. Series spanning more than two days get a
 * short weekday prefix, because `14:00` alone stops identifying a point once the
 * axis carries several of them.
 */
export const tickLabelFor = (validTimeIso: string, spanHours: number): string => {
  const instant = new Date(validTimeIso);
  const time = `${padded(instant.getUTCHours())}:${padded(instant.getUTCMinutes())}`;
  if (spanHours <= MULTI_DAY_SPAN_HOURS) {
    return time;
  }
  const weekday = WEEKDAY_LABELS[instant.getUTCDay()];
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
  /** Crosshair position in SVG user units. */
  readonly snappedX: number;
  readonly tooltipWidth: number;
  readonly plot: PlotRect;
}

/** SVG user units between the crosshair and the panel it labels. */
const TOOLTIP_GAP = 8;

/**
 * Left edge of the tooltip panel. It sits to the right of the crosshair until
 * that would push it past the right plot edge, then flips to the left side —
 * the readout follows the pointer without ever running off the canvas.
 *
 * If the panel fits on neither side it pins to the left plot edge: a readout
 * overlapping its own crosshair is still readable, one half off the chart is
 * not.
 */
export const tooltipAnchorX = ({ snappedX, tooltipWidth, plot }: TooltipAnchorParams): number => {
  const rightAnchor = snappedX + TOOLTIP_GAP;
  return rightAnchor + tooltipWidth <= plot.right
    ? rightAnchor
    : Math.max(plot.left, snappedX - TOOLTIP_GAP - tooltipWidth);
};
