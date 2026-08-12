import { describe, expect, it } from 'vitest';

import { chartPlot, type PlotRect } from './chart-geometry';
import { loadingCurvePath } from './chart-loading-curve';
import { DEFAULT_CHART_WIDTH } from './use-chart-width';

/*
 * What the loading trace is allowed to be, whatever the column it lands in.
 *
 * The subject is a `d` string, so the assertions are about the coordinates in
 * it: that the curve is inside the plot it was handed, and that it meets the
 * baseline at both ends. Nothing here asserts that the shape is *pretty* — that
 * is the owner's judgement and this file could only pretend to hold it — but the
 * two claims below are the ones a reader would notice being broken, because a
 * trace that left the plot would be drawn over the axis labels and one that
 * started off the baseline would read as a series that begins mid-air.
 *
 * Both gutter widths, because the left margin is width-dependent
 * (`chart-geometry.ts`'s `chartPlot`) and the trace is built from `plot.left`:
 * a curve that only ever met the baseline at the wide gutter would still be
 * wrong on a phone, which is the one column this app is guaranteed to be read
 * in.
 */

/** A column narrow enough to take the narrow gutter — `chartPlot`'s own threshold is 520. */
const NARROW_CHART_WIDTH = 500;

/**
 * Every coordinate pair in a `d`, in the order the path visits them.
 *
 * d3's path serialiser emits plain decimal numbers separated by commas and
 * command letters, so pulling the numbers out in order and pairing them gives
 * the on-path points *and* the cubic control points between them. Reading the
 * control points too is deliberate rather than sloppy: `curveMonotoneX` is what
 * keeps them from overshooting, and a fit that lost that property would put ink
 * outside the plot between two samples that were both inside it.
 */
const coordinatesOf = (path: string): readonly (readonly [number, number])[] => {
  const numbers = (path.match(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi) ?? []).map(Number);
  const pairs: (readonly [number, number])[] = [];

  for (let index = 0; index + 1 < numbers.length; index += 2) {
    const x = numbers[index];
    const y = numbers[index + 1];

    if (x === undefined || y === undefined) {
      throw new Error(`The loading trace emitted an odd number of coordinates: ${path}`);
    }

    pairs.push([x, y]);
  }

  return pairs;
};

const plots: readonly (readonly [string, PlotRect])[] = [
  ['the wide gutter', chartPlot(DEFAULT_CHART_WIDTH)],
  ['the narrow gutter', chartPlot(NARROW_CHART_WIDTH)],
];

describe('the chart’s loading trace', () => {
  it.each(plots)('draws a path across %s', (_name, plot) => {
    const path = loadingCurvePath(plot);

    // The positive control every assertion below rests on: there is a path at
    // all. `curvedLinePath` answers `''` for an empty run, and an empty string
    // would satisfy "no coordinate is outside the plot" for free.
    expect(path).not.toBe('');
    expect(coordinatesOf(path).length).toBeGreaterThan(1);
  });

  it.each(plots)('starts and finishes on the baseline of %s', (_name, plot) => {
    const coordinates = coordinatesOf(loadingCurvePath(plot));
    const first = coordinates[0];
    const last = coordinates.at(-1);

    expect(first).toEqual([plot.left, plot.bottom]);
    expect(last).toEqual([plot.right, plot.bottom]);
  });

  it.each(plots)('keeps every coordinate inside %s', (_name, plot) => {
    const coordinates = coordinatesOf(loadingCurvePath(plot));

    const outside = coordinates.filter(
      ([x, y]) => y < plot.top || y > plot.bottom || x < plot.left || x > plot.right,
    );

    expect(outside).toEqual([]);
  });

  it.each(plots)('rises well clear of the baseline of %s', (_name, plot) => {
    // Without this the two cases above are satisfied by a flat line along the
    // bottom of the plot, which is a legal path and no loading state at all.
    const highest = Math.min(...coordinatesOf(loadingCurvePath(plot)).map(([, y]) => y));

    expect(highest).toBeLessThan(plot.bottom - (plot.bottom - plot.top) / 2);
  });
});
