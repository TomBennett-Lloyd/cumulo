// @vitest-environment jsdom

import { act, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attributeNumber,
  bare,
  clientXFor,
  JSDOM_PLOT,
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
  TOOLTIP_CHAR_WIDTH,
  TOOLTIP_MIN_WIDTH,
  TOOLTIP_PADDING,
  TOOLTIP_ROW_HEIGHT,
  tooltipColumns,
  tooltipPanelHeight,
  tooltipPanelWidth,
  type TooltipRow,
} from './tooltip-geometry';
// Erased at compile time, so naming the module here creates no import cycle
// with the mock below — it only gives `importOriginal` a type to answer with.
import type * as TooltipGeometry from './tooltip-geometry';

/**
 * The drawn tooltip's shape and its motion — #284 D6 as #330 left it, and D7.
 * Separate from `forecast-chart-hover.test.tsx`, which proves which *sample* a
 * pointer or a keystroke selects; this file proves what the panel then looks
 * like and how it moves (`structure.md` rule 4).
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
    tooltipPanelHeight: (drawnRowCount: number): number => {
      probe.contentRenders += 1;
      return actual.tooltipPanelHeight(drawnRowCount);
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

/** The ceiling `tooltipPanelWidth` is capped at: the plot the panel floats over. */
const PLOT_WIDTH = JSDOM_PLOT.right - JSDOM_PLOT.left;

/** The centre line of each drawn series row, in the tooltip group's own space. */
const rowCentreLines = (container: HTMLElement): readonly number[] =>
  [...container.querySelectorAll('.forecast-chart-tooltip g line')].map((line) =>
    attributeNumber(line, 'y1'),
  );

/** One column's texts, in document order — the rows top to bottom. */
const column = (container: HTMLElement, columnClass: string): readonly Element[] => [
  ...container.querySelectorAll(`.forecast-chart-tooltip .${columnClass}`),
];

