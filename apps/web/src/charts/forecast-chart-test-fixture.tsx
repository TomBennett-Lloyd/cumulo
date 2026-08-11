import { render } from '@testing-library/react';
import { chartPlot, type PlotRect } from './chart-geometry';
import { ForecastChart, type ChartOverlaySeries, type ForecastChartPoint } from './ForecastChart';
import { DEFAULT_CHART_WIDTH } from './use-chart-width';

/**
 * Shared fixtures and DOM lookups for the `ForecastChart` suites. The static
 * chart and its hover layer are tested in separate files (`structure.md` rule
 * 4), but they exercise the same component over the same series — so the
 * builders live here rather than in two copies that would have to be changed
 * together to stay meaningful (`structure.md` rule 7).
 */

/** Exported so an overlay can be built in the same time base the points use. */
export const isoHour = (hour: number): string =>
  `2026-07-30T${hour.toString().padStart(2, '0')}:00:00Z`;

export const banded = (
  hour: number,
  medianKw: number,
  actualKw: number | null,
): ForecastChartPoint => ({
  validTimeIso: isoHour(hour),
  medianKw,
  band: { p10Kw: medianKw - 1, p90Kw: medianKw + 1 },
  actualKw,
});

/** No `band` key at all — a point estimate, not a band of `undefined`. */
export const bare = (
  hour: number,
  medianKw: number,
  actualKw: number | null,
): ForecastChartPoint => ({
  validTimeIso: isoHour(hour),
  medianKw,
  actualKw,
});

/** Five samples, banded throughout, measured up to a horizon at index 2. */
export const SERIES: readonly ForecastChartPoint[] = [
  banded(6, 1, 0.9),
  banded(9, 4, 3.8),
  banded(12, 6, 5.9),
  banded(15, 5, null),
  banded(18, 2, null),
];

/** Shared by both render helpers so the two cannot label the same chart differently. */
const ARIA_LABEL = 'Sunnyside Farm: forecast and actuals';
const TABLE_CAPTION = 'Table view — Sunnyside Farm, kW';

/**
 * The chart with the `overlay` prop genuinely absent, not passed as
 * `undefined`. Every suite renders through this, so the no-overlay path stays
 * the one the whole existing suite exercises (`testing.md` rule 9).
 */
export const renderChart = (points: readonly ForecastChartPoint[]): HTMLElement => {
  const { container } = render(
    <ForecastChart points={points} ariaLabel={ARIA_LABEL} tableCaption={TABLE_CAPTION} />,
  );
  return container;
};

export const renderChartWithOverlay = (
  points: readonly ForecastChartPoint[],
  overlay: ChartOverlaySeries,
): HTMLElement => {
  const { container } = render(
    <ForecastChart
      points={points}
      ariaLabel={ARIA_LABEL}
      tableCaption={TABLE_CAPTION}
      overlay={overlay}
    />,
  );
  return container;
};

/**
 * The plot every jsdom suite's coordinates are in.
 *
 * Two guards hold that width, and `use-chart-width.ts` states both: the initial
 * measurement is taken but discarded, because jsdom lays every box out at zero
 * and a zero reading is refused; and no later resize replaces it, because jsdom
 * ships no `ResizeObserver`. So every chart rendered under `src/` draws at
 * `DEFAULT_CHART_WIDTH` and this is the rect it draws into. Derived rather than
 * written out: the plot is the component's own arithmetic at a known width, and
 * a copy of the four numbers here would be a second definition to keep true.
 */
export const JSDOM_PLOT: PlotRect = chartPlot(DEFAULT_CHART_WIDTH);

/** Deliberately not 1:1 with the view box — see `stubRenderedSize`. */
export const RENDERED_BOUNDS = { left: 100, top: 50, width: 1280, height: 400 };

/**
 * The rendered box the hover layer divides by. jsdom lays everything out at
 * zero, so the size comes from here — at 2x the view box the chart draws at
 * under jsdom, which is what keeps the conversion in `pointerSample` provable
 * rather than accidentally right at 1:1. The chart itself is 1:1 with its
 * *measured* width in a browser (#284 D15); this stub is a rendered box that was
 * never measured, which is exactly the case that conversion still has to handle.
 */
