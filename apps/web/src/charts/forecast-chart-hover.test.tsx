// @vitest-environment jsdom

import { act, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { xForIndex } from './chart-geometry';
import { CHART_PLOT, CHART_VIEW_BOX_WIDTH } from './ForecastChart';
import {
  bare,
  renderChart,
  requireMark,
  requireSvg,
  SERIES,
  marks,
  tableCells,
} from './forecast-chart-test-fixture';

// Vitest runs without global test hooks, so Testing Library's automatic cleanup
// never registers itself.
afterEach(cleanup);

/** Deliberately not 1:1 with the view box — see `stubRenderedSize`. */
const RENDERED_BOUNDS = { left: 100, top: 50, width: 960, height: 388 };

/**
 * The chart scales to its container, so the hover layer must divide client
 * pixels by the rendered width before it can talk about samples. jsdom lays
 * everything out at zero, so the size comes from here — at 2x the view box,
 * which is what makes the scaling step provable rather than accidentally right
 * at 1:1.
 */
const stubRenderedSize = (svg: SVGSVGElement): void => {
  const bounds: DOMRect = {
    x: RENDERED_BOUNDS.left,
    y: RENDERED_BOUNDS.top,
    left: RENDERED_BOUNDS.left,
    top: RENDERED_BOUNDS.top,
    width: RENDERED_BOUNDS.width,
    height: RENDERED_BOUNDS.height,
    right: RENDERED_BOUNDS.left + RENDERED_BOUNDS.width,
    bottom: RENDERED_BOUNDS.top + RENDERED_BOUNDS.height,
    toJSON: () => ({}),
  };
  Object.defineProperty(svg, 'getBoundingClientRect', { value: () => bounds });
};

/** Client x that lands the pointer exactly on a sample of the rendered chart. */
const clientXForIndex = (index: number, count: number): number =>
  RENDERED_BOUNDS.left +
  xForIndex(index, count, CHART_PLOT) * (RENDERED_BOUNDS.width / CHART_VIEW_BOX_WIDTH);

const hoverSample = (container: HTMLElement, index: number, count: number): void => {
  fireEvent.pointerMove(requireMark(container, '.forecast-chart-pointer-target'), {
    clientX: clientXForIndex(index, count),
  });
};

const tooltipText = (container: HTMLElement): string | null =>
  container.querySelector('.forecast-chart-tooltip')?.textContent ?? null;

const tooltipValues = (container: HTMLElement): readonly (string | null)[] =>
  [...container.querySelectorAll('.forecast-chart-tooltip-value')].map((cell) => cell.textContent);

/** The panel's left edge, read back out of the group's `translate`. */
const tooltipAnchor = (container: HTMLElement): number => {
  const transform = container.querySelector('.forecast-chart-tooltip')?.getAttribute('transform');
  const anchor = /translate\((?<x>[-\d.]+)/u.exec(transform ?? '')?.groups?.x;
  return anchor === undefined ? Number.NaN : Number(anchor);
};

/** The readout for each sample of SERIES, as the tooltip's flattened text. */
const READOUT: readonly string[] = [
  '06:000.9 Actual1.0 Median0.0–2.0 P10–P90',
  '09:003.8 Actual4.0 Median3.0–5.0 P10–P90',
  '12:005.9 Actual6.0 Median5.0–7.0 P10–P90',
  '15:00— Actual5.0 Median4.0–6.0 P10–P90',
  '18:00— Actual2.0 Median1.0–3.0 P10–P90',
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

    expect(crosshair.getAttribute('x1')).toBe(String(xForIndex(2, SERIES.length, CHART_PLOT)));
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

    expect(tooltipAnchor(container)).toBeGreaterThanOrEqual(CHART_PLOT.left);
    expect(tooltipAnchor(container)).toBeLessThan(xForIndex(4, SERIES.length, CHART_PLOT));
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
