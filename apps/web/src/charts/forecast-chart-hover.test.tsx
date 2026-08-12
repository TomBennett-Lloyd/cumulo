// @vitest-environment jsdom

import { act, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ForecastChartPoint } from './chart-series';
import { KEY_STROKE_LENGTH, TOOLTIP_PADDING } from './tooltip-geometry';
import {
  attributeNumber,
  banded,
  bare,
  clientXFor,
  JSDOM_PLOT,
  isoHour,
  renderChart,
  renderChartWithOverlay,
  requireMark,
  requireSvg,
  SERIES,
  marks,
  stubRenderedSize,
  tableCells,
  tooltipAnchor,
  tooltipText,
  tooltipValues,
  xOfSample,
} from './forecast-chart-test-fixture';

// Vitest runs without global test hooks, so Testing Library's automatic cleanup
// never registers itself.
afterEach(cleanup);

/** Client x that lands the pointer exactly on a sample of the rendered chart. */
const clientXForSample = (points: readonly ForecastChartPoint[], index: number): number =>
  clientXFor(xOfSample(points, index));

const hoverSample = (
  container: HTMLElement,
  points: readonly ForecastChartPoint[],
  index: number,
): void => {
  fireEvent.pointerMove(requireMark(container, '.forecast-chart-pointer-target'), {
    clientX: clientXForSample(points, index),
  });
};

/**
 * The readout for each sample of SERIES, as the tooltip's flattened text.
 *
 * Word-run rather than sentence since #284 D12: a row is a name text and a
 * value text side by side in their own columns, so flattening the panel butts
 * them together with no separator to insert. The time still leads.
 */
const READOUT: readonly string[] = [
  '06:00Actual0.9Median1.0P10–P900.0–2.0',
  '09:00Actual3.8Median4.0P10–P903.0–5.0',
  '12:00Actual5.9Median6.0P10–P905.0–7.0',
  // Past the horizon: the measured row stays and its cell is the em dash, so
  // the panel says the hour has no measurement rather than saying nothing
  // about it (#330).
  '15:00Actual—Median5.0P10–P904.0–6.0',
  '18:00Actual—Median2.0P10–P901.0–3.0',
];

/** One group per drawn series row, in the order the panel lists them. */
const tooltipRowGroups = (container: HTMLElement): readonly Element[] => [
  ...container.querySelectorAll('.forecast-chart-tooltip > g'),
];

/**
 * One element inside a row group. Throws rather than answering `null`, so a
 * selector that stops matching reads as the missing mark it is instead of
 * quietly comparing `NaN` against a coordinate.
 */
const requireIn = (group: Element | undefined, selector: string): Element => {
  const found = group?.querySelector(selector);
  if (found === null || found === undefined) {
    throw new Error(`no ${selector} in the tooltip row`);
  }
  return found;
};

/**
 * A row's centre line, read off its name text — one element per row, anchored
 * at the centre by `dominantBaseline="middle"`, and the one part of a row that
 * is the same shape whichever key the row wears.
 */
const rowCentre = (group: Element | undefined): number =>
  attributeNumber(requireIn(group, '.forecast-chart-tooltip-name'), 'y');

/**
 * Half of the band bound's 1-unit stroke (`charts.css`), which is how far
 * inside the wash's edge its centre line has to sit for the hairline to land on
 * the edge rather than half outside it.
 */
const HAIRLINE_INSET = 0.5;

