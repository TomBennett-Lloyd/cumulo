// @vitest-environment jsdom

import { act, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attributeNumber,
  clientXFor,
  JSDOM_PLOT,
  renderChart,
  requireMark,
  requireSvg,
  requireTooltipPart,
  SERIES,
  stubRenderedSize,
  tooltipAnchor,
  tooltipText,
  xOfSample,
} from './forecast-chart-test-fixture';
import { DEFAULT_CHART_WIDTH } from './use-chart-width';

/**
 * The touch contract — #421, as the owner amended it: the tap target is the
 * whole graph figure rather than the drawing inside it, selection is by x alone,
 * an x outside the plot reads the end of the range it is nearest, and a lifted
 * finger keeps what it revealed.
 *
 * Separate from `forecast-chart-hover.test.tsx`, which is where a pointer
 * selecting a sample is already proven, for the reason `structure.md` rule 4
 * gives: that file is ~22 code lines under the 300-line ceiling and these cases
 * are not that. The split is a ceiling talking rather than a claim that a tap is
 * a different subject — `forecast-chart-details.test.tsx` was cut off
 * `ForecastChart.test.tsx` on the same rule, and both import the shared fixture
 * so neither keeps a second set of coordinates.
 *
 * What is *not* here is anything a browser decides. Whether the `<svg>` really
 * receives a press over an unpainted axis gutter is hit-testing, and jsdom does
 * none — it dispatches at whatever element a test names. So these cases prove
 * that the handler on the figure reads, clamps and pins the way the contract
 * says; that the gutter reaches that handler at all is the browser lane's
 * (`testing.md` rule 10).
 */

// Vitest runs without global test hooks, so Testing Library's automatic cleanup
// never registers itself.
afterEach(cleanup);

/**
 * The hour the panel is reading, which is what says *which* sample an input
 * selected. Every SERIES sample is a distinct hour and the series spans under a
 * day, so the label is a bare `HH:mm` and identifies the sample on its own.
 *
 * Deliberately not the panel's whole flattened text: that string is
 * `forecast-chart-hover.test.tsx`'s subject and its `READOUT` table is that
 * suite's, and a second copy here would be a table both files had to change
 * together to stay meaningful (`structure.md` rule 7).
 */
const readoutTime = (container: HTMLElement): string | null =>
  container.querySelector('.forecast-chart-tooltip-time')?.textContent ?? null;

/** Where the crosshair is standing, which is the snapped half of the reading. */
const crosshairX = (container: HTMLElement): number =>
  attributeNumber(requireMark(container, '.forecast-chart-crosshair'), 'x1');

/** How wide the drawn panel is, read off the panel rather than re-measured. */
const panelWidth = (container: HTMLElement): number =>
  attributeNumber(requireTooltipPart(container, '.forecast-chart-tooltip-panel'), 'width');

/**
 * A finger pressing the figure at a view-box x. `pointerDown` and not a move: a
 * touch pointer produces no hover stream to be tracked, so the press is the
 * whole of the reading, and `pointerType` is stated on every event here because
 * jsdom defaults it to the empty string — which is neither of the two types the
 * component tells apart.
 */
const tapAt = (svg: SVGSVGElement, viewBoxX: number): void => {
  fireEvent.pointerDown(svg, { clientX: clientXFor(viewBoxX), pointerType: 'touch' });
};

/**
 * That finger coming back off the glass, which is where a gesture ends and where
 * the chart takes the focus a standing reading is dismissed through
 * (`endGestureAtLift`). No coordinate, because a lift moves no reading;
 * `pointerType` for the reason `tapAt` states it.
 *
 * This suite keeps its own lift exactly as it keeps its own press:
 * `forecast-chart-focus-source.test.tsx` has the sibling of both, and the two
 * suites ask different questions of the same two events.
 */
const liftFrom = (svg: SVGSVGElement): void => {
  fireEvent.pointerUp(svg, { pointerType: 'touch' });
};

/** The chart, sized, with its figure ready to be pressed. */
const renderTappableChart = (): { container: HTMLElement; svg: SVGSVGElement } => {
  const container = renderChart(SERIES);
  const svg = requireSvg(container);
  stubRenderedSize(svg);
  return { container, svg };
};

