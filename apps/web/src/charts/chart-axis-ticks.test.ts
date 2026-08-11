import { describe, expect, it } from 'vitest';
import {
  AXIS_CHAR_WIDTH,
  MIN_LABEL_GAP,
  xAxisTiers,
  type TierLabel,
  type XAxisTiers,
} from './chart-axis-ticks';
import { chartPlot, sampleXs, type PlotRect } from './chart-geometry';
import type { ChartScale, ForecastChartPoint } from './chart-series';

/*
 * The axis's one contract is that two labels in a tier never crowd each other,
 * at any width the chart can be drawn at. That is a claim about a whole space of
 * inputs rather than about a case, so the suite sweeps the space: every plot
 * width the chart plausibly gets, crossed with every window the product offers,
 * asserting the inequality itself at each.
 *
 * Deliberately not a count. "At most eight labels" is what the axis used to
 * promise and it is exactly the wrong promise — eight fitted at some widths and
 * overlapped at others, and a test asserting the count passed the whole time.
 */

const MS_PER_HOUR = 3_600_000;

/**
 * Midday, so every window opens partway through a day.
 *
 * The product's default view is "the past 24 h and the forecast ahead", which is
 * centred on now and therefore almost never starts at midnight — a series
 * beginning exactly at midnight is the easy case for a day tier, and the one
 * worth *not* building the fixtures out of.
 */
const SERIES_START_MS = Date.UTC(2026, 6, 23, 12);

const hourlySeries = (spanHours: number): readonly ForecastChartPoint[] =>
  Array.from({ length: spanHours + 1 }, (_unused, index) => ({
    validTimeIso: new Date(SERIES_START_MS + index * MS_PER_HOUR).toISOString(),
    medianKw: 1,
    actualKw: null,
  }));

/**
 * Nothing here is a kW: the tiers read the scale for its sample positions and
 * for nothing else, so this stands in for the one field they never touch.
 */
const UNREAD_AXIS_MAX_KW = 1;

/**
 * The tiers a series gets in a plot of that shape.
 *
 * The scale is assembled here rather than passed in because the x mapping is the
 * series' own since #325 — `sampleXs` over these points is what decides where a
 * label goes, and building it beside the points keeps the two from drifting
 * apart in a case that meant them to match.
 */
const tiersOf = (points: readonly ForecastChartPoint[], plot: PlotRect): XAxisTiers => {
  const scale: ChartScale = { plot, axisMaxKw: UNREAD_AXIS_MAX_KW, xs: sampleXs(points, plot) };
  return xAxisTiers(points, scale);
};

/** The windows the fleet panel's range picker can ask for, in hours of span. */
const SWEPT_SPANS: readonly number[] = [24, 48, 168];

/**
 * The chart width the single-tier axis was measured overlapping at.
 *
 * #284 C5 found `Wed 14:00` ticks running into each other at about this width —
 * the canvas contained them, and they collided with each other, which is the
 * defect the tier split exists to fix. It sits between two steps of the sweep
 * below, so it is named and swept explicitly rather than left to the grid to
 * happen to cover.
 */
const MEASURED_OVERLAP_WIDTH = 436;

/** 320 to 1600 in steps of 64: a phone column through a wide desktop panel. */
const SWEPT_WIDTHS: readonly number[] = [
  MEASURED_OVERLAP_WIDTH,
  ...Array.from({ length: 21 }, (_unused, step) => 320 + step * 64),
];

/**
 * Consecutive labels that fail the invariant, described.
 *
 * The inequality is written out here rather than imported from the module under
 * test: a suite that asks the production predicate whether the production output
 * satisfies it proves only that the predicate is deterministic. The two
 * *constants* are imported, because they are the width model and it has one
 * owner — restating `6.3` here would make this suite green against a model the
 * chart no longer uses.
 */
const crowdedPairs = (labels: readonly TierLabel[]): readonly string[] =>
  labels.flatMap((label, index) => {
    const next = labels[index + 1];
    if (next === undefined) {
      return [];
    }
    const required = ((label.text.length + next.text.length) * AXIS_CHAR_WIDTH) / 2 + MIN_LABEL_GAP;
    const between = next.x - label.x;
    return between >= required
      ? []
      : [
          `"${label.text}"→"${next.text}" ${between.toFixed(1)} apart, needs ${required.toFixed(1)}`,
        ];
  });

