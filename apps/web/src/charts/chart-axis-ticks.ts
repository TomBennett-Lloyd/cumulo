import { utcWeekdayLabel } from './chart-geometry';
import { xAt, type ChartScale, type ForecastChartPoint } from './chart-series';
import { TOOLTIP_CHAR_WIDTH } from './tooltip-geometry';

/**
 * Which instants the time axis labels, and where each label goes — as two tiers
 * that cannot overlap at any width the chart is drawn at (#284 D9).
 *
 * **The contract is an inequality, not a label budget.** The axis used to thin
 * to a fixed count (eight labels, whatever the width), which is a guess about
 * how much room eight of them need; at ~436px of chart the guess was wrong and
 * neighbouring `Wed 14:00` ticks ran into each other. What replaces it is a
 * width model plus a stated invariant — for consecutive labels in one tier,
 *
 *     x[i+1] − x[i] ≥ (w[i] + w[i+1]) / 2 + MIN_LABEL_GAP
 *
 * because labels are middle-anchored, so half of each sits between their two
 * centres. Everything below exists to satisfy that inequality by *dropping
 * labels*, never by setting them smaller: the chart is drawn 1:1 with its
 * measured width (`chart-geometry.ts`'s `chartPlot`) so text is the one thing on
 * this canvas that must not scale with the panel.
 *
 * **Two tiers, because an hour and a day are different questions.** The times
 * tier prints a bare two-digit UTC hour — `06`, `12`, `18`, no minutes, since
 * the data is hourly and `:00` is the same four characters of noise on every
 * tick — and the days tier under it prints `Wed 6`, weekday plus day-of-month
 * because a week-long window carries each weekday twice. Between them they say
 * everything `tickLabelFor`'s long form says, in a third of the width, which is
 * what makes the invariant satisfiable at a narrow chart at all.
 *
 * **A label's position is not this file's to decide.** Every x here comes from
 * the scale's own sample positions (`chart-series.ts`'s `xAt`), which since #325
 * are proportional to time rather than to array position — so a tick sits over
 * the sample it names on an axis with a missing hour in it exactly as it does on
 * a complete one. What this file decides is *which* instants get a label and
 * whether the ones it kept can coexist; where each one lands is the same mapping
 * every mark on the canvas uses.
 *
 * Pure: no React, no DOM, no clock. The tiers are a function of the samples and
 * the scale they are drawn against, so the overlap claim is provable by
 * arithmetic over a sweep of widths rather than by looking at a rendered page —
 * which is the point, since a browser can only ever be asked about the widths
 * somebody thought to try (`testing.md` rule 10).
 */

/** One label of one tier: the text, and the x its middle sits on. */
export interface TierLabel {
  readonly x: number;
  readonly text: string;
}

/** The whole axis: hours, and the days under them. Either may be empty. */
export interface XAxisTiers {
  readonly times: readonly TierLabel[];
  readonly days: readonly TierLabel[];
}

/**
 * Mean advance width of one character of axis text, in SVG user units.
 *
 * Bound to the tooltip's constant rather than measured again, and not because
 * the two are coincidentally equal: axis labels and tooltip rows are the same
 * family at the same size (`--text-xs`, `--font-sans`), so this *is* that
 * measurement — #284 D6 trued it against a rendered panel, and
 * `tooltip-geometry.ts` carries the arithmetic. A second literal here would be
 * a restatement with no owner, and the two would drift the first time either was
 * retuned (`architecture.md` rule 9).
 *
 * The same caveat applies as there: a mean is not a bound, so a tier of wide
 * glyphs is modelled a little narrow. That is why `MIN_LABEL_GAP` is a real gap
 * rather than zero.
 */
export const AXIS_CHAR_WIDTH = TOOLTIP_CHAR_WIDTH;

/**
 * Clear space demanded between two neighbouring labels, in SVG user units.
 *
 * Not slack in the model — labels touching at their box edges read as one
 * smeared string even when nothing technically overlaps, and the width model
 * above is a mean rather than a ceiling. Eight units is a little over one
 * character, so a pair the model got slightly wrong is still visibly two labels.
 */
export const MIN_LABEL_GAP = 8;

/**
 * Hour steps the times tier may take, ascending: the smallest one whose labels
 * satisfy the invariant wins.
 *
 * Every member divides 24, so the labelled hours are the same set of wall-clock
 * times on every day of the window — a step of 5 would print `05, 10, 15, 20`
 * then `01, 06, 11` after midnight, and an axis whose ticks move is harder to
 * read than one with fewer of them.
 */
const HOUR_STEPS: readonly number[] = [1, 2, 3, 6, 12, 24];

const MS_PER_DAY = 86_400_000;

const labelWidth = (text: string): number => text.length * AXIS_CHAR_WIDTH;

/** The invariant, stated once: `right` may follow `left` without crowding it. */
const fitsAfter = (left: TierLabel, right: TierLabel): boolean =>
  right.x - left.x >= (labelWidth(left.text) + labelWidth(right.text)) / 2 + MIN_LABEL_GAP;

/** Whether a whole tier satisfies it, pair by consecutive pair. */
const labelsFit = (labels: readonly TierLabel[]): boolean =>
  labels.every((label, index) => {
    const next = labels[index + 1];
    return next === undefined || fitsAfter(label, next);
  });

/**
 * The tier with every label that would crowd its predecessor dropped.
 *
 * Greedy from the left, which on evenly spaced samples of equal-width labels
 * keeps every nth and is therefore the even thinning it looks like. It is the
 * days tier's only thinning rule — days land where days land, so there is no
 * step to choose — and the times tier's last resort when even a step of a day
 * cannot fit. The first label always survives, which matters for the days tier:
 * that one names the day the window opens in.
 */
