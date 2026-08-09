// @vitest-environment jsdom

import { cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { xForIndex } from './chart-geometry';
import type { ForecastChartPoint } from './chart-series';
import { HORIZON_LABEL_WIDTH } from './forecast-chart-axes';
import { JSDOM_PLOT, marks, renderChart, requireMark, SERIES } from './forecast-chart-test-fixture';

/**
 * The plot's chrome, rendered: the horizon rule and the words naming it, the two
 * tiers of the time axis, and the two axis titles.
 *
 * Split out of `ForecastChart.test.tsx` when #284 D9/D10 gave the axis a second
 * tier and both titles a rotation to assert — the file was at the 300-line
 * ceiling, and chrome against marks is the cut its source already makes
 * (`forecast-chart-axes.tsx` beside `forecast-chart-marks.tsx`, `structure.md`
 * rule 4). What stays next door is the data: band, bounds, median, actuals, gaps
 * and the table twin.
 *
 * Attributes and never pixels. jsdom lays nothing out, so what a rendered label
 * *box* does — whether two of them collide once the browser has shaped the
 * glyphs — is `e2e/chart-surfaces.spec.ts`'s to measure, and the arithmetic that
 * decides they cannot is `chart-axis-ticks.test.ts`'s (`testing.md` rule 10).
 */

// Vitest runs without global test hooks, so Testing Library's automatic cleanup
// never registers itself.
afterEach(cleanup);

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
  const labels = [...container.querySelectorAll('.forecast-chart-axis-label')];
  const found = labels.find((element) => element.textContent === 'forecast horizon');
  if (found === undefined) {
    throw new Error('no horizon label');
  }
  return found;
};

describe('the forecast horizon', () => {
  it('rules the horizon at the last measured sample', () => {
    const container = renderChart(SERIES);
    const horizon = requireMark(container, '.forecast-chart-horizon');

    expect(horizon.getAttribute('x1')).toBe(String(xForIndex(2, SERIES.length, JSDOM_PLOT)));
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
      JSDOM_PLOT.right,
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
    const ruleX = xForIndex(WEEK_RANGE_LAST_MEASURED_INDEX, WEEK_RANGE_POINT_COUNT, JSDOM_PLOT);

    expect(requireMark(container, '.forecast-chart-horizon').getAttribute('x1')).toBe(
      String(ruleX),
    );
    // Where the words actually end, which depends on which end is anchored —
    // an anchor inside the plot with the text running out of it is the defect.
    const rightEdge =
      label.getAttribute('text-anchor') === 'end' ? anchorX : anchorX + HORIZON_LABEL_WIDTH;

    expect(rightEdge).toBeLessThanOrEqual(JSDOM_PLOT.right);
    expect(label.getAttribute('text-anchor')).toBe('end');
    expect(anchorX).toBeLessThan(ruleX);
    expect(anchorX - HORIZON_LABEL_WIDTH).toBeGreaterThanOrEqual(JSDOM_PLOT.left);
  });

  it('omits the horizon and its marker when nothing has been measured', () => {
    const container = renderChart(SERIES.map((point) => ({ ...point, actualKw: null })));

    expect(marks(container, '.forecast-chart-horizon')).toHaveLength(0);
    expect(marks(container, '.forecast-chart-actuals-marker')).toHaveLength(0);
    expect(marks(container, '.forecast-chart-actuals')).toHaveLength(0);
    expect(container.textContent).not.toContain('forecast horizon');
  });
});

describe('the axis chrome', () => {
  /*
   * The axis is UTC and never the reader's local zone, which chart-treatment.md
   * accepts only on condition that the chart says so in its chrome. Since #284
   * D10 the words that discharge it are the time axis's own title, under the
   * ticks they govern, rather than a note floated in the top-right corner.
   * Written out here rather than imported from `chart-copy.ts`: a test that
   * imports the constant it checks asserts nothing about the wording, and would
   * follow a silent rename straight past the reader who needs the words.
   */
  it('titles each axis with what that axis counts, the clock included', () => {
    const container = renderChart(SERIES);
    const titles = [...container.querySelectorAll('.forecast-chart-axis-title')];

    expect(titles.map((title) => title.textContent)).toStrictEqual(['Power (kW)', 'Time (UTC)']);
    // Parallel to the axis it names, through a transform attribute — a `style`
    // prop is a lint error in UI code, and an unrotated title in the left
    // gutter would be a column of clipped words.
    expect(titles[0]?.getAttribute('transform')).toContain('rotate(-90');
  });

  it('draws the time axis in two tiers, bare hours over the days that qualify them', () => {
    const container = renderChart(weekRangeSeries());
    const hours = [...container.querySelectorAll('.forecast-chart-axis-time')];
    const days = [...container.querySelectorAll('.forecast-chart-axis-day')];

    expect(hours.length).toBeGreaterThan(1);
    expect(days.length).toBeGreaterThan(1);
    // The minutes the single-tier axis spent four characters of every tick on.
    expect(hours.map((hour) => hour.textContent).join(' ')).not.toContain(':');
    // Two rows and not one: the day sits below the hours it qualifies.
    expect(Number(days[0]?.getAttribute('y'))).toBeGreaterThan(Number(hours[0]?.getAttribute('y')));
  });
});
