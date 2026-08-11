import { describe, expect, it } from 'vitest';
import {
  axisTicks,
  CHART_VIEW_BOX_HEIGHT,
  chartPlot,
  niceAxisMax,
  sampleXs,
  snapToNearestX,
  spanHoursBetween,
  tickLabelFor,
  tooltipAnchorX,
  yForKw,
  type PlotRect,
  type TimedSample,
} from './chart-geometry';

const PLOT: PlotRect = { left: 40, right: 440, top: 20, bottom: 160 };

/** A series from UTC hours of one day — the only thing the x mapping reads. */
const hours = (utcHours: readonly number[]): readonly TimedSample[] =>
  utcHours.map((hour) => ({
    validTimeIso: `2026-07-30T${hour.toString().padStart(2, '0')}:00:00Z`,
  }));

describe('chartPlot', () => {
  /*
   * The margins, pinned as numbers. Every other assertion in this file works in
   * the abstract `PLOT` above, which is right for arithmetic that holds at any
   * rect — but these four are the chart's actual measurements in actual pixels
   * since #284 D15, and "the plot's left margin is 56px" is the claim, not an
   * incidental of one. Written out rather than recomputed from the module's own
   * private constants, which would assert nothing.
   */
  it('leaves the rotated title and a whole kW label to the left, half a time label to the right', () => {
    const plot = chartPlot(1000);

    // 56 and not the 48 D15 measured: since D10 the left gutter holds the
    // `Power (kW)` title running up the canvas edge as well as the widest kW
    // tick label, and 48 left the two touching.
    expect(plot.left).toBe(56);
    // 24 of right margin, not the 32 that stood from #284 D9 until #430: half
    // the widest label either time tier can centre on this edge, measured on a
    // rendered page rather than modelled, plus slack.
    expect(plot.right).toBe(976);
    expect(plot.top).toBe(12);
  });

  /*
   * The other regime, and the reason `chartPlot` takes a width at all now
   * (#430). The pair in the left gutter is a fixed cost in pixels, so on a
   * phone-width chart it was a quarter of the canvas; the gap between the widest
   * kW label and the plot is the one part of it a narrow chart can spend, and
   * this is where it is spent.
   *
   * Both regimes are asserted at widths a real page produces — 358 is the chart
   * a 390px phone gives, 1000 is an ordinary desktop panel — rather than either
   * side of the threshold, so a case fails when a *rendered* chart changes
   * gutter and not merely when the threshold is retuned.
   */
  it('spends the kW label gap, and only that, on a chart too narrow for the wide gutter', () => {
    expect(chartPlot(358).left).toBe(50);
    expect(chartPlot(1000).left).toBe(56);
    // The right margin is the same distance in both: it holds half a label, and
    // a label is the width the type makes it whatever the panel is doing.
    expect(chartPlot(358).right).toBe(334);
  });

  it('gives the time axis a fixed band under the plot, whatever the width', () => {
    // The floor is measured up from the chart's own height, so it does not move
    // with the width — which is what lets the axis keep one tier of labels (and,
    // later, two) in space the plot has already given up.
    expect(chartPlot(400).bottom).toBe(chartPlot(1600).bottom);
    // Two tiers of labels and the axis title under them, descenders included.
    expect(CHART_VIEW_BOX_HEIGHT - chartPlot(400).bottom).toBe(48);
  });

  it('widens only rightwards within one gutter regime', () => {
    // Both wide, so the only thing varying is the width itself. The left edge
    // does move across the narrow/wide threshold since #430 — deliberately, and
    // by the six units the case above pins — so a claim that it never moves
    // would now be false rather than conservative.
    const narrow = chartPlot(640);
    const wide = chartPlot(1840);

    expect(wide.left).toBe(narrow.left);
    expect(wide.right - narrow.right).toBe(1200);
  });
});