describe('ForecastChart tooltip shape', () => {
  it('dashes the Actual row for an unmeasured hour, and only there', () => {
    const container = renderChart(SERIES);
    const svg = requireSvg(container);
    const measuredKeys = (): readonly Element[] => [
      ...container.querySelectorAll('.forecast-chart-tooltip .forecast-chart-actuals'),
    ];
    act(() => {
      svg.focus();
    });

    // Control, in this test rather than in a sibling: a measured hour draws
    // every value as a number, so the em dash asserted below is this chart
    // marking one hour's absence rather than a panel that dashes everything.
    expect(measuredKeys()).toHaveLength(1);
    expect(tooltipValues(container)).toStrictEqual(['0.9', '1.0', '0.0–2.0']);

    // SERIES[4] is past the horizon: forecast, no measurement.
    fireEvent.keyDown(svg, { key: 'End' });

    // The row stays and carries `formatKw`'s em dash — missing data reads as
    // missing (`design.md` rule 5, owner 2026-08-10 / #330), and the series a
    // reader was reading a moment ago does not leave the panel under them.
    expect(measuredKeys()).toHaveLength(1);
    expect(tooltipText(container)).toContain('Actual');
    expect(tooltipValues(container)).toStrictEqual(['—', '2.0', '1.0–3.0']);
  });

  it('lays the rows out in name and value columns', () => {
    // 30 characters of site name, so the name column is decided by a row nobody
    // could have sized for — free text a visitor typed.
    const longLabel = 'Sunnyside Farm community array';
    const rows = [
      sizedRow('0.9', 'Actual'),
      sizedRow('1.0', 'Median'),
      sizedRow('0.0–2.0', 'P10–P90'),
      sizedRow('2.5', longLabel),
    ];
    const container = renderChartWithOverlay(SERIES, {
      label: longLabel,
      points: [{ validTimeIso: isoHour(6), kw: 2.5 }],
    });
    act(() => {
      requireSvg(container).focus();
    });

    const columns = tooltipColumns(rows, PLOT_WIDTH);

    // The panel really is holding the words the columns above were measured
    // over — otherwise the x assertions would be comparing a model of one set
    // of rows against a drawing of another.
    expect(
      column(container, 'forecast-chart-tooltip-name').map((text) => text.textContent),
    ).toEqual(rows.map((row) => row.name));
    expect(
      column(container, 'forecast-chart-tooltip-value').map((text) => text.textContent),
    ).toEqual(rows.map((row) => row.value));

    // One x per column, asserted as one per row: this says both that each text
    // sits at the column's x and that all four share it. Per-row packing —
    // every value starting where its own name ended — fails on the second row.
    expect(
      column(container, 'forecast-chart-tooltip-name').map((text) => attributeNumber(text, 'x')),
    ).toStrictEqual(rows.map(() => columns.nameX));
    expect(
      column(container, 'forecast-chart-tooltip-value').map((text) => attributeNumber(text, 'x')),
    ).toStrictEqual(rows.map(() => columns.valueX));

    // And the second column clears the *longest* name rather than any one row's,
    // which is what makes it a column: collapse it onto the first and the
    // numbers land on top of the names they belong to.
    expect(columns.valueX).toBeGreaterThan(columns.nameX + longLabel.length * TOOLTIP_CHAR_WIDTH);

    // The panel is what the two columns asked for, not the floor or the cap.
    expect(panelAttribute(container, 'width')).toBe(tooltipPanelWidth('06:00', rows, PLOT_WIDTH));
    expect(panelAttribute(container, 'width')).toBe(columns.panelContentWidth);
  });

  it('sizes the panel to the widest of each column and never below the minimum width', () => {
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
      tooltipPanelWidth(
        '06:00',
        [
          sizedRow('0.9', 'Actual'),
          sizedRow('1.0', 'Median'),
          sizedRow('0.0–2.0', 'P10–P90'),
          sizedRow('2.5', longLabel),
        ],
        PLOT_WIDTH,
      ),
    );
    expect(width).toBeGreaterThan(TOOLTIP_MIN_WIDTH);
    // Sized by its content and not by the ceiling — otherwise the assertion
    // above would hold for a panel that had simply been clamped.
    expect(width).toBeLessThan(PLOT_WIDTH);

    // The floor still binds where the content falls under it: a point estimate
    // with two short rows would otherwise draw a noticeably smaller panel.
    const narrow = renderChart([bare(6, 1, 0.9)]);
    act(() => {
      requireSvg(narrow).focus();
    });
    expect(panelAttribute(narrow, 'width')).toBe(TOOLTIP_MIN_WIDTH);
  });

  it('caps the panel at the plot width rather than blanket the chart with a long name', () => {
    // The longest name `siteSchema` accepts (`packages/shared/src/site.ts`:
    // `.min(1).max(120)`) — free text a visitor types, so this is a shape the
    // product can really be handed rather than a stress value invented here.
    const longestAllowedLabel = 'S'.repeat(120);
    const container = renderChartWithOverlay(SERIES, {
      label: longestAllowedLabel,
      points: [{ validTimeIso: isoHour(6), kw: 2.5 }],
    });
    act(() => {
      requireSvg(container).focus();
    });

    // What the content asks for, taken from the sizer itself under a ceiling
    // that cannot bind: around twice the plot's width. Without the cap the
    // readout would cover the marks it exists to explain, and the anchor could
    // only pin it left and let the rest hang off the canvas — so this is the
    // number the assertion below proves is not what gets drawn.
    expect(
      tooltipPanelWidth('06:00', [sizedRow('2.5', longestAllowedLabel)], Number.POSITIVE_INFINITY),
    ).toBeGreaterThan(PLOT_WIDTH);

    expect(panelAttribute(container, 'width')).toBe(PLOT_WIDTH);
    // Which puts the whole panel inside the plot, at both edges. The text still
    // overflows its own panel: columns were the half of #284 D12 that landed,
    // and no two columns fit 120 characters into a panel narrower than they
    // are — eliding the name is the half still open. One row spilling past an
    // edge is the bounded failure this cap chooses over the other one.
    expect(tooltipAnchor(container)).toBeGreaterThanOrEqual(JSDOM_PLOT.left);
    expect(tooltipAnchor(container) + PLOT_WIDTH).toBeLessThanOrEqual(JSDOM_PLOT.right);
  });

  it('keeps the value column inside the capped panel and lets the name overflow', () => {
    // The same schema-ceiling name as the cap test above, because the cap
    // binding is the precondition for anything here being about the clamp.
    const longestAllowedLabel = 'S'.repeat(120);
    const rows = [
      sizedRow('0.9', 'Actual'),
      sizedRow('1.0', 'Median'),
      sizedRow('0.0–2.0', 'P10–P90'),
      sizedRow('2.5', longestAllowedLabel),
    ];
    const container = renderChartWithOverlay(SERIES, {
      label: longestAllowedLabel,
      points: [{ validTimeIso: isoHour(6), kw: 2.5 }],
    });
    act(() => {
      requireSvg(container).focus();
    });

    const panelWidth = tooltipPanelWidth('06:00', rows, PLOT_WIDTH);
    const columns = tooltipColumns(rows, PLOT_WIDTH);
    const widestValueWidth = Math.max(...rows.map((row) => row.value.length)) * TOOLTIP_CHAR_WIDTH;

    // Precondition, asserted rather than assumed: the panel is at the ceiling,
    // so the name column cannot have all the width it asked for.
    expect(panelWidth).toBe(PLOT_WIDTH);

    // The value column — its ink, not just its left edge — is inside the panel.
    // Measured against the *widest* value, so this holds for every row at once.
    expect(columns.valueX + widestValueWidth).toBeLessThanOrEqual(panelWidth);

    // And as drawn, in the plot's own coordinates: the panel is translated to
    // an anchor, so a value column inside the panel is only worth anything if
    // the panel it is inside is on the canvas.
    const anchor = tooltipAnchor(container);
    const values = column(container, 'forecast-chart-tooltip-value');
    expect(values).toHaveLength(rows.length);
    for (const value of values) {
      expect(attributeNumber(value, 'x')).toBe(columns.valueX);
      expect(anchor + attributeNumber(value, 'x') + widestValueWidth).toBeLessThanOrEqual(
        JSDOM_PLOT.right,
      );
    }

    // The name is what gives way — which is the arrangement the pre-column
    // layout had, and what the cap's own docblock claims. Unclamped, the name
    // column takes the width it asks for and pushes the whole value column off
    // the panel: the numbers a reader came for would be the half that vanished.
    expect(columns.nameX + longestAllowedLabel.length * TOOLTIP_CHAR_WIDTH).toBeGreaterThan(
      panelWidth,
    );
  });

  it('pads the panel equally above the time and below the last row, at a height that holds still', () => {
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

    // And the height is a fact about the chart, not about the sample: every
    // series the chart carries has a row at every hour, so an unmeasured hour
    // dashes its cell instead of shortening the panel under a reader who is
    // moving along the series (`design.md` rule 6, #330).
    const openingHeight = panelAttribute(container, 'height');
    fireEvent.keyDown(svg, { key: 'End' });

    expect(rowCentreLines(container)).toHaveLength(3);
    expect(panelAttribute(container, 'height')).toBe(openingHeight);
  });
});

