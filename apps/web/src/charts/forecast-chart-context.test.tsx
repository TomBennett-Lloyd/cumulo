// @vitest-environment jsdom

import { cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { xForIndex } from './chart-geometry';
import type { ForecastChartPoint } from './chart-series';
import {
  JSDOM_PLOT,
  marks,
  renderChart,
  requireMark,
  requireSvg,
  SERIES,
} from './forecast-chart-test-fixture';

/**
 * The two context layers, rendered through the chart that composes them: the
 * night wash and the UTC day boundaries (#335).
 *
 * Through `renderChart` rather than by calling the builders directly, because
 * half of what this layer has to get right is *where in the draw order* it
 * lands — a wash painted over the median would be a defect no assertion on a
 * returned array could see. Coordinates are the plot at `DEFAULT_CHART_WIDTH`,
 * which is the width every chart under `src/` draws at (`JSDOM_PLOT` carries
 * why).
 *
 * Attributes and never pixels: whether the shipped alpha is *subtle enough to
 * read a series line over* is a question about rendered colour, so it belongs to
 * the browser lane and no spec there asserts it today (`testing.md` rule 10).
 * What is asserted here is the geometry and the wiring.
 */

afterEach(cleanup);

const MS_PER_HOUR = 3_600_000;

/** An evening series with no midnight in it, so night is the only layer drawn. */
const eveningHour = (hour: number): string =>
  `2026-07-30T${hour.toString().padStart(2, '0')}:00:00Z`;

/**
 * Five evening hours: two classified daylight, then a dark run of three.
 *
 * The daylight pair is `night: false` and not an omitted key on purpose. It is
 * the control that keeps the run's boundary a fact about the *classification*
 * rather than about the ends of the series — a widened predicate that treated an
 * unclassified hour as dark would leave this case's rect exactly where it is,
 * and would move it if these two hours were unclassified.
 */
const EVENING: readonly ForecastChartPoint[] = [
  { validTimeIso: eveningHour(18), medianKw: 3, actualKw: 3, night: false },
  { validTimeIso: eveningHour(19), medianKw: 1, actualKw: 1, night: false },
  { validTimeIso: eveningHour(20), medianKw: 0, actualKw: 0, night: true },
  { validTimeIso: eveningHour(21), medianKw: 0, actualKw: 0, night: true },
  { validTimeIso: eveningHour(22), medianKw: 0, actualKw: 0, night: true },
];

const NIGHT_RUN_START_INDEX = 2;
const NIGHT_RUN_END_INDEX = 4;

/** 26 hours from 23:00, so two UTC midnights fall on samples: indices 1 and 25. */
const TWO_MIDNIGHT_SERIES: readonly ForecastChartPoint[] = Array.from(
  { length: 26 },
  (_unused, index) => ({
    validTimeIso: new Date(Date.UTC(2026, 6, 30, 23) + index * MS_PER_HOUR).toISOString(),
    medianKw: 2,
    actualKw: null,
  }),
);

const MIDNIGHT_INDICES = [1, 25];

/**
 * Where a mark sits among the plot's direct children — which is its paint order,
 * SVG having no z-index. The grid is a `<g>` per tick rather than a bare line, so
 * the match reaches inside a child as well as at it.
 */
const childIndexOf = (container: HTMLElement, selector: string): number => {
  const svg = requireSvg(container);
  const found = [...svg.children].findIndex(
    (child) => child.matches(selector) || child.querySelector(selector) !== null,
  );
  if (found === -1) {
    throw new Error(`no child of the plot matching ${selector}`);
  }
  return found;
};

describe('the night wash', () => {
  it("shades a contiguous night run as one rect at the run's sample bounds", () => {
    const container = renderChart(EVENING);
    const washes = marks(container, '.forecast-chart-night');
    const rect = requireMark(container, '.forecast-chart-night');
    const startX = xForIndex(NIGHT_RUN_START_INDEX, EVENING.length, JSDOM_PLOT);
    const endX = xForIndex(NIGHT_RUN_END_INDEX, EVENING.length, JSDOM_PLOT);

    expect(washes).toHaveLength(1);
    expect(rect.getAttribute('x')).toBe(String(startX));
    expect(rect.getAttribute('width')).toBe(String(endX - startX));
    // Full height of the plot: the wash is behind the whole series, not behind
    // the part of it that happens to be near zero.
    expect(rect.getAttribute('y')).toBe(String(JSDOM_PLOT.top));
    expect(rect.getAttribute('height')).toBe(String(JSDOM_PLOT.bottom - JSDOM_PLOT.top));
  });

  /*
   * The documented skip. A lone dark hour between two light ones would have zero
   * width, and SVG paints nothing for it — drawn as a hairline instead it would
   * be a fourth thing that looks like a vertical line on this canvas.
   */
  it('skips a lone night sample, which has no width to wash', () => {
    const lone = EVENING.map((point, index) => ({ ...point, night: index === 2 }));

    expect(marks(renderChart(lone), '.forecast-chart-night')).toHaveLength(0);
  });

  it('draws no context for points without night flags', () => {
    // The shared fixture: no `night` key anywhere, and no sample at UTC
    // midnight. Absence is not `false` in the type and both draw nothing here.
    const container = renderChart(SERIES);

    expect(marks(container, '.forecast-chart-night')).toHaveLength(0);
    expect(marks(container, '.forecast-chart-day-boundary')).toHaveLength(0);
  });
});

describe('the day boundaries', () => {
  it('draws a boundary line at each UTC midnight sample', () => {
    const container = renderChart(TWO_MIDNIGHT_SERIES);
    const boundaries = marks(container, '.forecast-chart-day-boundary');
    const expectedX = MIDNIGHT_INDICES.map((index) =>
      String(xForIndex(index, TWO_MIDNIGHT_SERIES.length, JSDOM_PLOT)),
    );

    expect(boundaries.map((line) => line.getAttribute('x1'))).toStrictEqual(expectedX);
    // Vertical and full height, which is what makes it a boundary rather than a
    // tick: a line whose ends disagreed would be neither.
    expect(boundaries.map((line) => line.getAttribute('x2'))).toStrictEqual(expectedX);
    expect(boundaries.map((line) => line.getAttribute('y1'))).toStrictEqual(
      expectedX.map(() => String(JSDOM_PLOT.top)),
    );
    expect(boundaries.map((line) => line.getAttribute('y2'))).toStrictEqual(
      expectedX.map(() => String(JSDOM_PLOT.bottom)),
    );
  });
});

describe('where the context layers sit in the draw order', () => {
  /*
   * The whole of what makes a wash this faint acceptable is that nothing is
   * drawn under it. Document order is paint order in SVG, so the indices are the
   * assertion.
   */
  it('paints the wash under the grid and the boundaries over it, both under the data', () => {
    const container = renderChart(EVENING);

    expect(childIndexOf(container, '.forecast-chart-night')).toBeLessThan(
      childIndexOf(container, '.forecast-chart-grid'),
    );
    expect(childIndexOf(container, '.forecast-chart-median')).toBeGreaterThan(
      childIndexOf(container, '.forecast-chart-night'),
    );
  });

  it('paints a day boundary over the grid and under the data', () => {
    const container = renderChart(TWO_MIDNIGHT_SERIES);
    const boundaryAt = childIndexOf(container, '.forecast-chart-day-boundary');

    expect(boundaryAt).toBeGreaterThan(childIndexOf(container, '.forecast-chart-grid'));
    expect(boundaryAt).toBeLessThan(childIndexOf(container, '.forecast-chart-median'));
  });
});
