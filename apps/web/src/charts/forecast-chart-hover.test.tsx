// @vitest-environment jsdom

import { act, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { xForIndex } from './chart-geometry';
import {
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
} from './forecast-chart-test-fixture';

// Vitest runs without global test hooks, so Testing Library's automatic cleanup
// never registers itself.
afterEach(cleanup);

/** Client x that lands the pointer exactly on a sample of the rendered chart. */
const clientXForIndex = (index: number, count: number): number =>
  clientXFor(xForIndex(index, count, JSDOM_PLOT));

const hoverSample = (container: HTMLElement, index: number, count: number): void => {
  fireEvent.pointerMove(requireMark(container, '.forecast-chart-pointer-target'), {
    clientX: clientXForIndex(index, count),
  });
};

/** The readout for each sample of SERIES, as the tooltip's flattened text. */
const READOUT: readonly string[] = [
  '06:000.9 Actual1.0 Median0.0–2.0 P10–P90',
  '09:003.8 Actual4.0 Median3.0–5.0 P10–P90',
  '12:005.9 Actual6.0 Median5.0–7.0 P10–P90',
  // Past the horizon: no measurement, so no measured row at all (#284 D6).
  '15:005.0 Median4.0–6.0 P10–P90',
  '18:002.0 Median1.0–3.0 P10–P90',
];

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

    hoverSample(container, 2, SERIES.length);
    const crosshair = requireMark(container, '.forecast-chart-crosshair');

    expect(crosshair.getAttribute('x1')).toBe(String(xForIndex(2, SERIES.length, JSDOM_PLOT)));
    expect(crosshair.getAttribute('x1')).toBe(crosshair.getAttribute('x2'));
    expect(tooltipText(container)).toBe(READOUT[2]);
  });

  it('snaps a pointer between two samples to the nearer one', () => {
    const container = renderChart(SERIES);
    stubRenderedSize(requireSvg(container));

    // A quarter of a step past sample 1 — nowhere near a drawn mark.
    fireEvent.pointerMove(requireMark(container, '.forecast-chart-pointer-target'), {
      clientX:
        clientXForIndex(1, SERIES.length) +
        (clientXForIndex(2, SERIES.length) - clientXForIndex(1, SERIES.length)) / 4,
    });

    expect(tooltipText(container)).toBe(READOUT[1]);
  });

  it('clears the readout when the pointer leaves the plot', () => {
    const container = renderChart(SERIES);
    stubRenderedSize(requireSvg(container));
    hoverSample(container, 2, SERIES.length);

    fireEvent.pointerLeave(requireMark(container, '.forecast-chart-pointer-target'));

    expect(tooltipText(container)).toBeNull();
    expect(marks(container, '.forecast-chart-crosshair')).toHaveLength(0);
  });

  it('shows from the keyboard exactly what it shows from the pointer', () => {
    const container = renderChart(SERIES);
    const svg = requireSvg(container);
    stubRenderedSize(svg);

    hoverSample(container, 2, SERIES.length);
    const hovered = tooltipText(container);
    fireEvent.pointerLeave(requireMark(container, '.forecast-chart-pointer-target'));

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
    hoverSample(container, 2, SERIES.length);

    const [measured, median, range] = tooltipValues(container);
    const [p10, tableMedian, p90, tableActual] = tableCells(container, 2);

    // Tooltips enhance, they never gate (chart-treatment.md): every number in
    // the readout is reachable without a pointer, in the row for the same hour.
    expect(measured).toBe(tableActual);
    expect(median).toBe(tableMedian);
    expect(range).toBe(`${String(p10)}–${String(p90)}`);
  });

  it('omits the range row for a point with no modelled uncertainty', () => {
    const container = renderChart([bare(6, 1, 0.9), bare(9, 4, 3.8)]);

    act(() => {
      requireSvg(container).focus();
    });

    // An absent row says "not modelled"; an em-dashed one would imply a range.
    expect(tooltipText(container)).toBe('06:000.9 Actual1.0 Median');
    expect(tooltipValues(container)).toStrictEqual(['0.9', '1.0']);
  });

  it('keeps the tooltip inside the plot at the right-hand end of the series', () => {
    const container = renderChart(SERIES);
    const svg = requireSvg(container);
    act(() => {
      svg.focus();
    });

    fireEvent.keyDown(svg, { key: 'End' });

    expect(tooltipAnchor(container)).toBeGreaterThanOrEqual(JSDOM_PLOT.left);
    expect(tooltipAnchor(container)).toBeLessThan(xForIndex(4, SERIES.length, JSDOM_PLOT));
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
    // Stepping onto a point with no modelled uncertainty drops the band row, so
    // the row *set* changes — which is when keyed matching has to tell the two
    // "Median" rows apart rather than pairing them off by position.
    fireEvent.keyDown(svg, { key: 'ArrowRight' });

    const keyWarnings = logged.mock.calls
      .map((call) => call.map(String).join(' '))
      .filter((message) => /same key/iu.test(message));

    expect(keyWarnings).toEqual([]);
    // The rows the reader is owed are all still there, which is what the keys
    // are protecting. Asserted after the warning, because this is the assertion
    // that passes either way today.
    expect(tooltipValues(container)).toStrictEqual(['3.8', '4.0', '8.5']);

    logged.mockRestore();
  });

  it('positions the whole readout with SVG attributes and no inline style', () => {
    const container = renderChart(SERIES);
    stubRenderedSize(requireSvg(container));
    hoverSample(container, 3, SERIES.length);

    // Inline styles are a lint error in UI code (react.md rule 5); this is the
    // runtime half of that gate, over the one layer that computes positions.
    expect(container.querySelectorAll('[style]')).toHaveLength(0);
    expect(tooltipText(container)).toBe(READOUT[3]);
  });
});
