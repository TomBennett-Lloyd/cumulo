import { render } from '@testing-library/react';
import { ForecastChart, type ChartOverlaySeries, type ForecastChartPoint } from './ForecastChart';

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

export const tableCells = (
  container: HTMLElement,
  rowIndex: number,
): readonly (string | null)[] => {
  const row = [...container.querySelectorAll('.forecast-chart-table tbody tr')][rowIndex];
  return [...(row?.querySelectorAll('td') ?? [])].map((cell) => cell.textContent);
};
