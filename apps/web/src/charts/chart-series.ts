import { spanHoursBetween, xForIndex, yForKw, type PlotRect } from './chart-geometry';

/**
 * The chart's data model and the string-and-number layer beneath its JSX: point
 * lookups, contiguous-run detection, and the SVG `points` attributes that carry
 * a series. Pure — no React, no DOM — so the arithmetic that decides what gets
 * drawn is separable from the elements that draw it (`structure.md` rule 4).
 */

export interface ForecastChartBand {
  readonly p10Kw: number;
  readonly p90Kw: number;
}

export interface ForecastChartPoint {
  readonly validTimeIso: string;
  readonly medianKw: number;
  /** Absent — the key omitted, never `undefined` — for a point-estimate forecast. */
  readonly band?: ForecastChartBand;
  /** `null` where no measurement exists: past the horizon, or a gap inside it. */
  readonly actualKw: number | null;
}

/** Everything the kW → coordinate mapping needs, threaded as one named value. */
export interface ChartScale {
  readonly plot: PlotRect;
  readonly axisMaxKw: number;
  readonly pointCount: number;
}

/** A maximal run of adjacent sample indices that all carry the same kind of value. */
export interface ChartRun {
  readonly startIndex: number;
  readonly indices: readonly number[];
}

const VALUE_DECIMALS = 1;
const AXIS_LABEL_DECIMALS = 2;
const COORDINATE_DECIMALS = 1;
const MISSING_VALUE = '—';

const svgPoint = (x: number, y: number): string =>
  `${x.toFixed(COORDINATE_DECIMALS)},${y.toFixed(COORDINATE_DECIMALS)}`;

export const medianAt = (points: readonly ForecastChartPoint[], index: number): number =>
  points[index]?.medianKw ?? 0;

export const p10At = (points: readonly ForecastChartPoint[], index: number): number =>
  points[index]?.band?.p10Kw ?? 0;

export const p90At = (points: readonly ForecastChartPoint[], index: number): number =>
  points[index]?.band?.p90Kw ?? 0;

export const actualAt = (points: readonly ForecastChartPoint[], index: number): number =>
  points[index]?.actualKw ?? 0;

export const allIndices = (count: number): readonly number[] =>
  Array.from({ length: count }, (_unused, index) => index);

/**
 * Maximal runs of adjacent indices satisfying `includes`. This is what keeps a
 * gap a gap: each run becomes its own path, so no mark spans the hole.
 */
export const contiguousRuns = (
  count: number,
  includes: (index: number) => boolean,
): readonly ChartRun[] => {
  const runs: { startIndex: number; indices: number[] }[] = [];
  for (let index = 0; index < count; index += 1) {
    if (!includes(index)) {
      continue;
    }
    const open = runs.at(-1);
    if (open?.indices.at(-1) === index - 1) {
      open.indices.push(index);
    } else {
      runs.push({ startIndex: index, indices: [index] });
    }
  }
  return runs;
};

/** Tallest value any mark will reach — band top, median, or measurement. */
export const highestValueKw = (points: readonly ForecastChartPoint[]): number =>
  points.reduce(
    (highest, point) =>
      Math.max(highest, point.medianKw, point.band?.p90Kw ?? 0, point.actualKw ?? 0),
    0,
  );

export const seriesSpanHours = (points: readonly ForecastChartPoint[]): number => {
  const first = points[0];
  const last = points.at(-1);
  return first === undefined || last === undefined
    ? 0
    : spanHoursBetween(first.validTimeIso, last.validTimeIso);
};

export const polylinePoints = (
  indices: readonly number[],
  valueAt: (index: number) => number,
  scale: ChartScale,
): string =>
  indices
    .map((index) =>
      svgPoint(
        xForIndex(index, scale.pointCount, scale.plot),
        yForKw(valueAt(index), scale.axisMaxKw, scale.plot),
      ),
    )
    .join(' ');

/**
 * One closed shape per run: the P90 bounds left to right, then the P10 bounds
 * back again. Filled and never stroked, so the vertical closing edges — plot
 * boundaries, not data — stay invisible while the two bounds get their own
 * stroked polylines.
 */
export const bandPolygonPoints = (
  points: readonly ForecastChartPoint[],
  run: ChartRun,
  scale: ChartScale,
): string => {
  const upper = polylinePoints(run.indices, (index) => p90At(points, index), scale);
  const lower = polylinePoints([...run.indices].reverse(), (index) => p10At(points, index), scale);
  return `${upper} ${lower}`;
};

/** Trailing zeros make a gridline label look like a precision it does not have. */
export const axisTickText = (kilowatts: number): string =>
  Number(kilowatts.toFixed(AXIS_LABEL_DECIMALS)).toString();

/** Table cells: a missing band bound and a missing measurement read the same. */
export const formatKw = (value: number | null | undefined): string =>
  value === null || value === undefined ? MISSING_VALUE : value.toFixed(VALUE_DECIMALS);