describe('sampleXs', () => {
  const PLOT_WIDTH = PLOT.right - PLOT.left;
  const PLOT_MIDDLE = 240;

  it('puts the first sample on the left plot edge and the last on the right', () => {
    const xs = sampleXs(hours([0, 1, 2, 3, 4]), PLOT);

    expect(xs.at(0)).toBe(PLOT.left);
    expect(xs.at(-1)).toBe(PLOT.right);
  });

  it('spaces an unbroken hourly series evenly, as the index mapping it replaced did', () => {
    // The invariant the #325 refactor rests on: on a gapless series the two
    // mappings agree exactly, which is why every existing coordinate assertion
    // in this package came through the change untouched.
    expect(sampleXs(hours([0, 1, 2, 3, 4]), PLOT)).toStrictEqual([40, 140, 240, 340, 440]);
  });

  /*
   * The ticket, in one case. 03:00 is absent from the series, and the axis owes
   * that hour its width anyway: 04:00 is four fifths of the way through a
   * five-hour window and belongs four fifths across the plot. Placed by index it
   * would be the fourth of five samples and land at three quarters — the gap
   * closed up, and the two hours either side of it drawn as neighbours they are
   * not.
   */
  it('a missing hour keeps its width on the axis', () => {
    const xs = sampleXs(hours([0, 1, 2, 4, 5]), PLOT);

    expect(xs[3]).toBe(PLOT.left + 0.8 * PLOT_WIDTH);
    // The negative half, and the whole point of the pair: a refactor that
    // quietly kept index spacing satisfies the line above only if this fails.
    expect(xs[3]).not.toBe(PLOT.left + 0.75 * PLOT_WIDTH);
  });

  it('centres a lone sample, which has no extent to spread across the plot', () => {
    expect(sampleXs(hours([6]), PLOT)).toStrictEqual([PLOT_MIDDLE]);
  });

  it('centres every sample of a series that spans no time at all', () => {
    // Two readings of one instant order nothing, so there is no fraction to
    // place them by and no reason to prefer either end of the plot.
    expect(sampleXs(hours([6, 6]), PLOT)).toStrictEqual([PLOT_MIDDLE, PLOT_MIDDLE]);
  });

  it('has no positions to give for a series with no samples', () => {
    expect(sampleXs([], PLOT)).toStrictEqual([]);
  });

  it('centres a sample whose own instant will not parse, and places the rest as usual', () => {
    const xs = sampleXs([...hours([0]), { validTimeIso: 'not a time' }, ...hours([2])], PLOT);

    expect(xs).toStrictEqual([PLOT.left, PLOT_MIDDLE, PLOT.right]);
  });

  /*
   * The clock the fleet actually lives under. 2026-10-25T01:00Z is the instant
   * UK/Ireland clocks go back, so a series across it has two local 01:00s and
   * one of them is an hour that local arithmetic would place on top of the
   * other. Epoch milliseconds have no such hour: four samples an hour apart are
   * four evenly spaced samples through the transition, exactly as they are on
   * any other night.
   */
  it('spaces a series evenly across a DST transition, which local time would not', () => {
    const acrossTheChange = [
      '2026-10-25T00:00:00Z',
      '2026-10-25T01:00:00Z',
      '2026-10-25T02:00:00Z',
      '2026-10-25T03:00:00Z',
    ].map((validTimeIso) => ({ validTimeIso }));

    expect(sampleXs(acrossTheChange, PLOT)).toStrictEqual([
      40, 173.33333333333334, 306.6666666666667, 440,
    ]);
  });
});

describe('yForKw', () => {
  it('maps zero to the plot floor and the axis maximum to its ceiling', () => {
    expect(yForKw(0, 8, PLOT)).toBe(PLOT.bottom);
    expect(yForKw(8, 8, PLOT)).toBe(PLOT.top);
  });

  it('maps half the axis maximum to the middle of the plot', () => {
    expect(yForKw(4, 8, PLOT)).toBe(90);
  });
});

