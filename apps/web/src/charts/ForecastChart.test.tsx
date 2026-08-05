// @vitest-environment jsdom

import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { xForIndex, yForKw } from './chart-geometry';
import type { ChartOverlaySeries, ForecastChartPoint } from './chart-series';
import { CHART_PLOT, HORIZON_LABEL_WIDTH } from './ForecastChart';
import {
  banded,
  bare,
  isoHour,
  marks,
  renderChart,
  renderChartWithOverlay,
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

/**
 * The axis the lone-band fixture below produces. Its tallest mark is that hour's
 * own P90 of 7 kW, which rounds up to the nice maximum written here — spelled
 * out rather than recomputed, so the test states the scale it expects instead of
 * re-deriving it from the code under test.
 */
const LONE_BAND_AXIS_MAX_KW = 8;

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
    // The first measurement is left alone by the gap after it, so it is a dot
    // rather than the one-vertex polyline SVG would decline to paint.
    const container = renderChart([
      banded(6, 1, 0.9),
      banded(9, 4, null),
      banded(12, 6, 5.9),
      banded(15, 5, 4.8),
    ]);
    const actuals = marks(container, '.forecast-chart-actuals');
    const markers = marks(container, '.forecast-chart-actuals-marker');

    expect(actuals).toHaveLength(1);
    expect(actuals.map(vertexCount)).toStrictEqual([2]);
    // The isolated hour, then the end dot at the horizon.
    expect(markers).toHaveLength(2);
    expect(markers[0]?.getAttribute('cx')).toBe(String(xForIndex(0, 4, CHART_PLOT)));
    expect(markers[1]?.getAttribute('cx')).toBe(String(xForIndex(3, 4, CHART_PLOT)));
  });

  it('breaks the band at a gap in the modelled uncertainty', () => {
    const container = renderChart([
      banded(6, 1, null),
      banded(9, 4, null),
      bare(12, 4, null),
      banded(15, 6, null),
    ]);
    const interval = requireMark(container, '.forecast-chart-band-interval');
    const intervalX = String(xForIndex(3, 4, CHART_PLOT));

    expect(marks(container, '.forecast-chart-band')).toHaveLength(1);
    expect(marks(container, '.forecast-chart-band-bound')).toHaveLength(2);
    // The trailing banded hour stands alone: a polygon over one sample is two
    // coincident edges and paints nothing, so it draws its bounds as an
    // interval instead (chart-treatment.md).
    expect(marks(container, '.forecast-chart-band-interval')).toHaveLength(1);
    expect(interval.getAttribute('x1')).toBe(intervalX);
    expect(interval.getAttribute('x2')).toBe(intervalX);
    expect(interval.getAttribute('y1')).toBe(String(yForKw(7, LONE_BAND_AXIS_MAX_KW, CHART_PLOT)));
    expect(interval.getAttribute('y2')).toBe(String(yForKw(5, LONE_BAND_AXIS_MAX_KW, CHART_PLOT)));
  });

  it('renders an isolated measured hour between two gaps as a ring-marked dot', () => {
    const container = renderChart([
      banded(6, 1, null),
      banded(9, 4, 3.8),
      banded(12, 6, null),
      banded(15, 5, 4.9),
      banded(18, 4, 4.1),
    ]);
    const markers = marks(container, '.forecast-chart-actuals-marker');

    expect(markers).toHaveLength(2);
    expect(markers[0]?.getAttribute('cx')).toBe(String(xForIndex(1, 5, CHART_PLOT)));
    expect(marks(container, '.forecast-chart-actuals')).toHaveLength(1);
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

  it('renders a single-sample series as marks, not degenerate paths', () => {
    // Every series here is one sample long, so nothing on the plot has a second
    // vertex to stroke towards. Drawn as paths the whole chart would be blank.
    const container = renderChart([banded(12, 6, 5.9)]);

    expect(marks(container, '.forecast-chart-band')).toHaveLength(0);
    expect(marks(container, '.forecast-chart-band-interval')).toHaveLength(1);
    expect(marks(container, '.forecast-chart-median-marker')).toHaveLength(1);
    expect(marks(container, '.forecast-chart-actuals-marker')).toHaveLength(1);
    expect(container.querySelectorAll('.forecast-chart-table tbody tr')).toHaveLength(1);
  });

  /*
   * The overlay: one more series on the same axis, in slot 2. `OVERLAY` covers
   * SERIES' first three hours and stops, so every test below is also a test of
   * what happens at the hours it does not cover.
   */
  const OVERLAY: ChartOverlaySeries = {
    label: 'Baseline',
    points: [
      { validTimeIso: isoHour(6), kw: 2.5 },
      { validTimeIso: isoHour(9), kw: 3.5 },
      { validTimeIso: isoHour(12), kw: 4.5 },
    ],
  };

  it('draws the overlay across the hours it covers and stops at the ones it does not', () => {
    const container = renderChartWithOverlay(SERIES, OVERLAY);
    const overlay = marks(container, '.forecast-chart-overlay');

    expect(overlay).toHaveLength(1);
    expect(vertexCount(requireMark(container, '.forecast-chart-overlay'))).toBe(3);
    expect(marks(container, '.forecast-chart-overlay-marker')).toHaveLength(0);
  });

  it('breaks the overlay at a gap and marks a run left holding one hour', () => {
    // Same two rules as the actuals: never bridge, never vanish.
    const container = renderChartWithOverlay(SERIES, {
      label: 'Baseline',
      points: [
        { validTimeIso: isoHour(6), kw: 2.5 },
        { validTimeIso: isoHour(9), kw: null },
        { validTimeIso: isoHour(12), kw: 4.5 },
        { validTimeIso: isoHour(15), kw: 4 },
      ],
    });
    const markers = marks(container, '.forecast-chart-overlay-marker');

    expect(marks(container, '.forecast-chart-overlay')).toHaveLength(1);
    expect(vertexCount(requireMark(container, '.forecast-chart-overlay'))).toBe(2);
    expect(markers).toHaveLength(1);
    expect(markers[0]?.getAttribute('cx')).toBe(String(xForIndex(0, SERIES.length, CHART_PLOT)));
  });

  it('names the overlay in the legend, after the three fixed entries', () => {
    const container = renderChartWithOverlay(SERIES, OVERLAY);
    const entries = [...container.querySelectorAll('.forecast-chart-legend li')];

    expect(entries.map((entry) => entry.textContent.trim())).toStrictEqual([
      'Forecast (P10–P90)',
      'Forecast (median)',
      'Actuals',
      'Baseline',
    ]);
  });

  it('gives the overlay a table column headed by its label', () => {
    const container = renderChartWithOverlay(SERIES, OVERLAY);
    const headers = [...container.querySelectorAll('.forecast-chart-table thead th')];

    expect(headers.map((header) => header.textContent)).toStrictEqual([
      'Time (UTC)',
      'P10',
      'Median',
      'P90',
      'Actual',
      'Baseline',
    ]);
    expect(tableCells(container, 0)).toStrictEqual(['0.0', '1.0', '2.0', '0.9', '2.5']);
    // An hour the overlay never covered reads as the same em dash a missing
    // measurement does — the table twin says "no value", not "zero".
    expect(tableCells(container, 3)).toStrictEqual(['4.0', '5.0', '6.0', '—', '—']);
  });

  it('speaks the overlay in the readout, and drops it at an hour it does not cover', () => {
    const container = renderChartWithOverlay(SERIES, OVERLAY);
    const svg = requireSvg(container);
    const readout = (): string | null =>
      container.querySelector('.forecast-chart-readout')?.textContent ?? null;

    act(() => {
      svg.focus();
    });
    expect(readout()).toBe('06:00 — 0.9 Actual, 1.0 Median, 0.0–2.0 P10–P90, 2.5 Baseline');

    // Past the overlay's last hour: the row is dropped rather than spoken as an
    // em dash, which a screen reader says nothing for.
    fireEvent.keyDown(svg, { key: 'End' });
    expect(readout()).toBe('18:00 — 2.0 Median, 1.0–3.0 P10–P90');
  });

  it('raises the axis so an overlay above the forecast still lands inside the plot', () => {
    // Scaled to the forecast alone, a taller overlay is drawn off the top of
    // the plot — a value the reader cannot see at all.
    const container = renderChartWithOverlay(SERIES, {
      label: 'Baseline',
      points: SERIES.map((point) => ({ validTimeIso: point.validTimeIso, kw: 20 })),
    });
    const ys = (requireMark(container, '.forecast-chart-overlay').getAttribute('points') ?? '')
      .split(' ')
      .map((pair) => Number(pair.split(',')[1]));

    expect(ys).not.toStrictEqual([]);
    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(CHART_PLOT.top);
    }
  });

  it('draws no overlay mark, legend row or table column without the prop', () => {
    const container = renderChart(SERIES);

    expect(marks(container, '.forecast-chart-overlay')).toHaveLength(0);
    expect(marks(container, '.forecast-chart-overlay-marker')).toHaveLength(0);
    expect(container.querySelectorAll('.forecast-chart-legend li')).toHaveLength(3);
    expect(container.querySelectorAll('.forecast-chart-table thead th')).toHaveLength(5);
    expect(tableCells(container, 0)).toHaveLength(4);
  });

  it('renders an empty series as bare chrome rather than a median mark', () => {
    // The guard in `medianElements`: with no samples there is no line to stroke
    // and no first sample to fall back to as a marker, so the series draws
    // nothing at all instead of indexing a point that is not there.
    const container = renderChart([]);

    expect(requireSvg(container)).toBeDefined();
    expect(marks(container, '.forecast-chart-median')).toHaveLength(0);
    expect(marks(container, '.forecast-chart-median-marker')).toHaveLength(0);
  });
});