const thinnedToFit = (labels: readonly TierLabel[]): readonly TierLabel[] => {
  const kept: TierLabel[] = [];
  for (const label of labels) {
    const previous = kept.at(-1);
    if (previous === undefined || fitsAfter(previous, label)) {
      kept.push(label);
    }
  }
  return kept;
};

/**
 * A label's middle, held far enough from the canvas's left edge that the text
 * still starts on the canvas.
 *
 * Only that end is guarded, and the asymmetry is deliberate rather than an
 * oversight. Labels are middle-anchored, so the first and last ones hang half
 * their width outside the plot — on the right that overhang is exactly what
 * `PLOT_RIGHT_MARGIN` is sized to hold (`chart-geometry.ts` says so in those
 * words), so clamping there would pull the last label off its own sample to buy
 * space that has already been bought. The left gutter is spent on the kW labels
 * and the rotated axis title instead, which sit on other rows, so the only thing
 * a first label can actually run out of on that side is the canvas.
 *
 * At the margins the chart is drawn with, this floor does not bite: the widest
 * label a tier produces is `Wed 30`, whose modelled half is comfortably inside
 * the left gutter at either of the two widths `chartPlot` gives it. It is a
 * floor rather than an assertion because those margins are somebody else's to
 * change — #430 moved both of them, and this arm went on not biting — and
 * because a label clipped at the canvas edge is the #19 defect this chart keeps
 * being asked not to reproduce.
 */
const labelXOnCanvas = (x: number, text: string): number => Math.max(labelWidth(text) / 2, x);

/**
 * One label, at the position its own sample was already placed at.
 *
 * The x is passed in rather than derived here, and since #325 that is the whole
 * of what keeps this tier honest: the axis is time-proportional, so a sample's
 * position is a fact about *when* it is and not about where it sits in the
 * array. Two params rather than a named object, because a string and a number
 * cannot be swapped for each other at a call site — which is exactly what the
 * `index`/`count` pair this replaced could do.
 */
const tierLabel = (text: string, x: number): TierLabel => ({
  text,
  x: labelXOnCanvas(x, text),
});

const twoDigitHour = (instant: Date): string => instant.getUTCHours().toString().padStart(2, '0');

/** `Wed 6` — the day-of-month is what tells two Wednesdays of one week apart. */
const dayText = (instant: Date): string => {
  const dayOfMonth = instant.getUTCDate().toString();
  const weekday = utcWeekdayLabel(instant);
  return weekday === undefined ? dayOfMonth : `${weekday} ${dayOfMonth}`;
};

/** Which UTC day an instant falls in, as a number two instants can be compared by. */
const utcDayNumber = (validTimeIso: string): number =>
  Math.floor(Date.parse(validTimeIso) / MS_PER_DAY);

/**
 * Every sample on an hour divisible by `stepHours`, labelled.
 *
 * Samples off the hour are skipped rather than rounded: this axis's labels are
 * hours, and a series sampled at half past would otherwise print two ticks an
 * hour apart both reading `06`. The product's series are hourly on the hour
 * (`packages/shared`'s `UtcIsoTimestamp` instants come from whole-hour
 * arithmetic), so the arm exists to stay honest rather than to run.
 */
const timeLabelsAtStep = (
  points: readonly ForecastChartPoint[],
  scale: ChartScale,
  stepHours: number,
): readonly TierLabel[] =>
  points.flatMap((point, index) => {
    const instant = new Date(point.validTimeIso);
    return instant.getUTCMinutes() === 0 && instant.getUTCHours() % stepHours === 0
      ? [tierLabel(twoDigitHour(instant), xAt(scale, index))]
      : [];
  });

/** The finest hour step this plot can hold, or the coarsest one thinned further. */
const timesTier = (
  points: readonly ForecastChartPoint[],
  scale: ChartScale,
): readonly TierLabel[] => {
  const candidates = HOUR_STEPS.map((stepHours) => timeLabelsAtStep(points, scale, stepHours));
  return candidates.find(labelsFit) ?? thinnedToFit(candidates.at(-1) ?? []);
};

/**
 * The first sample of each UTC day the window touches.
 *
 * One rule covering the two cases the axis actually has, rather than a midnight
 * rule with an exception bolted on. A window that crosses midnight labels each
 * crossing — the first sample of the new day *is* that midnight for hourly data
 * — and it also labels the sample it opens on, which is the day the reader is
 * looking at for everything left of the first crossing. A window inside one day
 * crosses nothing and gets exactly that opening label, at the plot's left edge,
 * naming the day the whole axis is in.
 */
const dayLabels = (
  points: readonly ForecastChartPoint[],
  scale: ChartScale,
): readonly TierLabel[] =>
  points.flatMap((point, index) => {
    const previous = points[index - 1];
    const opensADay =
      previous === undefined ||
      utcDayNumber(previous.validTimeIso) !== utcDayNumber(point.validTimeIso);
    return opensADay ? [tierLabel(dayText(new Date(point.validTimeIso)), xAt(scale, index))] : [];
  });

/**
 * Both tiers for a series drawn at `scale`. The result satisfies the invariant
 * at the top of this file in each tier independently — the two are drawn on
 * separate rows and have no reason to clear each other.
 */
export const xAxisTiers = (
  points: readonly ForecastChartPoint[],
  scale: ChartScale,
): XAxisTiers => ({
  times: timesTier(points, scale),
  days: thinnedToFit(dayLabels(points, scale)),
});