export const stubRenderedSize = (svg: SVGSVGElement): void => {
  const bounds: DOMRect = {
    x: RENDERED_BOUNDS.left,
    y: RENDERED_BOUNDS.top,
    left: RENDERED_BOUNDS.left,
    top: RENDERED_BOUNDS.top,
    width: RENDERED_BOUNDS.width,
    height: RENDERED_BOUNDS.height,
    right: RENDERED_BOUNDS.left + RENDERED_BOUNDS.width,
    bottom: RENDERED_BOUNDS.top + RENDERED_BOUNDS.height,
    toJSON: () => ({}),
  };
  Object.defineProperty(svg, 'getBoundingClientRect', { value: () => bounds });
};

/** The client x that puts the pointer at `viewBoxX` of the rendered chart. */
export const clientXFor = (viewBoxX: number): number =>
  RENDERED_BOUNDS.left + viewBoxX * (RENDERED_BOUNDS.width / DEFAULT_CHART_WIDTH);

/** Scoped to the plot, so legend swatches wearing the same classes stay out. */
export const marks = (container: HTMLElement, selector: string): readonly Element[] => [
  ...container.querySelectorAll(`.forecast-chart > ${selector}`),
];

export const requireMark = (container: HTMLElement, selector: string): Element => {
  const found = marks(container, selector)[0];
  if (found === undefined) {
    throw new Error(`no mark matching ${selector}`);
  }
  return found;
};

export const requireSvg = (container: HTMLElement): SVGSVGElement => {
  const svg = container.querySelector<SVGSVGElement>('svg.forecast-chart');
  if (svg === null) {
    throw new Error('no chart svg');
  }
  return svg;
};

/**
 * The numbers the tooltip is showing, in document order. `textContent` is
 * `string | null` and the type says so: a cell that rendered empty is a real
 * failure to assert against, not something to paper over with a cast.
 */
export const tooltipValues = (container: HTMLElement): readonly (string | null)[] =>
  [...container.querySelectorAll('.forecast-chart-tooltip-value')].map((cell) => cell.textContent);

/** Everything the tooltip is saying, flattened — `null` where it is not drawn. */
export const tooltipText = (container: HTMLElement): string | null =>
  container.querySelector('.forecast-chart-tooltip')?.textContent ?? null;

/** The panel's left edge, read back out of the group's `translate`. */
export const tooltipAnchor = (container: HTMLElement): number => {
  const transform = container.querySelector('.forecast-chart-tooltip')?.getAttribute('transform');
  const anchor = /translate\((?<x>[-\d.]+)/u.exec(transform ?? '')?.groups?.x;
  return anchor === undefined ? Number.NaN : Number(anchor);
};

/** One part of the drawn panel, by selector inside the tooltip group. */
export const requireTooltipPart = (container: HTMLElement, selector: string): Element => {
  const part = container.querySelector(`.forecast-chart-tooltip ${selector}`);
  if (part === null) {
    throw new Error(`no tooltip part matching ${selector}`);
  }
  return part;
};

export const attributeNumber = (element: Element, name: string): number =>
  Number(element.getAttribute(name));

/**
 * How many samples a mark is drawn over.
 *
 * The marks are monotone curves since #284 D8, so a path carries two control
 * points beside every anchor it visits (`chart-series.ts`) — counting
 * coordinate pairs would be counting curvature. Every `M`, `L` and `C` command
 * lands on exactly one anchor and `Z` lands on none, so the commands are the
 * count. A run of n samples is one `M` and n-1 segments either way, which is
 * what makes this the same number the `points` attribute used to give.
 */
export const anchorCount = (mark: Element): number =>
  (mark.getAttribute('d') ?? '').replaceAll(/[^MLC]/gu, '').length;

/**
 * Every coordinate the mark's path names, control points included — so an
 * assertion about where the ink goes covers the curve between the samples and
 * not only the samples. Monotone interpolation keeps a segment's control points
 * inside the box its two anchors span, which is why this is a fair bound.
 */
export const pathCoordinates = (mark: Element): readonly { x: number; y: number }[] =>
  [...(mark.getAttribute('d') ?? '').matchAll(/(?<x>-?[\d.]+),(?<y>-?[\d.]+)/gu)].map((match) => ({
    x: Number(match.groups?.x),
    y: Number(match.groups?.y),
  }));

export const tableCells = (
  container: HTMLElement,
  rowIndex: number,
): readonly (string | null)[] => {
  const row = [...container.querySelectorAll('.forecast-chart-table tbody tr')][rowIndex];
  return [...(row?.querySelectorAll('td') ?? [])].map((cell) => cell.textContent);
};
