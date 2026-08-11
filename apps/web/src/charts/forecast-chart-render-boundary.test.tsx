// @vitest-environment jsdom

import { act, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clientXFor,
  JSDOM_PLOT,
  isoHour,
  renderChartWithOverlay,
  requireMark,
  requireSvg,
  SERIES,
  stubRenderedSize,
  tooltipAnchor,
  tooltipText,
} from './forecast-chart-test-fixture';
// Erased at compile time, so naming these modules here creates no import cycle
// with the mocks below — they only give `importOriginal` a type to answer with.
import type * as ForecastChartMarks from './forecast-chart-marks';
import type * as ForecastChartTable from './forecast-chart-table';

/**
 * Where the chart's hover boundary sits — #331.
 *
 * Moving the tooltip panel is a change to one `transform`, and everything else
 * on the figure is the same drawing it was a frame ago. This file is the
 * measurement that says so in numbers: it counts how many times the figure's
 * *non-hover* producers run while a pointer sweeps the plot, and asserts that
 * number does not grow with the sweep.
 *
 * "Did not re-run" is invisible in the DOM — React diffs against the previous
 * element tree, so a producer re-run to the same output touches nothing a test
 * could read back (the same problem `forecast-chart-tooltip.test.tsx` solves,
 * one layer in: that file counts the panel's *content* renders, this one counts
 * the whole figure around it). So the count is taken at a module seam instead,
 * with the real implementations still doing the work underneath.
 *
 * **One counter covers the marks.** All five mark generators are called from
 * the one `ForecastChart` body, so wrapping `medianElements` alone counts that
 * body's runs — a second mark counter would only ever repeat this one.
 *
 * **The legend left the census on 2026-08-11, and leaving is the only honest way
 * it could go.** #429 moved it behind the fleet panel's (i), so `ForecastChart`
 * does not call `forecastChartLegend` at all and this figure has no such
 * producer to count. Keeping the counter would have parked it at zero through
 * every case — which is exactly the reading the second control below exists to
 * refuse, since an unwired probe and an absent producer are indistinguishable at
 * zero. So the module mock went with the field, and the two counters left both
 * settle at one. What re-renders the legend is now a question about
 * `FleetPanel`, and `FleetPanel.memo.test.tsx` is where that lives.
 *
 * Every case's load-bearing claim is relative (`FleetPanel.memo.test.tsx`'s
 * discipline): each settles the chart on a sample, snapshots the counters, and
 * compares what the rest of the case adds. That comparison is a probe against a
 * snapshot of itself, so it needs two controls to mean anything — `{0,0}`
 * equals `{0,0}`. `tooltipAnchor` and `tooltipText` prove the frames really
 * committed, so a chart that stopped rendering after the first move cannot pass.
 * The second control is the one absolute reading in the file: `settledCounts`
 * pins the snapshot to `SETTLED_COUNTS`, so a probe wired to nothing cannot pass
 * either. It is a wiring check rather than a claim about the boundary, which is
 * why an absolute count is the right instrument for it and the wrong one for
 * everything else here.
 */

interface ProducerCounts {
  table: number;
  marks: number;
}

const probe = vi.hoisted((): ProducerCounts => ({ table: 0, marks: 0 }));

/**
 * One producer, wrapped in a call counter. Hoisted alongside `probe` because
 * `vi.mock` factories are lifted above the imports and can reach nothing else.
 */
const counting = vi.hoisted(
  () =>
    <Args extends readonly unknown[], Result>(
      producer: keyof ProducerCounts,
      implementation: (...args: Args) => Result,
    ): ((...args: Args) => Result) =>
    (...args: Args): Result => {
      probe[producer] += 1;
      return implementation(...args);
    },
);

vi.mock('./forecast-chart-table', async (importOriginal) => {
  const actual = await importOriginal<typeof ForecastChartTable>();
  return { ...actual, forecastChartTable: counting('table', actual.forecastChartTable) };
});

vi.mock('./forecast-chart-marks', async (importOriginal) => {
  const actual = await importOriginal<typeof ForecastChartMarks>();
  return { ...actual, medianElements: counting('marks', actual.medianElements) };
});

// Vitest runs without global test hooks, so Testing Library's automatic cleanup
// never registers itself.
afterEach(cleanup);

/**
 * The gap between two samples in view-box units, derived rather than copied:
 * the plot is the component's own arithmetic at the width jsdom draws at.
 */
const SAMPLE_SPACING = (JSDOM_PLOT.right - JSDOM_PLOT.left) / (SERIES.length - 1);

const sampleX = (index: number): number => JSDOM_PLOT.left + index * SAMPLE_SPACING;

/**
 * A sixth of that gap. Two steps from a sample still sit inside its half-span —
 * three would land exactly on the midpoint it shares with its neighbour — and
 * four steps are over the line, so the same step both sweeps within one sample
 * and crosses to the next.
 */
const SWEEP_STEP = SAMPLE_SPACING / 6;
const STEPS_WITHIN_SPAN = 2;
const STEPS_PAST_MIDPOINT = 4;

/**
 * A wait past `POINTER_FRAME_MS` — the frame the panel is allowed one move in
 * (`chart-hover-input.ts`, whose restatement ledger names this file). Derived
 * from it, so it moves if that value moves.
 */
const PAST_ONE_FRAME_MS = 40;

/** Short enough that the panel it widens still sits well inside the plot. */
const OVERLAY_LABEL = 'Sunnyside Farm';

/**
 * Through the overlay path deliberately: an overlay puts a column in the table
 * and a mark on the plot, so both counted producers are doing the fuller job the
 * sweep is supposed to leave alone.
 */
