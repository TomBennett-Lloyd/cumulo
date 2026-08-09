// @vitest-environment jsdom

import { act, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHART_PLOT } from './ForecastChart';
import {
  attributeNumber,
  bare,
  clientXFor,
  isoHour,
  renderChart,
  renderChartWithOverlay,
  requireMark,
  requireSvg,
  requireTooltipPart,
  SERIES,
  stubRenderedSize,
  tooltipAnchor,
  tooltipText,
  tooltipValues,
} from './forecast-chart-test-fixture';
import {
  TOOLTIP_MIN_WIDTH,
  TOOLTIP_PADDING,
  TOOLTIP_ROW_HEIGHT,
  tooltipPanelHeight,
  tooltipPanelWidth,
  type TooltipRow,
} from './tooltip-geometry';
// Erased at compile time, so naming the module here creates no import cycle
// with the mock below — it only gives `importOriginal` a type to answer with.
import type * as TooltipGeometry from './tooltip-geometry';

/**
 * The drawn tooltip's shape and its motion — #284 D6 and D7. Separate from
 * `forecast-chart-hover.test.tsx`, which proves which *sample* a pointer or a
 * keystroke selects; this file proves what the panel then looks like and how it
 * moves (`structure.md` rule 4).
 *
 * The render probe below is the reason these live in a file of their own. D7's
 * claim is that moving the panel does not re-render its content, and "did not
 * re-render" is not visible in the DOM: React diffs against the previous
 * element tree, so a component that re-renders to the same output touches
 * nothing a test could read back. So the count is taken at a module seam
 * instead. `tooltipPanelHeight` is called once per content render and by
 * nothing else — the layer that positions the panel needs its width, never its
 * height — so wrapping that one export in a counter counts content renders
 * exactly, with the real implementation still doing the work underneath.
 */

const probe = vi.hoisted(() => ({ contentRenders: 0 }));

vi.mock('./tooltip-geometry', async (importOriginal) => {
  const actual = await importOriginal<typeof TooltipGeometry>();
  return {
    ...actual,
    tooltipPanelHeight: (visibleRowCount: number): number => {
      probe.contentRenders += 1;
      return actual.tooltipPanelHeight(visibleRowCount);
    },
  };
});

// Vitest runs without global test hooks, so Testing Library's automatic cleanup
// never registers itself.
afterEach(cleanup);

/**
 * A row as the sizer sees one. Built here rather than taken from the producer,
 * so the width assertions state the words they expect the panel to be holding
 * instead of re-running the component's own call on the component's own rows.
 */
const sizedRow = (value: string, name: string): TooltipRow => ({
  seriesClassName: 'forecast-chart-median',
  value,
  name,
  present: true,
});

const panelAttribute = (container: HTMLElement, name: string): number =>
  attributeNumber(requireTooltipPart(container, '.forecast-chart-tooltip-panel'), name);

/** The centre line of each drawn series row, in the tooltip group's own space. */
const rowCentreLines = (container: HTMLElement): readonly number[] =>
  [...container.querySelectorAll('.forecast-chart-tooltip g line')].map((line) =>
    attributeNumber(line, 'y1'),
  );

describe('ForecastChart tooltip shape', () => {
  it('omits the Actual row from the drawn tooltip for an unmeasured hour', () => {
    const container = renderChart(SERIES);
    const svg = requireSvg(container);
    const measuredKeys = (): readonly Element[] => [
      ...container.querySelectorAll('.forecast-chart-tooltip .forecast-chart-actuals'),
    ];
    act(() => {
      svg.focus();
    });

    // Positive control, in this test rather than in a sibling: a measured hour
    // draws the row and its key stroke, so the absence asserted below is the
    // chart dropping a row rather than a selector that never matched.
    expect(measuredKeys()).toHaveLength(1);
    expect(tooltipText(container)).toContain('Actual');

    // SERIES[4] is past the horizon: forecast, no measurement.
    fireEvent.keyDown(svg, { key: 'End' });

    // Drawn and spoken now agree. The em dash the row used to carry showed a
    // reader nothing and said nothing at all to a screen reader (#284 D6).
    expect(measuredKeys()).toHaveLength(0);
    expect(tooltipText(container)).not.toContain('Actual');
    expect(tooltipValues(container)).toStrictEqual(['2.0', '1.0–3.0']);
  });

  it('sizes the panel to its widest row and never below the minimum width', () => {
    // 30 characters of site name — free text a visitor typed, which is exactly
    // the row a fixed panel width clipped and nobody could have sized for.
    const longLabel = 'Sunnyside Farm community array';
    const container = renderChartWithOverlay(SERIES, {
      label: longLabel,
      points: [{ validTimeIso: isoHour(6), kw: 2.5 }],
    });
    act(() => {
      requireSvg(container).focus();
    });

    const width = panelAttribute(container, 'width');
    expect(width).toBe(
      tooltipPanelWidth('06:00', [
        sizedRow('0.9', 'Actual'),
        sizedRow('1.0', 'Median'),
        sizedRow('0.0–2.0', 'P10–P90'),
        sizedRow('2.5', longLabel),
      ]),
    );
    expect(width).toBeGreaterThan(TOOLTIP_MIN_WIDTH);

    // The floor still binds where the content falls under it: a point estimate
    // with two short rows would otherwise draw a noticeably smaller panel.
    const narrow = renderChart([bare(6, 1, 0.9)]);
    act(() => {
      requireSvg(narrow).focus();
    });
    expect(panelAttribute(narrow, 'width')).toBe(TOOLTIP_MIN_WIDTH);
  });

  it('pads the panel equally above the time and below the last visible row', () => {
    const container = renderChart(SERIES);
    const svg = requireSvg(container);
    act(() => {
      svg.focus();
    });

    const timeY = attributeNumber(
      requireTooltipPart(container, '.forecast-chart-tooltip-time'),
      'y',
    );
    const rows = rowCentreLines(container);

    expect(timeY).toBe(TOOLTIP_PADDING + TOOLTIP_ROW_HEIGHT / 2);
    expect(rows).toHaveLength(3);
    expect(panelAttribute(container, 'height')).toBe(tooltipPanelHeight(rows.length));
    // Symmetry measured rather than restated: the air above the time label and
    // the air below the last row come out the same number.
    expect(panelAttribute(container, 'height') - (rows.at(-1) ?? Number.NaN)).toBe(timeY);

    // Height follows the *visible* rows, so an unmeasured hour draws a shorter
    // panel rather than one carrying a gap where a row used to be.
    const tallHeight = panelAttribute(container, 'height');
    fireEvent.keyDown(svg, { key: 'End' });

    expect(rowCentreLines(container)).toHaveLength(2);
    expect(panelAttribute(container, 'height')).toBe(tooltipPanelHeight(2));
    expect(panelAttribute(container, 'height')).toBeLessThan(tallHeight);
  });
});

