import { describe, expect, it } from 'vitest';
import { chartPlot, xForIndex, yForKw } from './chart-geometry';
import {
  curvedBandPath,
  curvedLinePath,
  highestOverlayKw,
  overlayReadingAt,
  overlayValuesByIndex,
  type ChartOverlaySeries,
  type ChartScale,
  type ForecastChartPoint,
} from './chart-series';

/**
 * The chart's data layer, tested as the pure arithmetic it is — no DOM, no
 * React. The rendered consequences of these values are `ForecastChart.test.tsx`
 * and its siblings; what is proved here is the join itself, which is where an
 * hour can silently acquire a value nobody supplied.
 */

const isoHour = (hour: number): string => `2026-07-30T${hour.toString().padStart(2, '0')}:00:00Z`;

/** A forecast series carrying nothing but its x-domain, which is all the join reads. */
const domain = (hours: readonly number[]): readonly ForecastChartPoint[] =>
  hours.map((hour) => ({ validTimeIso: isoHour(hour), medianKw: 4, actualKw: null }));

const overlayOf = (
  kwByHour: readonly (readonly [number, number | null])[],
): ChartOverlaySeries => ({
  label: 'Baseline',
  points: kwByHour.map(([hour, kw]) => ({ validTimeIso: isoHour(hour), kw })),
});

describe('overlayValuesByIndex', () => {
  it('puts every covered hour in the slot its timestamp holds in the main series', () => {
    const values = overlayValuesByIndex(
      domain([6, 9, 12]),
      overlayOf([
        [6, 1.5],
        [9, 2.5],
        [12, 3.5],
      ]),
    );

    expect(values).toStrictEqual([1.5, 2.5, 3.5]);
  });

  it('follows the main series order rather than the overlay’s own', () => {
    // The x-domain is the forecast's, so an overlay that arrives in another
    // order still lands under the hours it names.
    const values = overlayValuesByIndex(
      domain([6, 9, 12]),
      overlayOf([
        [12, 3.5],
        [6, 1.5],
        [9, 2.5],
      ]),
    );

    expect(values).toStrictEqual([1.5, 2.5, 3.5]);
  });

  it('leaves hours the overlay does not cover as gaps', () => {
    // The negative case, and the reason this function cannot fall back to a
    // number: a zero here would draw the overlay flat along the axis for two
    // hours it never spoke about, with exactly the confidence of the hours it
    // did (chart-treatment.md — a gap is never bridged, and never invented).
    const values = overlayValuesByIndex(
      domain([6, 9, 12, 15]),
      overlayOf([
        [6, 1.5],
        [15, 3.5],
      ]),
    );

    expect(values[1]).toBeNull();
    expect(values[2]).toBeNull();
    expect(values).toStrictEqual([1.5, null, null, 3.5]);
  });

  it('reads an hour the overlay covers with null as the same gap', () => {
    const values = overlayValuesByIndex(
      domain([6, 9]),
      overlayOf([
        [6, null],
        [9, 2.5],
      ]),
    );

    expect(values).toStrictEqual([null, 2.5]);
  });

  it('drops overlay hours the main series does not carry', () => {
    // Inventing a column for them would imply a forecast that was never made.
    const values = overlayValuesByIndex(
      domain([9]),
      overlayOf([
        [6, 1.5],
        [9, 2.5],
        [12, 3.5],
      ]),
    );

    expect(values).toStrictEqual([2.5]);
  });

  it('answers an empty column for an empty main series', () => {
    expect(overlayValuesByIndex([], overlayOf([[6, 1.5]]))).toStrictEqual([]);
  });
});

describe('highestOverlayKw', () => {
  it('ignores gaps when finding the tallest overlay value', () => {
    expect(highestOverlayKw([1.5, null, 9.25, null])).toBe(9.25);
  });

  it('answers zero for an overlay with nothing in it', () => {
    expect(highestOverlayKw([])).toBe(0);
    expect(highestOverlayKw([null, null])).toBe(0);
  });
});

/*
 * The path builders (#284 D8).
 *
 * Every mark on the plot is a monotone curve through its run's samples, and what
 * these cases hold is the two ends of that: the curve is real where there is
 * curvature to draw, and it is not invented where there is none. The rendered
 * consequences — which element carries which `d`, and how many runs a gap
 * produces — belong to `ForecastChart.test.tsx` and its siblings.
 */