const renderOverlaidChart = (): HTMLElement => {
  const container = renderChartWithOverlay(SERIES, {
    label: OVERLAY_LABEL,
    points: [
      { validTimeIso: isoHour(12), kw: 3.3 },
      { validTimeIso: isoHour(15), kw: 2.2 },
    ],
  });
  // jsdom lays everything out at zero, so the hover layer has nothing to divide
  // a client x by until this stub gives the svg a rendered box.
  stubRenderedSize(requireSvg(container));
  return container;
};

/** Fires one pointer move and lets exactly one frame commit it. */
const movePointerTo = (container: HTMLElement, viewBoxX: number): void => {
  fireEvent.pointerMove(requireMark(container, '.forecast-chart-pointer-target'), {
    clientX: clientXFor(viewBoxX),
  });
  act(() => {
    vi.advanceTimersByTime(PAST_ONE_FRAME_MS);
  });
};

/** What sample 2 and sample 3 say, so a changed readout is a named change. */
const SAMPLE_2_TEXT = `12:00Actual5.9Median6.0P10–P905.0–7.0${OVERLAY_LABEL}3.3`;
const SAMPLE_3_TEXT = `15:00Actual—Median5.0P10–P904.0–6.0${OVERLAY_LABEL}2.2`;

/**
 * What the probe reads once the chart has settled on a sample: one run of each
 * producer, and identical in all three cases below — the figure is built once
 * at mount, and neither the first pointer frame nor the focus that opens the
 * readout adds a second.
 */
const SETTLED_COUNTS: ProducerCounts = { table: 1, marks: 1 };

/**
 * The settled snapshot, and the assertion that it is a reading rather than an
 * absence. Every case ends by comparing the probe against this snapshot of
 * itself, and `{0,0,0}` equals `{0,0,0}`: if a `vi.mock` factory ever stopped
 * intercepting — `medianElements` renamed, a producer moved to another module,
 * `ForecastChart` composing differently — an unwired probe would sit at zero
 * throughout and every case would pass having measured nothing. Naming the
 * settled values is what makes that failure loud, so the check belongs here
 * rather than in one case that happens to remember it.
 */
const settledCounts = (): ProducerCounts => {
  const settled = { ...probe };
  expect(settled).toStrictEqual(SETTLED_COUNTS);
  return settled;
};

describe('ForecastChart render boundary', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    probe.table = 0;
    probe.marks = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('moves the panel across pointer frames without re-running the marks or the table', () => {
    const container = renderOverlaidChart();

    movePointerTo(container, sampleX(2));
    const settled = settledCounts();
    const openingAnchor = tooltipAnchor(container);

    for (let step = 1; step <= STEPS_WITHIN_SPAN; step += 1) {
      movePointerTo(container, sampleX(2) + step * SWEEP_STEP);
    }

    /*
     * The panel really did travel — two more frames committed, each landing the
     * pointer somewhere new. Without this the counts below would hold just as
     * well for a chart that stopped responding after the first move.
     *
     * To a tolerance rather than exactly, and #430 is what made that necessary:
     * the plot is 560 units wide now rather than 552, so `SWEEP_STEP` is a sixth
     * of 140 and no longer terminates in binary. The pointer reaches this
     * position by adding that step twice through a client-x round trip while the
     * expectation multiplies it by two, and the two disagree in the last bits.
     * Six decimal places is orders finer than the pixel these units become, and
     * orders coarser than the travel a frozen panel would be short by.
     */
    expect(tooltipAnchor(container)).toBeCloseTo(openingAnchor + STEPS_WITHIN_SPAN * SWEEP_STEP, 6);
    // And the data stayed put, which is the half of "the panel follows the
    // pointer; the data snaps" that makes those frames pure movement.
    expect(tooltipText(container)).toBe(SAMPLE_2_TEXT);

    // So nothing outside the panel had anything new to say. On the pre-#331
    // boundary each of those frames re-ran the whole figure to move one
    // `transform` — five mark generators and every table row.
    expect(probe).toStrictEqual(settled);
  });

  it('changes the snapped sample without re-running them either', () => {
    const container = renderOverlaidChart();

    movePointerTo(container, sampleX(2));
    const settled = settledCounts();
    expect(tooltipText(container)).toBe(SAMPLE_2_TEXT);

    movePointerTo(container, sampleX(2) + STEPS_PAST_MIDPOINT * SWEEP_STEP);

    // The frame crossed the midpoint and the readout snapped to the next
    // sample: a real selection change, not just a moved panel.
    expect(tooltipText(container)).toBe(SAMPLE_3_TEXT);

    // Which is still only the hover layer's business. The marks and the table
    // are drawn from `points`, and `points` did not change.
    expect(probe).toStrictEqual(settled);
  });

  it('steps the keyboard selection without re-running them', () => {
    const container = renderOverlaidChart();
    const svg = requireSvg(container);

    act(() => {
      svg.focus();
    });
    const settled = settledCounts();
    const openingText = tooltipText(container);

    fireEvent.keyDown(svg, { key: 'End' });

    // The keystroke landed: focus opens on the first sample and End jumps to the
    // last, so the readout is showing a different hour than it was.
    expect(openingText).toContain('06:00');
    expect(tooltipText(container)).toContain('18:00');

    // The keyboard route reaches the same selection state the pointer does, so
    // it has to sit inside the same boundary — otherwise every arrow key redraws
    // the figure that a pointer frame no longer does.
    expect(probe).toStrictEqual(settled);
  });
});