/**
 * View-box positions inside sample 2's span. The five samples sit 138 units
 * apart from `JSDOM_PLOT.left` (56, since #284 D10 widened the left gutter), so
 * sample 2 is at 332 and the midpoint it shares with sample 3 is at 401 — every
 * value below but the last is on sample 2's side of it, and the last is over
 * the line by 4 units.
 */
const ON_SAMPLE_2 = 332;
const NEAR_SAMPLE_2 = 355;
/** 16 units short of the midpoint: still sample 2's, and visibly moved. */
const STILL_SAMPLE_2 = 385;
const PAST_THE_MIDPOINT = 405;
/**
 * Two waits, chosen to fall either side of `POINTER_FRAME_MS` — the frame the
 * panel is allowed one move in (`chart-hover-input.ts`, which ledgers these two
 * beside the constant). Both are derived from it, so both move if it does.
 */
const INSIDE_ONE_FRAME_MS = 10;
const PAST_ONE_FRAME_MS = 40;
/** Short enough that the panel it widens still sits well inside the plot. */
const OVERLAY_LABEL = 'Sunnyside Farm';

describe('ForecastChart tooltip motion', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    probe.contentRenders = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /*
   * Through the overlay path deliberately, and it is the overlay that gives the
   * case its teeth.
   *
   * With no overlay every prop this panel is memoised on is a primitive or a
   * value taken straight from `points`, so the overlay reading the boundary
   * derives is `undefined` either way and the shallow compare passes whether or
   * not it is memoised — the case held while the memoisation it exists to prove
   * was deleted. An overlay makes that reading a real object, rebuilt every
   * frame unless something holds its identity: with the `useMemo` in
   * `ForecastChartHoverBoundary` removed, the three pointer moves below render
   * the content three times instead of once, which is the failure this case is
   * for.
   *
   * That memo is one of two this case fails on, and the other is the panel's
   * own. `ForecastChartHoverLayer` is not memoised, so it re-renders on every
   * committed frame; `memo(TooltipPanel)` is what keeps the content out of
   * those re-renders, and stripping it puts the three moves below at three
   * content renders instead of one — measured, not reasoned about.
   *
   * What #331 took *off* that list is worth knowing about here: the join the
   * reading is derived from is still a `useMemo`, but it stayed in
   * `ForecastChart` while the reading moved down, and `ForecastChart`'s body no
   * longer runs on a pointer frame. So the join keeps its identity across a
   * sweep whether or not it is memoised, and deleting that one leaves
   * everything here green. What it guards is a re-render arriving from above —
   * a new range, a new fleet — which nothing in this file drives.
   */
  it('re-renders the tooltip content only when the snapped sample changes', () => {
    const container = renderChartWithOverlay(SERIES, {
      label: OVERLAY_LABEL,
      points: [
        { validTimeIso: isoHour(12), kw: 3.3 },
        { validTimeIso: isoHour(15), kw: 2.2 },
      ],
    });
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
    expect(tooltipText(container)).toBe(`12:00Actual5.9Median6.0P10–P905.0–7.0${OVERLAY_LABEL}3.3`);

    movePointerTo(PAST_THE_MIDPOINT);

    // Crossing the midpoint is the one thing that is a data change, and it
    // costs exactly one render of the content.
    expect(probe.contentRenders).toBe(2);
    // Sample 3 is past the horizon, so its Actual cell is the em dash rather
    // than a row the panel drops (#330).
    expect(tooltipText(container)).toBe(`15:00Actual—Median5.0P10–P904.0–6.0${OVERLAY_LABEL}2.2`);
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
    // fires far more often than the panel is allowed to move, and every one of
    // those events would otherwise be a commit.
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
      clientX: clientXFor(JSDOM_PLOT.right - 7),
    });

    const anchor = tooltipAnchor(container);
    expect(anchor).toBeGreaterThanOrEqual(JSDOM_PLOT.left);
    expect(anchor + panelAttribute(container, 'width')).toBeLessThanOrEqual(JSDOM_PLOT.right);
  });
});
