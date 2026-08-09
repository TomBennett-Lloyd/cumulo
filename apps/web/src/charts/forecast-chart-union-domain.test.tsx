// @vitest-environment jsdom

import { act, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { xForIndex } from './chart-geometry';
import type { ForecastChartPoint } from './ForecastChart';
import {
  anchorCount,
  banded,
  JSDOM_PLOT,
  isoHour,
  marks,
  renderChart,
  requireMark,
  requireSvg,
  tableCells,
} from './forecast-chart-test-fixture';

/*
 * The chart over a union x-domain: a series whose early hours were measured and never forecast.
 *
 * New in #264, and new to this chart. Every series it had ever been given carried a forecast at
 * every hour, because a point existed *because* a forecast existed — so the median alone among the
 * series ran unbroken and needed no gap rule. The fleet chart's x-domain is now the union of the
 * two aggregated series (`dashboard/fleet-series.ts`), and against the deployed source the two
 * windows do not overlap at all: the forecast fan-out reaches forward from the clock, the actuals
 * read reaches back from it.
 *
 * Its own file rather than more cases in `ForecastChart.test.tsx`, which sits on `structure.md`
 * rule 4's 300-line ceiling — the same split `forecast-chart-hover.test.tsx` and
 * `forecast-chart-readout.test.tsx` already made, and they share the one fixture module so the
 * suites cannot drift about what a series looks like.
 */

afterEach(cleanup);

/** A measured hour with no forecast on it — what every past hour looks like in live mode. */
const measuredOnly = (hour: number, actualKw: number): ForecastChartPoint => ({
  validTimeIso: isoHour(hour),
  medianKw: null,
  actualKw,
});

/** Two measured hours, then two forecast ones: the live shape at its smallest. */
const DISJOINT_SERIES: readonly ForecastChartPoint[] = [
  measuredOnly(6, 1),
  measuredOnly(9, 2),
  banded(12, 6, null),
  banded(15, 5, null),
];

describe('ForecastChart over hours that carry an actual and no forecast', () => {
  it('draws both series over the hours each one has, and neither over the other’s', () => {
    const container = renderChart(DISJOINT_SERIES);

    // One run each, two hours each — and crucially the median does not span the whole domain,
    // which is what it would do if a missing forecast were read as a zero or bridged across.
    expect(marks(container, '.forecast-chart-actuals')).toHaveLength(1);
    expect(anchorCount(requireMark(container, '.forecast-chart-actuals'))).toBe(2);
    expect(marks(container, '.forecast-chart-median')).toHaveLength(1);
    expect(anchorCount(requireMark(container, '.forecast-chart-median'))).toBe(2);
  });

  it('rules the horizon where the measurements stop, mid-series rather than at the end', () => {
    const container = renderChart(DISJOINT_SERIES);
    const horizon = requireMark(container, '.forecast-chart-horizon');

    // Index 1 is the last measured hour. On the demo's overlapping windows the horizon lands late
    // in the series; here it lands in the middle, with the forecast entirely to its right.
    expect(horizon.getAttribute('x1')).toBe(
      String(xForIndex(1, DISJOINT_SERIES.length, JSDOM_PLOT)),
    );
  });

  it('draws a lone forecast hour as a marker, not a path that paints nothing', () => {
    // The same rule the actuals and the overlay already obey: a run of one sample has no second
    // vertex to stroke towards, so SVG would paint nothing at all and the hour would vanish.
    const container = renderChart([measuredOnly(6, 1), banded(9, 4, null), measuredOnly(12, 2)]);

    expect(marks(container, '.forecast-chart-median')).toHaveLength(0);
    expect(marks(container, '.forecast-chart-median-marker')).toHaveLength(1);
  });

  it('em-dashes the forecast columns of a measured hour rather than showing it as zero', () => {
    const container = renderChart(DISJOINT_SERIES);

    // The table twin is where a fabricated value would be readable as text: a zero median here
    // would be the chart claiming the fleet was forecast to generate nothing.
    expect(tableCells(container, 0)).toStrictEqual(['—', '—', '—', '1.0']);
    expect(tableCells(container, 2)).toStrictEqual(['5.0', '6.0', '7.0', '—']);
  });

  it('drops the median from the spoken readout at an hour it has no value for', () => {
    const container = renderChart(DISJOINT_SERIES);
    const svg = requireSvg(container);
    const readout = (): string | null =>
      container.querySelector('.forecast-chart-readout')?.textContent ?? null;

    act(() => {
      svg.focus();
    });

    // Focus opens on the first sample, which is measured and unforecast. Screen readers at default
    // punctuation verbosity say nothing for an em dash, so a `Median` row kept here would announce
    // a labelled series with no value at all — the same reason an unmeasured hour drops `Actual`.
    expect(readout()).toBe('06:00 — Actual 1.0');
  });
});
