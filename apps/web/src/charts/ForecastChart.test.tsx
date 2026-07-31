// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { xForIndex } from './chart-geometry';
import { CHART_PLOT, ForecastChart, type ForecastChartPoint } from './ForecastChart';

// Vitest runs without global test hooks, so Testing Library's automatic cleanup
// never registers itself.
afterEach(cleanup);

const iso = (hour: number): string => `2026-07-30T${hour.toString().padStart(2, '0')}:00:00Z`;

const banded = (hour: number, medianKw: number, actualKw: number | null): ForecastChartPoint => ({
  validTimeIso: iso(hour),
  medianKw,
  band: { p10Kw: medianKw - 1, p90Kw: medianKw + 1 },
  actualKw,
});

/** No `band` key at all — a point estimate, not a band of `undefined`. */
const bare = (hour: number, medianKw: number, actualKw: number | null): ForecastChartPoint => ({
  validTimeIso: iso(hour),
  medianKw,
  actualKw,
});

/** Five samples, banded throughout, measured up to a horizon at index 2. */
const SERIES: readonly ForecastChartPoint[] = [
  banded(6, 1, 0.9),
  banded(9, 4, 3.8),
  banded(12, 6, 5.9),
  banded(15, 5, null),
  banded(18, 2, null),
];

const renderChart = (points: readonly ForecastChartPoint[]): HTMLElement => {
  const { container } = render(
    <ForecastChart
      points={points}
      ariaLabel="Sunnyside Farm: forecast and actuals"
      tableCaption="Table view — Sunnyside Farm, kW"
    />,
  );
  return container;
};

/** Scoped to the plot, so legend swatches wearing the same classes stay out. */
const marks = (container: HTMLElement, selector: string): readonly Element[] => [
  ...container.querySelectorAll(`.forecast-chart > ${selector}`),
];

const requireMark = (container: HTMLElement, selector: string): Element => {
  const found = marks(container, selector)[0];
  if (found === undefined) {
    throw new Error(`no mark matching ${selector}`);
  }
  return found;
};

const vertexCount = (mark: Element): number =>
  (mark.getAttribute('points') ?? '').split(' ').length;

