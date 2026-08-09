import { describe, expect, it } from 'vitest';
import {
  axisTicks,
  CHART_VIEW_BOX_HEIGHT,
  chartPlot,
  horizonLabelAnchor,
  niceAxisMax,
  snapToNearestIndex,
  spanHoursBetween,
  tickLabelFor,
  tooltipAnchorX,
  xForIndex,
  yForKw,
  type PlotRect,
} from './chart-geometry';

const PLOT: PlotRect = { left: 40, right: 440, top: 20, bottom: 160 };

describe('chartPlot', () => {
  /*
   * The margins, pinned as numbers. Every other assertion in this file works in
   * the abstract `PLOT` above, which is right for arithmetic that holds at any
   * rect — but these four are the chart's actual measurements in actual pixels
   * since #284 D15, and "the plot's left margin is 48px" is the claim, not an
   * incidental of one. Written out rather than recomputed from the module's own
   * private constants, which would assert nothing.
   */
  it('leaves the rotated title and a whole kW label to the left, half a time label to the right', () => {
    const plot = chartPlot(1000);

    // 56 and not the 48 D15 measured: since D10 the left gutter holds the
    // `Power (kW)` title running up the canvas edge as well as the widest kW
    // tick label, and 48 left the two touching.
    expect(plot.left).toBe(56);
    expect(plot.right).toBe(968);
    expect(plot.top).toBe(12);
  });

  it('gives the time axis a fixed band under the plot, whatever the width', () => {
    // The floor is measured up from the chart's own height, so it does not move
    // with the width — which is what lets the axis keep one tier of labels (and,
    // later, two) in space the plot has already given up.
    expect(chartPlot(400).bottom).toBe(chartPlot(1600).bottom);
    // Two tiers of labels and the axis title under them, descenders included.
    expect(CHART_VIEW_BOX_HEIGHT - chartPlot(400).bottom).toBe(48);
  });

  it('widens only rightwards, so the plot grows with the column it is drawn in', () => {
    const narrow = chartPlot(400);
    const wide = chartPlot(1600);

    expect(wide.left).toBe(narrow.left);
    expect(wide.right - narrow.right).toBe(1200);
  });
});

describe('xForIndex', () => {
  it('puts the first sample on the left plot edge and the last on the right', () => {
    expect(xForIndex(0, 5, PLOT)).toBe(PLOT.left);
    expect(xForIndex(4, 5, PLOT)).toBe(PLOT.right);
  });

  it('spaces intermediate samples evenly across the plot width', () => {
    expect(xForIndex(1, 5, PLOT)).toBe(140);
    expect(xForIndex(2, 5, PLOT)).toBe(240);
  });

  it('centres a lone sample, which has no extent to spread across the plot', () => {
    expect(xForIndex(0, 1, PLOT)).toBe(240);
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

describe('snapToNearestIndex', () => {
  // PLOT spans 40..440 over five samples, so they sit at 40, 140, 240, 340, 440.
  it('reads the sample under the pointer at each sample position', () => {
    expect(snapToNearestIndex({ pointerX: PLOT.left, plot: PLOT, count: 5 })).toBe(0);
    expect(snapToNearestIndex({ pointerX: 240, plot: PLOT, count: 5 })).toBe(2);
    expect(snapToNearestIndex({ pointerX: PLOT.right, plot: PLOT, count: 5 })).toBe(4);
  });

  it('reads the nearer sample when the pointer falls between two', () => {
    expect(snapToNearestIndex({ pointerX: 160, plot: PLOT, count: 5 })).toBe(1);
    expect(snapToNearestIndex({ pointerX: 220, plot: PLOT, count: 5 })).toBe(2);
  });

  it('breaks an exact midpoint towards the later sample', () => {
    // 190 is exactly between index 1 (140) and index 2 (240). The direction
    // matters less than it being fixed: one pixel must not report two hours.
    expect(snapToNearestIndex({ pointerX: 190, plot: PLOT, count: 5 })).toBe(2);
    expect(snapToNearestIndex({ pointerX: 189, plot: PLOT, count: 5 })).toBe(1);
  });

  it('clamps a pointer outside the plot to the nearest end sample', () => {
    expect(snapToNearestIndex({ pointerX: -1000, plot: PLOT, count: 5 })).toBe(0);
    expect(snapToNearestIndex({ pointerX: 1000, plot: PLOT, count: 5 })).toBe(4);
  });

  it('reads the only sample of a single-point series wherever the pointer is', () => {
    expect(snapToNearestIndex({ pointerX: 400, plot: PLOT, count: 1 })).toBe(0);
  });

  it('has nothing to divide by when the plot has no width', () => {
    const degenerate: PlotRect = { ...PLOT, right: PLOT.left };

    expect(snapToNearestIndex({ pointerX: 400, plot: degenerate, count: 5 })).toBe(0);
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

describe('horizonLabelAnchor', () => {
  // Wide enough that the flip happens well inside the plot, as the real label does.
  const LABEL_WIDTH = 84;

  it('reads rightwards from the rule while the label fits before the plot edge', () => {
    const anchor = horizonLabelAnchor({ ruleX: 200, labelWidth: LABEL_WIDTH, plot: PLOT });

    expect(anchor.textAnchor).toBe('start');
    expect(anchor.x).toBeGreaterThan(200);
    expect(anchor.x + LABEL_WIDTH).toBeLessThanOrEqual(PLOT.right);
  });

  /*
   * The case that shipped clipped. In the 7-day window the horizon lands seven
   * eighths across the plot, and a start-anchored label ran past the right edge
   * of the canvas — the reader saw "forecast hori…".
   */
  it('flips to the left of the rule rather than run off the right edge', () => {
    const anchor = horizonLabelAnchor({ ruleX: 420, labelWidth: LABEL_WIDTH, plot: PLOT });

    expect(anchor.textAnchor).toBe('end');
    expect(anchor.x).toBeLessThan(420);
    expect(anchor.x - LABEL_WIDTH).toBeGreaterThanOrEqual(PLOT.left);
  });

  it('keeps the whole label inside the plot at every position the rule can take', () => {
    for (let ruleX = PLOT.left; ruleX <= PLOT.right; ruleX += 1) {
      const anchor = horizonLabelAnchor({ ruleX, labelWidth: LABEL_WIDTH, plot: PLOT });
      const leftEdge = anchor.textAnchor === 'start' ? anchor.x : anchor.x - LABEL_WIDTH;

      expect(leftEdge).toBeGreaterThanOrEqual(PLOT.left);
      expect(leftEdge + LABEL_WIDTH).toBeLessThanOrEqual(PLOT.right);
    }
  });

  it('pins the label to the left plot edge when it fits on neither side', () => {
    const overwide = PLOT.right - PLOT.left + 1;
    const anchor = horizonLabelAnchor({ ruleX: 430, labelWidth: overwide, plot: PLOT });

    expect(anchor.textAnchor).toBe('end');
    expect(anchor.x - overwide).toBe(PLOT.left);
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
