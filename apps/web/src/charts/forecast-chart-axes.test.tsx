// @vitest-environment jsdom

import { cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ForecastChartPoint } from './chart-series';
import {
  marks,
  renderChart,
  renderPercentChart,
  requireMark,
  SERIES,
  xOfSample,
} from './forecast-chart-test-fixture';

/**
 * The plot's chrome, rendered: the horizon rule, the two tiers of the time axis,
 * and the two axis titles.
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
 * The series shape the 7-day view actually renders — a week of hours, which is
 * the span the two-tier axis below is written for. Its horizon sits seven
 * eighths across the plot, which used to be the hard case for the words beside
 * the rule: start-anchored they ran off the right of the canvas and rendered as
 * "forecast hori…". #429 deleted those words, so the extreme position now costs
 * the chart nothing and this series is kept for its span alone.
 */
const weekRangeSeries = (): readonly ForecastChartPoint[] =>
  Array.from({ length: WEEK_RANGE_POINT_COUNT }, (_unused, index) => ({
    validTimeIso: new Date(Date.UTC(2026, 6, 23, 12) + index * MS_PER_HOUR).toISOString(),
    medianKw: 4,
    band: { p10Kw: 3, p90Kw: 5 },
    actualKw: index <= WEEK_RANGE_LAST_MEASURED_INDEX ? 3.5 : null,
  }));

describe('the forecast horizon', () => {
  it('rules the horizon at the last measured sample', () => {
    const container = renderChart(SERIES);
    const horizon = requireMark(container, '.forecast-chart-horizon');

    expect(horizon.getAttribute('x1')).toBe(String(xOfSample(SERIES, 2)));
    expect(horizon.getAttribute('x1')).toBe(horizon.getAttribute('x2'));
  });

  /*
   * The pin on #429: the owner's 2026-08-11 round deleted the words `forecast
   * horizon` from the canvas and kept the dashed rule, which now carries the
   * threshold alone (`docs/design/chart-treatment.md`, the horizon bullet).
   *
   * Both halves are asserted together on purpose. A chart that rendered nothing
   * at all would satisfy the absence on its own, so the rule being drawn is what
   * makes the absence mean "the mark speaks without words" rather than "there is
   * no mark". The phrase is written out rather than imported, since a test that
   * imports the string it forbids cannot notice the string coming back.
   */
  it('marks the horizon with the rule alone, never with words on the canvas', () => {
    const container = renderChart(SERIES);

    expect(marks(container, '.forecast-chart-horizon')).toHaveLength(1);
    expect(container.textContent).not.toContain('forecast horizon');
  });

  it('omits the horizon and its marker when nothing has been measured', () => {
    const container = renderChart(SERIES.map((point) => ({ ...point, actualKw: null })));

    expect(marks(container, '.forecast-chart-horizon')).toHaveLength(0);
    expect(marks(container, '.forecast-chart-actuals-marker')).toHaveLength(0);
    expect(marks(container, '.forecast-chart-actuals')).toHaveLength(0);
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

  /*
   * The other unit (#291). A percent chart's value axis is titled by what it
   * counts and nothing else — `% of capacity` names the quantity as well as the
   * unit, so there is no `Power (…)` to wrap it in — while the clock's title is
   * untouched, because the unit toggle is a fact about one axis. Written out
   * rather than imported for the reason the case above is: a test that imports
   * the words it checks would follow a silent rename past the reader.
   */
  it('titles the value axis in percent of capacity when the chart is in that unit', () => {
    const container = renderPercentChart(SERIES);
    const titles = [...container.querySelectorAll('.forecast-chart-axis-title')];

    expect(titles.map((title) => title.textContent)).toStrictEqual(['% of capacity', 'Time (UTC)']);
    // Along the axis in both units, which is what makes the longer string free:
    // a rotated title spends the plot's height, never the gutter's width.
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