describe('ForecastChart tap', () => {
  it('reads the sample under a tap, crosshair and all', () => {
    const { container, svg } = renderTappableChart();

    tapAt(svg, xOfSample(SERIES, 2));

    expect(readoutTime(container)).toBe('12:00');
    expect(tooltipText(container)).toContain('Median6.0');
    // Both halves of the reading, not just the panel: a tap is the pointer route
    // and the crosshair is what marks the sample it snapped to.
    expect(crosshairX(container)).toBe(xOfSample(SERIES, 2));
  });

  it('keeps what a lifted finger revealed', () => {
    const { container, svg } = renderTappableChart();
    tapAt(svg, xOfSample(SERIES, 2));

    // The pin. A finger leaving is the *end of the tap*, not a reader moving on,
    // so the readout the tap just opened has to survive it — otherwise no touch
    // reader could ever see one. A mouse leaving still clears
    // (`forecast-chart-hover.test.tsx`); dismissing a tap is the blur path's job.
    fireEvent.pointerLeave(svg, { pointerType: 'touch' });

    expect(readoutTime(container)).toBe('12:00');
    expect(crosshairX(container)).toBe(xOfSample(SERIES, 2));
  });

  it('drops the reading when the browser takes the gesture away', () => {
    const { container, svg } = renderTappableChart();
    tapAt(svg, xOfSample(SERIES, 2));
    expect(readoutTime(container)).toBe('12:00');

    /*
     * The other half of the pin, and the half a lift cannot answer for. A finger
     * lifting is the end of a tap — the reader asked and this is the answer — so
     * the case above requires the reading to survive it. A `pointercancel` is
     * the browser taking the gesture away mid-flight, which under
     * `touch-action: pan-y` is what a page scroll starting on the chart *is*:
     * the press already committed a reading, and nobody asked for it.
     *
     * Nothing else can dismiss that reading. The `pointerout`/`pointerleave`
     * that follow a cancel carry `pointerType: 'touch'`, which the mouse-only
     * clear ignores by design, and a cancel arrives *instead of* the lift, so the
     * focus a lift takes to keep a reading dismissable is never taken and #421's
     * blur route never fires. Without this the crosshair, the panel and the live
     * region stand until the reader taps the chart and then taps off it.
     */
    fireEvent.pointerCancel(svg, { pointerType: 'touch' });

    expect(readoutTime(container)).toBeNull();
    expect(container.querySelector('.forecast-chart-crosshair')).toBeNull();
  });

  it('clamps a tap in the left gutter to the start of the x range', () => {
    const { container, svg } = renderTappableChart();

    // 30 units left of the plot — in the y axis's gutter, which is target now
    // and is where a thumb aimed at the first hour of the day actually lands.
    tapAt(svg, JSDOM_PLOT.left - 30);

    expect(readoutTime(container)).toBe('06:00');
    expect(crosshairX(container)).toBe(xOfSample(SERIES, 0));
    // The clamp's own observable, and the reason it is not redundant with the
    // snap: `snapToNearestX` would answer sample 0 for a gutter x anyway, but
    // the *panel* follows the continuous position, and unclamped it anchors at
    // that x plus a gap — off the plot's left edge, half over the axis it is
    // reading nothing from.
    expect(tooltipAnchor(container)).toBeGreaterThanOrEqual(JSDOM_PLOT.left);
  });

  it('reads the last sample from a tap past the right-hand plot edge', () => {
    const { container, svg } = renderTappableChart();

    // Four units short of the canvas edge, which is inside the right margin the
    // last time-axis label straddles rather than inside the plot.
    tapAt(svg, DEFAULT_CHART_WIDTH - 4);

    expect(readoutTime(container)).toBe('18:00');
    expect(crosshairX(container)).toBe(xOfSample(SERIES, 4));
    // The clamp again, at the other end and on the flipped arm: the panel is
    // placed to the *left* of a pointer this near the edge, so an unclamped x
    // out in the right margin carries the whole panel out with it and the
    // readout's right edge leaves the plot it is reading.
    expect(tooltipAnchor(container) + panelWidth(container)).toBeLessThanOrEqual(JSDOM_PLOT.right);
  });

  it('leaves a tapped selection standing when the tap also focuses the chart', () => {
    const { container, svg } = renderTappableChart();

    tapAt(svg, xOfSample(SERIES, 2));
    // A tap on a `tabIndex={0}` element focuses it, and the focus arrives after
    // the press. The two compose only because `readAtFocus` opens the readout at
    // the first sample *when nothing is selected* — so this asserts the tap is
    // not overwritten a moment later by the chart's own keyboard entry point.
    act(() => {
      svg.focus();
    });

    expect(readoutTime(container)).toBe('12:00');
    expect(crosshairX(container)).toBe(xOfSample(SERIES, 2));
  });
});

