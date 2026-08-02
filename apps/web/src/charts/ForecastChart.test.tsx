// @vitest-environment jsdom

import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { xForIndex } from './chart-geometry';
import type { ForecastChartPoint } from './chart-series';
import { CHART_PLOT, HORIZON_LABEL_WIDTH } from './ForecastChart';
import {
  banded,
  bare,
  marks,
  renderChart,
  requireMark,
  requireSvg,
  SERIES,
  tableCells,
} from './forecast-chart-test-fixture';

// Vitest runs without global test hooks, so Testing Library's automatic cleanup
// never registers itself.
afterEach(cleanup);

const vertexCount = (mark: Element): number =>
  (mark.getAttribute('points') ?? '').split(' ').length;

const MS_PER_HOUR = 3_600_000;
/** The fixture source's 7-day window: 168 hours back, now, and 24 forward. */
const WEEK_RANGE_POINT_COUNT = 193;
const WEEK_RANGE_LAST_MEASURED_INDEX = 168;

/**
 * The series shape the 7-day view actually renders. Its horizon sits seven
 * eighths across the plot, which is where the label ran off the right of the
 * canvas and rendered as "forecast hori…".
 */
const weekRangeSeries = (): readonly ForecastChartPoint[] =>
  Array.from({ length: WEEK_RANGE_POINT_COUNT }, (_unused, index) => ({
    validTimeIso: new Date(Date.UTC(2026, 6, 23, 12) + index * MS_PER_HOUR).toISOString(),
    medianKw: 4,
    band: { p10Kw: 3, p90Kw: 5 },
    actualKw: index <= WEEK_RANGE_LAST_MEASURED_INDEX ? 3.5 : null,
  }));

const horizonLabel = (container: HTMLElement): Element => {
  const found = [...container.querySelectorAll('.forecast-chart-axis-label')].find(
    (element) => element.textContent === 'forecast horizon',
  );
  if (found === undefined) {
    throw new Error('no horizon label');
  }
  return found;
};

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

  it('labels the horizon to the right of its rule while there is room for it', () => {
    const container = renderChart(SERIES);
    const label = horizonLabel(container);
    const ruleX = Number(requireMark(container, '.forecast-chart-horizon').getAttribute('x1'));

    expect(label.getAttribute('text-anchor')).toBe('start');
    expect(Number(label.getAttribute('x'))).toBeGreaterThan(ruleX);
    expect(Number(label.getAttribute('x')) + HORIZON_LABEL_WIDTH).toBeLessThanOrEqual(
      CHART_PLOT.right,
    );
  });

  /*
   * The 7-day window shipped with this label clipped off the canvas. The
   * assertion is the whole extent of the text, not just its anchor: an anchor
   * inside the plot with the words running out of it is the defect.
   */
  it('flips the horizon label inwards when the horizon sits late in the window', () => {
    const container = renderChart(weekRangeSeries());
    const label = horizonLabel(container);
    const anchorX = Number(label.getAttribute('x'));
    const ruleX = xForIndex(WEEK_RANGE_LAST_MEASURED_INDEX, WEEK_RANGE_POINT_COUNT, CHART_PLOT);

    expect(requireMark(container, '.forecast-chart-horizon').getAttribute('x1')).toBe(
      String(ruleX),
    );
    // Where the words actually end, which depends on which end is anchored —
    // an anchor inside the plot with the text running out of it is the defect.
    const rightEdge =
      label.getAttribute('text-anchor') === 'end' ? anchorX : anchorX + HORIZON_LABEL_WIDTH;

    expect(rightEdge).toBeLessThanOrEqual(CHART_PLOT.right);
    expect(label.getAttribute('text-anchor')).toBe('end');
    expect(anchorX).toBeLessThan(ruleX);
    expect(anchorX - HORIZON_LABEL_WIDTH).toBeGreaterThanOrEqual(CHART_PLOT.left);
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
    expect(tableCells(container, 0)).toStrictEqual(['0.0', '1.0', '2.0', '0.9']);
    // Past the horizon: no measurement. Point estimate: no band bounds.
    expect(tableCells(container, 4)).toStrictEqual(['1.0', '2.0', '3.0', '—']);
    expect(tableCells(container, 5)).toStrictEqual(['—', '0.5', '—', '—']);
  });

  it('carries the caller labels to the image role and the table caption', () => {
    const container = renderChart(SERIES);

    expect(container.querySelector('svg[role="img"]')?.getAttribute('aria-label')).toBe(
      'Sunnyside Farm: forecast and actuals',
    );
    expect(container.querySelector('caption')?.textContent).toBe('Table view — Sunnyside Farm, kW');
  });

  /*
   * The axis is UTC and never the reader's local zone, which chart-treatment.md
   * accepts only on condition that the chart says so in its chrome. Both strings
   * are written out here rather than imported from `chart-copy.ts`: a test that
   * imports the constant it checks asserts nothing about the wording, and would
   * follow a silent rename straight past the reader who needs the words.
   */
  it('states its clock in the plot chrome', () => {
    const container = renderChart(SERIES);

    expect(requireSvg(container).textContent).toContain('Times in UTC');
  });

  it('heads the table twin’s time column with the clock', () => {
    renderChart(SERIES);

    expect(screen.getByRole('columnheader', { name: 'Time (UTC)' })).toBeDefined();
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
