import { area, curveMonotoneX, line } from 'd3-shape';
import { spanHoursBetween, xForIndex, yForKw, type PlotRect } from './chart-geometry';

/**
 * The chart's data model and the string-and-number layer beneath its JSX: point
 * lookups, contiguous-run detection, and the SVG `d` attributes that carry a
 * series. Pure — no React, no DOM — so the arithmetic that decides what gets
 * drawn is separable from the elements that draw it (`structure.md` rule 4).
 *
 * **The path strings are d3-shape's, the gaps are ours.** `d3-shape` is asked
 * for one thing — the curve through a run of points — and nothing else: it never
 * sees the series, the nulls, or the runs, because `contiguousRuns` below has
 * already cut the series into pieces that are all ink. Each run becomes its own
 * path, so `line.defined()` has no gap left to be told about and the rule that a
 * gap is never bridged stays where it was rather than moving into a library
 * callback (`docs/design/chart-treatment.md`).
 */

export interface ForecastChartBand {
  readonly p10Kw: number;
  readonly p90Kw: number;
}

export interface ForecastChartPoint {
  readonly validTimeIso: string;
  /**
   * `null` where the hour carries no forecast at all.
   *
   * Nullable since #264, and the reason is a real shape rather than defensive
   * typing: a chart whose x-domain is the union of forecast hours and actual
   * hours (`dashboard/fleet-series.ts`) has hours behind the horizon that were
   * measured and never forecast. The median then breaks at those hours exactly
   * as the actuals break past the horizon — a gap, never a bridge and never a
   * zero, because both would draw a forecast nobody made.
   */
  readonly medianKw: number | null;
  /** Absent — the key omitted, never `undefined` — for a point-estimate forecast. */
  readonly band?: ForecastChartBand;
  /** `null` where no measurement exists: past the horizon, or a gap inside it. */
  readonly actualKw: number | null;
}

/** One hour of a series drawn alongside the forecast, in the overlay's own time base. */
export interface ChartOverlayPoint {
  readonly validTimeIso: string;
  /** `null` where the overlay has nothing for the hour — a gap, never a zero. */
  readonly kw: number | null;
}

/** A whole overlay series, named by the label its legend row and table column carry. */
export interface ChartOverlaySeries {
  readonly label: string;
  readonly points: readonly ChartOverlayPoint[];
}

/**
 * An overlay already resolved onto the main series' x-domain: one slot per
 * sample, in sample order, so every consumer reads it with the index it is
 * already holding rather than re-joining on a timestamp.
 */
export interface ChartOverlayColumn {
  readonly label: string;
  readonly values: readonly (number | null)[];
}

/** One sample of an overlay — what the tooltip draws and the readout speaks. */
export interface ChartOverlayReading {
  readonly label: string;
  readonly kw: number | null;
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
const MISSING_VALUE = '—';

export const medianAt = (points: readonly ForecastChartPoint[], index: number): number =>
  points[index]?.medianKw ?? 0;

export const p10At = (points: readonly ForecastChartPoint[], index: number): number =>
  points[index]?.band?.p10Kw ?? 0;

export const p90At = (points: readonly ForecastChartPoint[], index: number): number =>
  points[index]?.band?.p90Kw ?? 0;

export const actualAt = (points: readonly ForecastChartPoint[], index: number): number =>
  points[index]?.actualKw ?? 0;

export const overlayAt = (values: readonly (number | null)[], index: number): number =>
  values[index] ?? 0;

/**
 * The overlay's value at each sample of the main series.
 *
 * The main series' `validTimeIso` order is the x-domain, and an overlay hour
 * outside it is dropped: the chart has nowhere to put a column the series it is
 * drawn over does not have.
 *
 * That used to be stated as the same rule `joinFleetSeries` followed, and it is
 * deliberately no longer cited that way. #264 gave the fleet's join a *union*
 * x-domain — the chart's own hours are now the union of what was forecast and
 * what was measured — so the rule here is the narrower one it always actually
 * was: an overlay is resolved onto a domain somebody else decided, and it never
 * widens it. What decides that domain is the caller's business.
 *
 * An hour the overlay does not cover — and an hour it covers with `null` — is
 * `null` here, so the mark breaks at it rather than being drawn at a value
 * nobody supplied.
 */
export const overlayValuesByIndex = (
  points: readonly ForecastChartPoint[],
  overlay: ChartOverlaySeries,
): readonly (number | null)[] => {
  const kwByHour = new Map<string, number | null>(
    overlay.points.map((point) => [point.validTimeIso, point.kw]),
  );
  return points.map((point) => kwByHour.get(point.validTimeIso) ?? null);
};

/** The overlay's row at one sample, or nothing at all where there is no overlay. */
export const overlayReadingAt = (
  overlay: ChartOverlayColumn | undefined,
  index: number,
): ChartOverlayReading | undefined =>
  overlay === undefined ? undefined : { label: overlay.label, kw: overlay.values[index] ?? null };

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
      Math.max(highest, point.medianKw ?? 0, point.band?.p90Kw ?? 0, point.actualKw ?? 0),
    0,
  );