describe('xAxisTiers', () => {
  it('never lets two labels in a tier crowd each other, at any width or span the chart is drawn at', () => {
    const failures = SWEPT_WIDTHS.flatMap((width) =>
      SWEPT_SPANS.flatMap((spanHours) => {
        const tiers = tiersOf(hourlySeries(spanHours), chartPlot(width));
        return [
          ...crowdedPairs(tiers.times).map(
            (pair) => `${String(width)}px/${String(spanHours)}h times: ${pair}`,
          ),
          ...crowdedPairs(tiers.days).map(
            (pair) => `${String(width)}px/${String(spanHours)}h days: ${pair}`,
          ),
        ];
      }),
    );

    expect(failures).toStrictEqual([]);
  });

  /*
   * The vacuity guard, and it is not a formality: an axis that returned no
   * labels at all would satisfy every assertion above, and is also exactly what
   * a thinning bug looks like when it thins too hard. Every case in the sweep
   * has to still be an axis.
   */
  it('still labels every width and span it was swept at', () => {
    const silent = SWEPT_WIDTHS.flatMap((width) =>
      SWEPT_SPANS.flatMap((spanHours) => {
        const tiers = tiersOf(hourlySeries(spanHours), chartPlot(width));
        return tiers.times.length > 0 && tiers.days.length > 0
          ? []
          : [
              `${String(width)}px/${String(spanHours)}h: ${String(tiers.times.length)} times, ${String(tiers.days.length)} days`,
            ];
      }),
    );

    expect(silent).toStrictEqual([]);
  });

  it('prints hours as two bare digits, with no minutes to read past', () => {
    const { times } = tiersOf(hourlySeries(48), chartPlot(640));

    expect(times.length).toBeGreaterThan(1);
    for (const label of times) {
      expect(label.text).not.toContain(':');
      expect(label.text).toMatch(/^\d{2}$/u);
    }
  });

  /*
   * The reason the day tier carries a day-of-month at all. A bare weekday
   * repeats within a week-long window, so two labels a week apart would read
   * identically — which is the same defect the old single-tier axis had when a
   * bare `14:00` appeared twice, one level up.
   */
  it('names every day of a week-long window distinctly', () => {
    const { days } = tiersOf(hourlySeries(168), chartPlot(1600));
    const texts = days.map((label) => label.text);

    expect(texts.length).toBeGreaterThan(1);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('names the day of a window that spans one, and puts it at the plot edge', () => {
    // Noon to 23:00 — inside one UTC day, crossing no midnight, so the only
    // thing that can name the day is the label the window opens with.
    const plot = chartPlot(640);
    const { days } = tiersOf(hourlySeries(11), plot);

    expect(days).toHaveLength(1);
    expect(days[0]?.text).toBe('Thu 23');
    expect(days[0]?.x).toBe(plot.left);
  });

  it('names the day a full-day window opens in as well as the one it crosses into', () => {
    const { days } = tiersOf(hourlySeries(24), chartPlot(640));

    expect(days.map((label) => label.text)).toStrictEqual(['Thu 23', 'Fri 24']);
  });

  /*
   * The measured defect, as a behaviour rather than as a width: at the width the
   * old axis overlapped at, the fix is that fewer hours are labelled — not that
   * they are set smaller. A chart 436px wide cannot hold 24 hourly ticks, and
   * what it does about that is drop some.
   */
  it('thins the hours it labels rather than shrinking them, at the width the old axis overlapped at', () => {
    const points = hourlySeries(24);
    const { times } = tiersOf(points, chartPlot(MEASURED_OVERLAP_WIDTH));

    expect(times.length).toBeGreaterThan(1);
    expect(times.length).toBeLessThan(points.length);
    expect(crowdedPairs(times)).toStrictEqual([]);
  });

  it('has no tiers to draw for a series with no samples', () => {
    const tiers = tiersOf([], chartPlot(640));

    expect(tiers.times).toStrictEqual([]);
    expect(tiers.days).toStrictEqual([]);
  });

  it('labels a lone sample where that sample is drawn, in the middle of the plot', () => {
    const plot = chartPlot(640);
    const middle = (plot.left + plot.right) / 2;
    const tiers = tiersOf(hourlySeries(0), plot);

    expect(tiers.times.map((label) => label.text)).toStrictEqual(['12']);
    expect(tiers.times[0]?.x).toBe(middle);
    expect(tiers.days.map((label) => label.text)).toStrictEqual(['Thu 23']);
  });
});
