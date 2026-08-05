import { describe, expect, it } from 'vitest';
import {
  highestOverlayKw,
  overlayReadingAt,
  overlayValuesByIndex,
  type ChartOverlaySeries,
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