describe('ForecastChart', () => {
  it('renders the uncertainty band as a fill with no fill-opacity attribute', () => {
    const container = renderChart(SERIES);
    const band = requireMark(container, '.forecast-chart-band');

    // The 10% alpha is baked into the token; a fill-opacity would double-dip
    // and produce a band nobody can see (chart-treatment.md).
    expect(band.hasAttribute('fill-opacity')).toBe(false);
    expect(band.tagName.toLowerCase()).toBe('polygon');
  });

  it('closes the band over every sample, out along P90 and back along P10', () => {
    const container = renderChart(SERIES);
    const band = requireMark(container, '.forecast-chart-band');

    expect(vertexCount(band)).toBe(SERIES.length * 2);
  });

  it('strokes both bounds of every band run', () => {
    const container = renderChart(SERIES);

    expect(marks(container, '.forecast-chart-band-bound')).toHaveLength(2);
  });

  it('draws band, bounds, median and actuals back to front', () => {
    const container = renderChart(SERIES);
    const drawn = [...(container.querySelector('.forecast-chart')?.children ?? [])];
    const firstIndexOf = (selector: string): number =>
      drawn.findIndex((element) => element.matches(selector));

    const order = [
      '.forecast-chart-band',
      '.forecast-chart-band-bound',
      '.forecast-chart-median',
      '.forecast-chart-actuals',
      '.forecast-chart-actuals-marker',
    ].map(firstIndexOf);

    // A missing mark indexes as -1, which would sort ahead of everything and
    // let the ordering assertion pass on a chart that never drew it.
    expect(order.filter((index) => index < 0)).toStrictEqual([]);
    expect(order).toStrictEqual([...order].sort((left, right) => left - right));
  });

  it('draws the median across every sample and actuals across measured ones only', () => {
    const container = renderChart(SERIES);

    expect(vertexCount(requireMark(container, '.forecast-chart-median'))).toBe(SERIES.length);
    expect(vertexCount(requireMark(container, '.forecast-chart-actuals'))).toBe(3);
  });

  it('breaks the actuals line at a gap rather than bridging a missing measurement', () => {
    // A mid-series null is a partial result and must read as one: bridging it
    // would draw a measurement nobody took (docs/tech-debt.md, 2026-07-31).
    const container = renderChart([
      banded(6, 1, 0.9),
      banded(9, 4, null),
      banded(12, 6, 5.9),
      banded(15, 5, 4.8),
    ]);
    const actuals = marks(container, '.forecast-chart-actuals');

    expect(actuals).toHaveLength(2);
    expect(actuals.map(vertexCount)).toStrictEqual([1, 2]);
  });

  it('breaks the band at a gap in the modelled uncertainty', () => {
    const container = renderChart([banded(6, 1, null), bare(9, 4, null), banded(12, 6, null)]);

    expect(marks(container, '.forecast-chart-band')).toHaveLength(2);
    expect(marks(container, '.forecast-chart-band-bound')).toHaveLength(4);
  });

  it('omits the band entirely when no point carries one', () => {
    const container = renderChart([bare(6, 1, 0.9), bare(9, 4, 3.8)]);

    expect(marks(container, '.forecast-chart-band')).toHaveLength(0);
    expect(marks(container, '.forecast-chart-band-bound')).toHaveLength(0);
  });

  it('rules the forecast horizon at the last measured sample', () => {
    const container = renderChart(SERIES);
    const horizon = requireMark(container, '.forecast-chart-horizon');

    expect(horizon.getAttribute('x1')).toBe(String(xForIndex(2, SERIES.length, CHART_PLOT)));
    expect(horizon.getAttribute('x1')).toBe(horizon.getAttribute('x2'));
    expect(container.textContent).toContain('forecast horizon');
  });

  it('omits the horizon and its marker when nothing has been measured', () => {
    const container = renderChart(SERIES.map((point) => ({ ...point, actualKw: null })));

    expect(marks(container, '.forecast-chart-horizon')).toHaveLength(0);
    expect(marks(container, '.forecast-chart-actuals-marker')).toHaveLength(0);
    expect(marks(container, '.forecast-chart-actuals')).toHaveLength(0);
    expect(container.textContent).not.toContain('forecast horizon');
  });

  it('lists all three series in draw order even when nothing is measured', () => {
    const container = renderChart(SERIES.map((point) => ({ ...point, actualKw: null })));
    const entries = [...container.querySelectorAll('.forecast-chart-legend li')];

    expect(entries.map((entry) => entry.textContent.trim())).toStrictEqual([
      'Forecast (P10–P90)',
      'Forecast (median)',
      'Actuals',
    ]);
  });

  it('puts every sample in the table twin, with an em dash where a value is missing', () => {
    const container = renderChart([...SERIES, bare(21, 0.5, null)]);
    const rows = [...container.querySelectorAll('.forecast-chart-table tbody tr')];

    expect(rows).toHaveLength(SERIES.length + 1);
    expect(
      [...(rows[0]?.querySelectorAll('td') ?? [])].map((cell) => cell.textContent),
    ).toStrictEqual(['0.0', '1.0', '2.0', '0.9']);
    // Past the horizon: no measurement. Point estimate: no band bounds.
    expect(
      [...(rows[4]?.querySelectorAll('td') ?? [])].map((cell) => cell.textContent),
    ).toStrictEqual(['1.0', '2.0', '3.0', '—']);
    expect(
      [...(rows[5]?.querySelectorAll('td') ?? [])].map((cell) => cell.textContent),
    ).toStrictEqual(['—', '0.5', '—', '—']);
  });

  it('carries the caller labels to the image role and the table caption', () => {
    const container = renderChart(SERIES);

    expect(container.querySelector('svg[role="img"]')?.getAttribute('aria-label')).toBe(
      'Sunnyside Farm: forecast and actuals',
    );
    expect(container.querySelector('caption')?.textContent).toBe('Table view — Sunnyside Farm, kW');
  });

  it('renders a single-sample series without throwing', () => {
    const container = renderChart([banded(12, 6, 5.9)]);

    expect(marks(container, '.forecast-chart-band')).toHaveLength(1);
    expect(container.querySelectorAll('.forecast-chart-table tbody tr')).toHaveLength(1);
    expect(requireMark(container, '.forecast-chart-median').getAttribute('points')).not.toContain(
      'NaN',
    );
  });
});