/**
 * The tallest overlay value, so a series that runs above the forecast still
 * lands inside the plot. Without it the axis would be scaled to the forecast
 * alone and the overlay would be drawn off the top — a mark outside the plot is
 * a value the reader cannot see, which is worse than a taller axis.
 */
export const highestOverlayKw = (values: readonly (number | null)[]): number =>
  values.reduce<number>((highest, value) => Math.max(highest, value ?? 0), 0);

export const seriesSpanHours = (points: readonly ForecastChartPoint[]): number => {
  const first = points[0];
  const last = points.at(-1);
  return first === undefined || last === undefined
    ? 0
    : spanHoursBetween(first.validTimeIso, last.validTimeIso);
};

/** One plotted sample in SVG user units — the space `PlotRect` is expressed in. */
interface PlotVertex {
  readonly x: number;
  readonly y: number;
}

/** Where a band's two edges sit at one sample, in those same units. */
interface BandColumn {
  readonly x: number;
  /** P90: the top edge, which the area sweeps out along first. */
  readonly upperY: number;
  /** P10: the bottom edge, swept back along in reverse and then closed. */
  readonly lowerY: number;
}

/**
 * The one curve every mark on the plot is drawn with. Why it is monotone rather
 * than any other smoothing — and what that buys a reader — is the treatment's
 * ("Median forecast and actuals", `docs/design/chart-treatment.md`); what
 * matters here is that there is exactly one of it, which is what makes the
 * band's edges and the stroked bounds coincide by construction rather than by
 * two builders agreeing.
 *
 * Coordinates are rounded by d3-path's own default rather than by anything here
 * — a precision this module has no basis to pick better than the library that
 * emits the string.
 */
const curvedLine = line<PlotVertex>()
  .x((vertex) => vertex.x)
  .y((vertex) => vertex.y)
  .curve(curveMonotoneX);

/**
 * One closed shape per run: the P90 edge left to right, the P10 edge back again,
 * and a `Z`. Filled and never stroked, so the vertical closing edges — plot
 * boundaries, not data — stay invisible while the two bounds get their own
 * stroked paths.
 */
const curvedBand = area<BandColumn>()
  .x((column) => column.x)
  .y0((column) => column.lowerY)
  .y1((column) => column.upperY)
  .curve(curveMonotoneX);

/**
 * The `d` for one run of a series. An empty run has no path at all rather than a
 * degenerate one — d3 answers `null` for it, and `''` is how SVG spells the same
 * thing.
 */
export const curvedLinePath = (
  indices: readonly number[],
  valueAt: (index: number) => number,
  scale: ChartScale,
): string =>
  curvedLine(
    indices.map((index) => ({
      x: xForIndex(index, scale.pointCount, scale.plot),
      y: yForKw(valueAt(index), scale.axisMaxKw, scale.plot),
    })),
  ) ?? '';

/** The `d` for one run of the band, between the two edges `curvedBand` names. */
export const curvedBandPath = (
  points: readonly ForecastChartPoint[],
  run: ChartRun,
  scale: ChartScale,
): string =>
  curvedBand(
    run.indices.map((index) => ({
      x: xForIndex(index, scale.pointCount, scale.plot),
      upperY: yForKw(p90At(points, index), scale.axisMaxKw, scale.plot),
      lowerY: yForKw(p10At(points, index), scale.axisMaxKw, scale.plot),
    })),
  ) ?? '';

/** Trailing zeros make a gridline label look like a precision it does not have. */
export const axisTickText = (kilowatts: number): string =>
  Number(kilowatts.toFixed(AXIS_LABEL_DECIMALS)).toString();

/** Table cells: a missing band bound and a missing measurement read the same. */
export const formatKw = (value: number | null | undefined): string =>
  value === null || value === undefined ? MISSING_VALUE : value.toFixed(VALUE_DECIMALS);