/**
 * View-box positions inside sample 2's span. The five samples sit 101.5 units
 * apart from `CHART_PLOT.left`, so sample 2 is at 249 and the midpoint it shares
 * with sample 3 is at 299.75 — every value below but the last is on sample 2's
 * side of it, and the last is over the line.
 */
const ON_SAMPLE_2 = 249;
const NEAR_SAMPLE_2 = 270;
const STILL_SAMPLE_2 = 290;
const PAST_THE_MIDPOINT = 310;
/** Two waits, named against the 33 ms the panel is allowed one move in. */
const INSIDE_ONE_FRAME_MS = 10;
const PAST_ONE_FRAME_MS = 40;

describe('ForecastChart tooltip motion', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    probe.contentRenders = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-renders the tooltip content only when the snapped sample changes', () => {
    const container = renderChart(SERIES);
    stubRenderedSize(requireSvg(container));
    const target = requireMark(container, '.forecast-chart-pointer-target');
    const movePointerTo = (viewBoxX: number): void => {
      fireEvent.pointerMove(target, { clientX: clientXFor(viewBoxX) });
      act(() => {
        vi.advanceTimersByTime(PAST_ONE_FRAME_MS);
      });
    };

    movePointerTo(ON_SAMPLE_2);
    const openingAnchor = tooltipAnchor(container);
    expect(probe.contentRenders).toBe(1);

    movePointerTo(NEAR_SAMPLE_2);
    movePointerTo(STILL_SAMPLE_2);

    // The panel moved with the pointer, twice…
    expect(tooltipAnchor(container)).toBe(openingAnchor + (STILL_SAMPLE_2 - ON_SAMPLE_2));
    // …and nothing inside it was rebuilt to do it. The sample never changed, so
    // the rows never changed, so there was nothing to say a second time.
    expect(probe.contentRenders).toBe(1);
    expect(tooltipText(container)).toBe('12:005.9 Actual6.0 Median5.0–7.0 P10–P90');

    movePointerTo(PAST_THE_MIDPOINT);

    // Crossing the midpoint is the one thing that is a data change, and it
    // costs exactly one render of the content.
    expect(probe.contentRenders).toBe(2);
    expect(tooltipText(container)).toBe('15:005.0 Median4.0–6.0 P10–P90');
  });

  it('applies one pointer position per frame, and never drops the last one', () => {
    const container = renderChart(SERIES);
    stubRenderedSize(requireSvg(container));
    const target = requireMark(container, '.forecast-chart-pointer-target');

    fireEvent.pointerMove(target, { clientX: clientXFor(ON_SAMPLE_2) });
    const openingAnchor = tooltipAnchor(container);

    act(() => {
      vi.advanceTimersByTime(INSIDE_ONE_FRAME_MS);
    });
    fireEvent.pointerMove(target, { clientX: clientXFor(NEAR_SAMPLE_2) });

    // Inside the frame the second move is held rather than drawn: a pointer
    // fires far more often than thirty times a second, and every one of those
    // events would otherwise be a commit.
    expect(tooltipAnchor(container)).toBe(openingAnchor);

    act(() => {
      vi.advanceTimersByTime(PAST_ONE_FRAME_MS);
    });

    // And the held move is never dropped. A pointer that stopped inside the
    // frame sends nothing more, so a throttle without this trailing flush
    // leaves the panel short of where the reader parked the cursor.
    expect(tooltipAnchor(container)).toBe(openingAnchor + (NEAR_SAMPLE_2 - ON_SAMPLE_2));
  });

  it('keeps the pointer-following panel inside the plot at the right-hand edge', () => {
    const container = renderChart(SERIES);
    stubRenderedSize(requireSvg(container));

    // Seven units short of the right plot edge: following the pointer here
    // would hang most of the panel off the canvas.
    fireEvent.pointerMove(requireMark(container, '.forecast-chart-pointer-target'), {
      clientX: clientXFor(CHART_PLOT.right - 7),
    });

    const anchor = tooltipAnchor(container);
    expect(anchor).toBeGreaterThanOrEqual(CHART_PLOT.left);
    expect(anchor + panelAttribute(container, 'width')).toBeLessThanOrEqual(CHART_PLOT.right);
  });
});