/**
 * One frame of the panel's movement budget and then some — `POINTER_FRAME_MS` in
 * `chart-hover-input.ts`, which ledgers this constant beside it. The scrub's
 * second position arrives inside the frame the press opened, so it is held, and
 * this is the wait that lands it.
 */
const PAST_ONE_FRAME_MS = 40;

describe('ForecastChart touch scrub', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * The drag half of a scrub — the press is the caller's, because the two cases
   * below want different things asserted about it, and this is the portion they
   * share rather than the whole gesture (`structure.md` rule 7).
   *
   * The wait is not optional: the moved position arrives inside the frame the
   * press opened, so it is held, and the flush is what lands it.
   */
  const dragTo = (svg: SVGSVGElement, sampleIndex: number): void => {
    fireEvent.pointerMove(svg, {
      clientX: clientXFor(xOfSample(SERIES, sampleIndex)),
      pointerType: 'touch',
    });
    act(() => {
      vi.advanceTimersByTime(PAST_ONE_FRAME_MS);
    });
  };

  it('follows a finger dragged across the plot', () => {
    const { container, svg } = renderTappableChart();

    tapAt(svg, xOfSample(SERIES, 1));
    expect(readoutTime(container)).toBe('09:00');

    dragTo(svg, 3);

    // A drag is a scrub, not a second tap: the same handler reads the move, so a
    // finger held down and moved walks the readout along the series.
    expect(readoutTime(container)).toBe('15:00');
    expect(crosshairX(container)).toBe(xOfSample(SERIES, 3));
  });

  it('leaves a scrubbed reading dismissable by taking the focus at the lift', () => {
    const { container, svg } = renderTappableChart();

    tapAt(svg, xOfSample(SERIES, 1));
    dragTo(svg, 3);

    /*
     * The dismissal contract, on the one gesture that cannot inherit it. A drag
     * past the tap slop fires no `click`, so it takes none of the focus a tap
     * takes, and the browser has not claimed the gesture either — under
     * `touch-action: pan-y pinch-zoom` a horizontal drag is the chart's — so no
     * `pointercancel` withdraws the reading the way the case above this describe
     * relies on. The reading would stand with nothing able to take it away.
     */
    liftFrom(svg);

    expect(document.activeElement).toBe(svg);

    /*
     * And it kept what the finger revealed. The focus route opens the readout at
     * the first sample when nothing is selected, so a focus taken while a
     * selection stands must leave it alone — otherwise this dismissal costs the
     * reader the reading it was taken to protect, replacing hour 15:00 with hour
     * 06:00 the moment the finger comes up.
     */
    expect(readoutTime(container)).toBe('15:00');
    expect(crosshairX(container)).toBe(xOfSample(SERIES, 3));
  });

  it('takes no focus from a lift that left no reading standing', () => {
    const { container, svg } = renderTappableChart();

    /*
     * The other side of the guard, and what says the focus above is taken *for*
     * the reading rather than for every lift. Focusing unconditionally would run
     * the chart's keyboard entry point on the way out of a gesture that read
     * nothing, summoning a first-sample readout the reader never asked for — so
     * the absence of a crosshair is as much the assertion here as the absence of
     * the focus.
     */
    liftFrom(svg);

    expect(document.activeElement).not.toBe(svg);
    expect(container.querySelector('.forecast-chart-crosshair')).toBeNull();
  });
});