describe('niceAxisMax', () => {
  it('gives an all-zero series a 1 kW axis rather than a degenerate scale', () => {
    expect(niceAxisMax(0)).toBe(1);
    expect(niceAxisMax(0.4)).toBe(1);
  });

  it('takes the smallest allowed step at or above the series maximum', () => {
    expect(niceAxisMax(1)).toBe(1);
    expect(niceAxisMax(1.1)).toBe(2);
    expect(niceAxisMax(3.5)).toBe(4);
    expect(niceAxisMax(4.2)).toBe(5);
    expect(niceAxisMax(6.2)).toBe(8);
    expect(niceAxisMax(8)).toBe(8);
  });

  it('rolls into the next decade when nothing in this one reaches the maximum', () => {
    expect(niceAxisMax(8.1)).toBe(10);
    expect(niceAxisMax(47)).toBe(50);
    expect(niceAxisMax(420)).toBe(500);
    expect(niceAxisMax(900)).toBe(1000);
    expect(niceAxisMax(1000)).toBe(1000);
  });

  it('falls back to the floor for a non-finite maximum instead of hunting a decade', () => {
    expect(niceAxisMax(Number.NaN)).toBe(1);
    expect(niceAxisMax(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe('axisTicks', () => {
  it('spans zero to the axis maximum in five evenly spaced steps', () => {
    expect(axisTicks(8)).toStrictEqual([0, 2, 4, 6, 8]);
    expect(axisTicks(1)).toStrictEqual([0, 0.25, 0.5, 0.75, 1]);
  });
});

/*
 * `xTickIndices` and its fixed label budget were deleted by #284 D9, and the
 * cases that pinned the budget went with them rather than moving. They asserted
 * "at most eight labels, first and last kept", which is a count — and a count is
 * precisely what could not tell a legible axis from an overlapping one, since
 * eight labels fit at some widths and collided at others. What replaced it is
 * `chart-axis-ticks.ts`'s overlap invariant, swept over widths and spans in
 * `chart-axis-ticks.test.ts`; deleting these rather than porting them is the
 * point, not an omission.
 */

describe('tickLabelFor', () => {
  it('labels an instant in UTC wall time, not the reader local zone', () => {
    expect(tickLabelFor('2026-07-30T13:00:00Z', 12)).toBe('13:00');
    expect(tickLabelFor('2026-07-30T00:30:00Z', 12)).toBe('00:30');
  });

  // The clock decision is load-bearing for a solar product (docs/tech-debt.md,
  // 2026-07-31): rendered in local time, an Irish summer peak sits an hour off
  // solar noon. Running the same assertion under a non-UTC ambient zone is the
  // control that proves the axis reads UTC rather than inheriting the host.
  it('labels the same instant identically under a non-UTC ambient timezone', () => {
    const ambient = process.env.TZ;
    try {
      process.env.TZ = 'Asia/Tokyo';

      // 16:00 UTC on a Thursday is 01:00 the following Friday in Tokyo, so
      // both halves of the label differ if either accessor reads the host.
      expect(tickLabelFor('2026-07-30T16:00:00Z', 24)).toBe('Thu 16:00');
      expect(tickLabelFor('2026-07-30T16:00:00Z', 12)).toBe('16:00');
    } finally {
      process.env.TZ = ambient;
    }
  });

  it('prefixes a short weekday once a bare time stops identifying a point', () => {
    expect(tickLabelFor('2026-07-30T14:00:00Z', 168)).toBe('Thu 14:00');
    expect(tickLabelFor('2026-07-30T14:00:00Z', 48)).toBe('Thu 14:00');
  });

  /*
   * The threshold is a full day, not two. A series spanning exactly 24 hours
   * carries the same wall-clock time at both ends — the default view does
   * precisely this, and shipped two ticks reading `12:00` with nothing to tell
   * them apart. Below a day no time can repeat, so the prefix is noise.
   */
  it('prefixes the weekday from a full day of span, where a time can first repeat', () => {
    expect(tickLabelFor('2026-07-30T12:00:00Z', 24)).toBe('Thu 12:00');
    expect(tickLabelFor('2026-07-30T12:00:00Z', 23.9)).toBe('12:00');
  });
});

describe('snapToNearestX', () => {
  /** Five unbroken hours: PLOT spans 40..440, so they sit 100 apart. */
  const EVEN_XS = sampleXs(hours([0, 1, 2, 3, 4]), PLOT);

  it('reads the sample under the pointer at each sample position', () => {
    expect(snapToNearestX({ pointerX: PLOT.left, xs: EVEN_XS })).toBe(0);
    expect(snapToNearestX({ pointerX: 240, xs: EVEN_XS })).toBe(2);
    expect(snapToNearestX({ pointerX: PLOT.right, xs: EVEN_XS })).toBe(4);
  });

  it('reads the nearer sample when the pointer falls between two', () => {
    expect(snapToNearestX({ pointerX: 160, xs: EVEN_XS })).toBe(1);
    expect(snapToNearestX({ pointerX: 220, xs: EVEN_XS })).toBe(2);
  });

  it('breaks an exact midpoint towards the later sample', () => {
    // 190 is exactly between index 1 (140) and index 2 (240). The direction
    // matters less than it being fixed: one pixel must not report two hours.
    expect(snapToNearestX({ pointerX: 190, xs: EVEN_XS })).toBe(2);
    expect(snapToNearestX({ pointerX: 189, xs: EVEN_XS })).toBe(1);
  });

  /*
   * The gap case, which is where index-space rounding got the answer wrong.
   * Hours 00, 01, 02, 04, 05 put samples at 40, 120, 200, 360 and 440, so the
   * hole between index 2 and index 3 is 160 wide and its midpoint is 280 —
   * nowhere near the 290 an evenly divided plot would have put it. A pointer at
   * 285 is therefore past the middle of the gap and belongs to the later hour,
   * which is precisely the reading the old mapping would have got backwards.
   */
  it('snaps to the nearer sample across an uneven gap', () => {
    const gappy = sampleXs(hours([0, 1, 2, 4, 5]), PLOT);

    expect(snapToNearestX({ pointerX: 279, xs: gappy })).toBe(2);
    expect(snapToNearestX({ pointerX: 281, xs: gappy })).toBe(3);
    expect(snapToNearestX({ pointerX: 285, xs: gappy })).toBe(3);
  });

  it('reads the nearest end sample for a pointer outside the plot', () => {
    expect(snapToNearestX({ pointerX: -1000, xs: EVEN_XS })).toBe(0);
    expect(snapToNearestX({ pointerX: 1000, xs: EVEN_XS })).toBe(4);
  });

  it('reads the only sample of a single-point series wherever the pointer is', () => {
    expect(snapToNearestX({ pointerX: 400, xs: sampleXs(hours([6]), PLOT) })).toBe(0);
  });

  it('answers the first index for a series with no samples to snap to', () => {
    expect(snapToNearestX({ pointerX: 400, xs: [] })).toBe(0);
  });
});

describe('tooltipAnchorX', () => {
  const TOOLTIP_WIDTH = 100;

  it('sits to the right of the point it follows while the panel fits there', () => {
    const anchor = tooltipAnchorX({ followX: 300, tooltipWidth: TOOLTIP_WIDTH, plot: PLOT });

    expect(anchor).toBeGreaterThan(300);
    expect(anchor + TOOLTIP_WIDTH).toBeLessThanOrEqual(PLOT.right);
  });

  it('flips to the left of the point it follows rather than overflow the right edge', () => {
    const anchor = tooltipAnchorX({ followX: 430, tooltipWidth: TOOLTIP_WIDTH, plot: PLOT });

    expect(anchor + TOOLTIP_WIDTH).toBeLessThanOrEqual(430);
    expect(anchor).toBeGreaterThanOrEqual(PLOT.left);
  });

  // Every position, not every sample: the pointer this follows is continuous,
  // so a version that only held at the five snapped x's would be a weaker claim
  // than the one the chart needs.
  it('keeps the panel inside the plot at every position it can be asked to follow', () => {
    for (let followX = PLOT.left; followX <= PLOT.right; followX += 1) {
      const anchor = tooltipAnchorX({ followX, tooltipWidth: TOOLTIP_WIDTH, plot: PLOT });

      expect(anchor).toBeGreaterThanOrEqual(PLOT.left);
      expect(anchor + TOOLTIP_WIDTH).toBeLessThanOrEqual(PLOT.right);
    }
  });

  it('pins to the left plot edge when the panel fits on neither side', () => {
    const overwide = PLOT.right - PLOT.left + 1;

    expect(tooltipAnchorX({ followX: 100, tooltipWidth: overwide, plot: PLOT })).toBe(PLOT.left);
  });
});

describe('spanHoursBetween', () => {
  it('measures the series span in hours', () => {
    expect(spanHoursBetween('2026-07-30T00:00:00Z', '2026-07-31T00:00:00Z')).toBe(24);
    expect(spanHoursBetween('2026-07-30T00:00:00Z', '2026-07-30T00:30:00Z')).toBe(0.5);
  });

  it('is zero across a single instant', () => {
    expect(spanHoursBetween('2026-07-30T00:00:00Z', '2026-07-30T00:00:00Z')).toBe(0);
  });
});