describe('ForecastChart hover layer', () => {
  it('shows nothing until the chart is pointed at or focused', () => {
    const container = renderChart(SERIES);

    expect(marks(container, '.forecast-chart-crosshair')).toHaveLength(0);
    expect(tooltipText(container)).toBeNull();
  });

  it('opens the readout on the first sample when the chart takes focus', () => {
    const container = renderChart(SERIES);
    const svg = requireSvg(container);

    act(() => {
      svg.focus();
    });

    expect(tooltipText(container)).toBe(READOUT[0]);
  });

  it('steps one sample per arrow key, in the direction pressed', () => {
    const container = renderChart(SERIES);
    const svg = requireSvg(container);
    act(() => {
      svg.focus();
    });

    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(tooltipText(container)).toBe(READOUT[1]);

    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(tooltipText(container)).toBe(READOUT[2]);

    fireEvent.keyDown(svg, { key: 'ArrowLeft' });
    expect(tooltipText(container)).toBe(READOUT[1]);
  });

  it('jumps to the ends on End and Home and stays there when stepped past', () => {
    const container = renderChart(SERIES);
    const svg = requireSvg(container);
    act(() => {
      svg.focus();
    });

    fireEvent.keyDown(svg, { key: 'End' });
    expect(tooltipText(container)).toBe(READOUT[4]);

    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(tooltipText(container)).toBe(READOUT[4]);

    fireEvent.keyDown(svg, { key: 'Home' });
    expect(tooltipText(container)).toBe(READOUT[0]);

    fireEvent.keyDown(svg, { key: 'ArrowLeft' });
    expect(tooltipText(container)).toBe(READOUT[0]);
  });

  it('dismisses the readout on Escape and re-enters at the first sample', () => {
    const container = renderChart(SERIES);
    const svg = requireSvg(container);
    act(() => {
      svg.focus();
    });
    fireEvent.keyDown(svg, { key: 'End' });

    fireEvent.keyDown(svg, { key: 'Escape' });
    expect(tooltipText(container)).toBeNull();
    expect(marks(container, '.forecast-chart-crosshair')).toHaveLength(0);

    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(tooltipText(container)).toBe(READOUT[0]);
  });

  it('leaves keys the chart does not act on to the browser', () => {
    const container = renderChart(SERIES);
    const svg = requireSvg(container);
    act(() => {
      svg.focus();
    });

    const ignored = fireEvent.keyDown(svg, { key: 'a' });

    // `fireEvent` returns false when a handler called preventDefault: a chart
    // that swallowed unrelated keys would break Tab and page scrolling.
    expect(ignored).toBe(true);
    expect(tooltipText(container)).toBe(READOUT[0]);
  });

  it('clears the readout when the chart loses focus', () => {
    const container = renderChart(SERIES);
    const svg = requireSvg(container);
    act(() => {
      svg.focus();
    });

    act(() => {
      svg.blur();
    });

    expect(tooltipText(container)).toBeNull();
  });

  it('snaps the crosshair to the sample nearest the pointer', () => {
    const container = renderChart(SERIES);
    stubRenderedSize(requireSvg(container));

    hoverSample(container, SERIES, 2);
    const crosshair = requireMark(container, '.forecast-chart-crosshair');

    expect(crosshair.getAttribute('x1')).toBe(String(xOfSample(SERIES, 2)));
    expect(crosshair.getAttribute('x1')).toBe(crosshair.getAttribute('x2'));
    expect(tooltipText(container)).toBe(READOUT[2]);
  });

  it('snaps a pointer between two samples to the nearer one', () => {
    const container = renderChart(SERIES);
    stubRenderedSize(requireSvg(container));

    // A quarter of a step past sample 1 — nowhere near a drawn mark.
    fireEvent.pointerMove(requireMark(container, '.forecast-chart-pointer-target'), {
      clientX:
        clientXForSample(SERIES, 1) +
        (clientXForSample(SERIES, 2) - clientXForSample(SERIES, 1)) / 4,
    });

    expect(tooltipText(container)).toBe(READOUT[1]);
  });

  // A *mouse*, and the pointer type is the whole of what the guard reads: a
  // finger leaves at the end of every tap, so clearing on any pointer type
  // would undo a tap in the frame that made it (#421, `forecast-chart-tap.test.tsx`
  // holds the other side).
  it('clears the readout when a mouse leaves the figure', () => {
    const container = renderChart(SERIES);
    stubRenderedSize(requireSvg(container));
    hoverSample(container, SERIES, 2);

    fireEvent.pointerLeave(requireSvg(container), { pointerType: 'mouse' });

    expect(tooltipText(container)).toBeNull();
    expect(marks(container, '.forecast-chart-crosshair')).toHaveLength(0);
  });

  it('shows from the keyboard exactly what it shows from the pointer', () => {
    const container = renderChart(SERIES);
    const svg = requireSvg(container);
    stubRenderedSize(svg);

    hoverSample(container, SERIES, 2);
    const hovered = tooltipText(container);
    fireEvent.pointerLeave(svg, { pointerType: 'mouse' });

    act(() => {
      svg.focus();
    });
    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    fireEvent.keyDown(svg, { key: 'ArrowRight' });

    // Not merely "both non-empty": the two routes must render the same string,
    // which is what "keyboard focus shows exactly what hover shows" means.
    expect(hovered).toBe(READOUT[2]);
    expect(tooltipText(container)).toBe(hovered);
  });

  it('reads every tooltip value back out of the table twin', () => {
    const container = renderChart(SERIES);
    stubRenderedSize(requireSvg(container));
    hoverSample(container, SERIES, 2);

    const [measured, median, range] = tooltipValues(container);
    const [p10, tableMedian, p90, tableActual] = tableCells(container, 2);

    // Tooltips enhance, they never gate (chart-treatment.md): every number in
    // the readout is reachable without a pointer, in the row for the same hour.
    expect(measured).toBe(tableActual);
    expect(median).toBe(tableMedian);
    expect(range).toBe(`${String(p10)}–${String(p90)}`);
  });

  it('omits the range row when no hour on the chart is banded', () => {
    const container = renderChart([bare(6, 1, 0.9), bare(9, 4, 3.8)]);

    act(() => {
      requireSvg(container).focus();
    });

    // The chart never carried a band, so the panel has no such row to dash —
    // the same granularity the table twin's columns are gated at (#295), now
    // shared by both surfaces.
    expect(tooltipText(container)).toBe('06:00Actual0.9Median1.0');
    expect(tooltipValues(container)).toStrictEqual(['0.9', '1.0']);
  });

  it('dashes the range row on a banded chart’s bare hour', () => {
    const container = renderChart([banded(6, 1, 0.9), bare(9, 4, 3.8)]);
    const svg = requireSvg(container);
    act(() => {
      svg.focus();
    });

    fireEvent.keyDown(svg, { key: 'ArrowRight' });

    // This chart does carry a band, so an hour without one is an absence at
    // that hour rather than a quantity the series never had — and an absence
    // reads as the em dash (`design.md` rule 5, #330).
    expect(tooltipValues(container)).toStrictEqual(['3.8', '4.0', '—']);
  });

  it('keeps the tooltip inside the plot at the right-hand end of the series', () => {
    const container = renderChart(SERIES);
    const svg = requireSvg(container);
    act(() => {
      svg.focus();
    });

    fireEvent.keyDown(svg, { key: 'End' });

    expect(tooltipAnchor(container)).toBeGreaterThanOrEqual(JSDOM_PLOT.left);
    expect(tooltipAnchor(container)).toBeLessThan(xOfSample(SERIES, 4));
  });

  it('gives every tooltip row a key of its own when an overlay shares a row’s name', () => {
    /*
     * An overlay's name is a *site* name, which is free text a visitor types into
     * the add-site form — so "Median" is a name somebody can have, and keyed by
     * name that row shares a key with the forecast's own median row.
     *
     * What this asserts is React's warning, and the choice is worth explaining
     * because the obvious assertion does not work. Duplicate keys are a
     * *reconciliation* hazard: on the shapes this chart produces, React still
     * ends up rendering the right four rows with the right numbers, so a DOM
     * assertion here passes with the bug in place — it was written that way
     * first and did not bite. The warning is the only thing that observes the
     * defect today, and it is a real signal rather than a proxy: React is saying
     * children may be "duplicated and/or omitted", which is a promise about
     * future renders, not this one. Waiting for a row to actually vanish means
     * waiting for a React upgrade or a row set nobody has drawn yet.
     *
     * Spying rather than silencing: `LazyMapRegion.test.tsx` uses the same shape
     * for the same reason, and the assertion is on what was logged.
     */
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const container = renderChartWithOverlay([banded(6, 1, 0.9), bare(9, 4, 3.8)], {
      label: 'Median',
      points: [
        { validTimeIso: isoHour(6), kw: 7.5 },
        { validTimeIso: isoHour(9), kw: 8.5 },
      ],
    });
    const svg = requireSvg(container);

    act(() => {
      svg.focus();
    });
    // Stepping onto a point with no modelled uncertainty rewrites the band row
    // to an em dash and leaves every other row saying something new, which is
    // when keyed matching has to tell the two "Median" rows apart rather than
    // pairing them off by position.
    fireEvent.keyDown(svg, { key: 'ArrowRight' });

    const keyWarnings = logged.mock.calls
      .map((call) => call.map(String).join(' '))
      .filter((message) => /same key/iu.test(message));

    expect(keyWarnings).toEqual([]);
    // The rows the reader is owed are all still there, which is what the keys
    // are protecting. Asserted after the warning, because this is the assertion
    // that passes either way today.
    expect(tooltipValues(container)).toStrictEqual(['3.8', '4.0', '—', '8.5']);

    logged.mockRestore();
  });

  /*
   * The key each row wears, which is what the panel says about a series beyond
   * its name. Here rather than in `forecast-chart-tooltip.test.tsx`, whose
   * subject this is: that file is 23 code lines under the 300-line ceiling and
   * these two cases do not fit inside it (see the note this pair's width guard
   * carries there, which is the half that had to sit beside the other width
   * cases). The split is a ceiling talking, not a claim that a key is about
   * which sample got selected.
   */
  it('keys the range row with the band’s own swatch — the wash and its two bounds', () => {
    const container = renderChart(SERIES);
    act(() => {
      requireSvg(container).focus();
    });

    const range = tooltipRowGroups(container).at(-1);
    const wash = requireIn(range, 'rect.forecast-chart-band');
    const bounds = [...(range?.querySelectorAll('line.forecast-chart-band-bound') ?? [])];

    // The band's own ink under the band's own class names, so the key has one
    // owner with the mark it names: the wash, bounded top and bottom. That is
    // the legend swatch's treatment, and drawing it here is what leaves the
    // panel self-describing now that the legend sits behind the (i) (#429).
    expect(bounds).toHaveLength(2);

    const top = attributeNumber(wash, 'y');
    const height = attributeNumber(wash, 'height');

    // Centred on the row it keys, and inside the same gutter every line key
    // occupies — never wider, which is the constraint the width guard in
    // `forecast-chart-tooltip.test.tsx` holds from the other side.
    expect(top + height / 2).toBe(rowCentre(range));
    expect(attributeNumber(wash, 'x')).toBe(TOOLTIP_PADDING);
    expect(attributeNumber(wash, 'width')).toBe(KEY_STROKE_LENGTH);
    // The bounds are the wash's own edges rather than a second mark near it:
    // half a stroke inside each, so a hairline reads as the band's boundary
    // instead of hanging half outside the fill it bounds.
    expect(bounds.map((bound) => attributeNumber(bound, 'y1'))).toStrictEqual([
      top + HAIRLINE_INSET,
      top + height - HAIRLINE_INSET,
    ]);
  });

  it('keys every line series with one stroke and no swatch', () => {
    const container = renderChartWithOverlay(SERIES, {
      label: 'Sunnyside Farm',
      points: [{ validTimeIso: isoHour(6), kw: 2.5 }],
    });
    act(() => {
      requireSvg(container).focus();
    });

    // Actual, Median, P10–P90, overlay — naming the range row's position is
    // what keeps "every other row" a count rather than a hope.
    const groups = tooltipRowGroups(container);
    expect(groups).toHaveLength(4);

    for (const group of groups.filter((_, index) => index !== 2)) {
      const key = requireIn(group, 'line');
      expect(group.querySelectorAll('rect')).toHaveLength(0);
      expect(attributeNumber(key, 'x1')).toBe(TOOLTIP_PADDING);
      expect(attributeNumber(key, 'x2')).toBe(TOOLTIP_PADDING + KEY_STROKE_LENGTH);
      // Flat, on the row's own centre line: nothing of the band key's vertical
      // extent leaked into the rows that are still keyed by a stroke.
      expect(attributeNumber(key, 'y1')).toBe(rowCentre(group));
      expect(attributeNumber(key, 'y2')).toBe(rowCentre(group));
    }
  });

  it('positions the whole readout with SVG attributes and no inline style', () => {
    const container = renderChart(SERIES);
    stubRenderedSize(requireSvg(container));
    hoverSample(container, SERIES, 3);

    // Inline styles are a lint error in UI code (react.md rule 5); this is the
    // runtime half of that gate, over the one layer that computes positions.
    expect(container.querySelectorAll('[style]')).toHaveLength(0);
    expect(tooltipText(container)).toBe(READOUT[3]);
  });
});