/**
 * A width chosen for arithmetic rather than for realism: `chartPlot(608)` puts
 * the plot's edges at 48 and 576, so runs of two and three samples land on whole
 * pixels. d3-path rounds the coordinates it emits, and a fixture whose samples
 * fell on a fractional step would be asserting that rounding instead of the
 * geometry underneath it.
 */
const CURVE_PLOT_WIDTH = 608;

/** 8 kW over a 128-unit plot, so whole kilowatts land on whole pixels too. */
const CURVE_AXIS_MAX_KW = 8;

const scaleOver = (pointCount: number): ChartScale => ({
  plot: chartPlot(CURVE_PLOT_WIDTH),
  axisMaxKw: CURVE_AXIS_MAX_KW,
  pointCount,
});

/** One expected coordinate, in the form d3 writes it: `x,y`. */
const vertexAt = (index: number, kilowatts: number, scale: ChartScale): string =>
  `${String(xForIndex(index, scale.pointCount, scale.plot))},${String(
    yForKw(kilowatts, scale.axisMaxKw, scale.plot),
  )}`;

/** A ramp: 0 kW, then 2, then 6 — enough curvature for the curve to show. */
const RAMP_KW: readonly number[] = [0, 2, 6];

const bandOf = (hour: number, p10Kw: number, p90Kw: number): ForecastChartPoint => ({
  validTimeIso: isoHour(hour),
  medianKw: (p10Kw + p90Kw) / 2,
  band: { p10Kw, p90Kw },
  actualKw: null,
});

describe('curvedLinePath', () => {
  it('curves through a run of three or more samples', () => {
    const scale = scaleOver(RAMP_KW.length);
    const path = curvedLinePath([0, 1, 2], (index) => RAMP_KW[index] ?? 0, scale);

    expect(path.startsWith(`M${vertexAt(0, 0, scale)}`)).toBe(true);
    expect(path).toContain('C');
    // The curve still lands on the samples: smoothing moves the ink between
    // them, never the hours themselves.
    expect(path.endsWith(vertexAt(2, 6, scale))).toBe(true);
  });

  it('draws a two-sample run as the straight segment between them', () => {
    // Two samples fix no curvature, so anything but a segment here would be
    // shape the data does not contain.
    const scale = scaleOver(2);
    const path = curvedLinePath([0, 1], (index) => (index === 0 ? 2 : 6), scale);

    expect(path).toBe(`M${vertexAt(0, 2, scale)}L${vertexAt(1, 6, scale)}`);
    expect(path).not.toContain('C');
  });

  it('draws nothing at all for a run with no samples in it', () => {
    expect(curvedLinePath([], () => 0, scaleOver(0))).toBe('');
  });
});

describe('curvedBandPath', () => {
  it('closes one shape out along P90 and back along P10', () => {
    const scale = scaleOver(3);
    const path = curvedBandPath(
      [bandOf(6, 1, 3), bandOf(9, 2, 6), bandOf(12, 3, 7)],
      { startIndex: 0, indices: [0, 1, 2] },
      scale,
    );

    // Out along the upper edge first, so the shape starts at the first P90.
    expect(path.startsWith(`M${vertexAt(0, 3, scale)}`)).toBe(true);
    // It turns at the last sample, dropping straight to that hour's P10 — the
    // closing edges are plot boundaries rather than data, which is why the band
    // is filled and never stroked.
    expect(path).toContain(`L${vertexAt(2, 3, scale)}`);
    // …and closes back at the first sample's P10. Without the `Z` the fill would
    // be a shape the renderer had to guess the last edge of.
    expect(path.endsWith(`${vertexAt(0, 1, scale)}Z`)).toBe(true);
  });
});

describe('overlayReadingAt', () => {
  it('has no reading at all where the chart carries no overlay', () => {
    expect(overlayReadingAt(undefined, 0)).toBeUndefined();
  });

  it('carries the label with the value, so a row can name itself', () => {
    expect(overlayReadingAt({ label: 'Baseline', values: [1.5, null] }, 0)).toStrictEqual({
      label: 'Baseline',
      kw: 1.5,
    });
  });

  it('reads a gap, and an index past the end, as a null value under the label', () => {
    const column = { label: 'Baseline', values: [1.5, null] };

    expect(overlayReadingAt(column, 1)).toStrictEqual({ label: 'Baseline', kw: null });
    expect(overlayReadingAt(column, 9)).toStrictEqual({ label: 'Baseline', kw: null });
  });
});
