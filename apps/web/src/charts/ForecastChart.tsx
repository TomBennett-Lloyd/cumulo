import {
  useMemo,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react';
import { CHART_VIEW_BOX_HEIGHT, chartPlot, niceAxisMax } from './chart-geometry';
import {
  contiguousRuns,
  highestOverlayKw,
  highestValueKw,
  overlayReadingAt,
  overlayValuesByIndex,
  seriesSpanHours,
  type ChartOverlayColumn,
  type ChartOverlayReading,
  type ChartOverlaySeries,
  type ChartScale,
  type ForecastChartPoint,
} from './chart-series';
import { hoverKeyAction, pointerSample, useChartHover } from './chart-hover-input';
import {
  axisTitleElements,
  gridElements,
  horizonElements,
  xAxisElements,
} from './forecast-chart-axes';
import { ForecastChartHoverLayer, readoutText } from './forecast-chart-hover';
import { forecastChartLegend } from './forecast-chart-legend';
import {
  actualsElements,
  bandElements,
  boundElements,
  medianElements,
  overlayElements,
} from './forecast-chart-marks';
import { forecastChartTable } from './forecast-chart-table';
import { useChartWidth } from './use-chart-width';

/**
 * The forecast chart, drawn to `docs/design/chart-treatment.md`: a P10–P90 band
 * as a 10% wash with hairline bounds, the median on top, measured actuals in
 * near-ink last, a horizon rule where the measurements stop, an always-present
 * legend, and the table twin the treatment requires of every chart.
 *
 * Presentational only — no fetching, no domain imports. Points arrive as plain
 * ISO strings and kW numbers, which branded `UtcIsoTimestamp` values satisfy.
 *
 * Two rules from the token preview carry over: no literal colours or sizes
 * (every visual value is a class consuming a token, in `charts.css`), and the
 * numbers below are geometry — SVG user units and kW — not styling.
 *
 * **Gaps break lines, they are never bridged.** A missing band or a missing
 * measurement inside the series is a partial result and reads as one: band and
 * actuals are drawn once per contiguous run, so a straight segment is never
 * painted across a gap to imply a value that was never modelled or measured
 * (`error-handling.md` rule 5; `docs/tech-debt.md`, 2026-07-31). A run left
 * with a single sample has no path to stroke and becomes a marker instead of
 * disappearing — `forecast-chart-marks.tsx` holds that rule and its reasoning.
 *
 * **An overlay is one more series, not a second chart.** The optional `overlay`
 * prop puts a second series on the same kW axis in slot 2 — the treatment's
 * fixed categorical order, with slot 1 reserved for the forecast everywhere in
 * the product. One axis, never two: a second y-scale would invent a correlation
 * the data does not contain (`docs/design/chart-treatment.md`). It is joined
 * onto this series' x-domain once and then flows to the mark, the legend row,
 * the table column and the readout from that one join.
 *
 * **The readout has one source of truth.** Pointer and keyboard both settle on
 * an `activeIndex`, and `forecast-chart-hover.tsx` draws whatever that index
 * says. There is no separate keyboard rendering path to drift from the hover
 * one, which is what the treatment's "keyboard focus shows exactly what hover
 * shows" costs when it is designed in rather than retrofitted. The pointer
 * carries one thing the keyboard cannot — a continuous position, which the
 * panel follows and the crosshair ignores (#284 D7) — and it is a second field
 * beside the index rather than a second selection, so neither route can end up
 * reading a different sample.
 *
 * **The chart is drawn 1:1 with the width it is rendered at.** `useChartWidth`
 * measures the figure and the view box takes that width, so one SVG user unit
 * is one pixel and the chrome stops scaling with the panel — an axis label is
 * the same size here as everywhere else on the page. The height does not follow:
 * `CHART_VIEW_BOX_HEIGHT` is an owned constant, because a kW axis that rescaled
 * on every resize would be a different chart at every window size.
 *
 * This file is composition and nothing else. The plot's chrome, its data marks,
 * the hover layer and the figure's furniture sit beside it —
 * `forecast-chart-axes.tsx`, `-marks.tsx`, `-hover.tsx`, `-legend.tsx`,
 * `-table.tsx` — each a piece of the treatment named after the piece it draws,
 * and each well inside `structure.md` rule 4's ceiling.
 */

export type {
  ChartOverlayPoint,
  ChartOverlaySeries,
  ForecastChartBand,
  ForecastChartPoint,
} from './chart-series';

export interface ForecastChartProps {
  /** May be empty — the chart then draws bare chrome; sorted ascending by `validTimeIso`. */
  readonly points: readonly ForecastChartPoint[];
  readonly ariaLabel: string;
  readonly tableCaption: string;
  /**
   * One more series on the same kW axis, in its own time base — the chart joins
   * it onto `points`' x-domain. Omitted, the chart renders exactly what it
   * rendered before overlays existed: no mark, no legend row, no table column,
   * and nothing in the readout.
   */
  readonly overlay?: ChartOverlaySeries;
}

export const ForecastChart = (props: ForecastChartProps): ReactElement => {
  const { points } = props;
  const figureRef = useRef<HTMLElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  // The figure rather than the svg: the svg's own width is `100%` of this box
  // (`charts.css`), so measuring the container is measuring the chart without
  // asking an element about a size this render is about to give it.
  const width = useChartWidth(figureRef);
  const hover = useChartHover();
  const { activeIndex } = hover;
  // Joined once and read by every consumer below, so the mark, the table column
  // and the readout can never disagree about what the overlay says at an hour.
  //
  // Memoised for identity rather than for speed. The tooltip panel follows the
  // pointer at the rate `POINTER_FRAME_MS` sets (`chart-hover-input.ts`, #284
  // D7) and its content is memoised against those frames — so a column, and the
  // reading taken from it, rebuilt on every render would hand that memo a new
  // object every frame and defeat it. The dependencies are the honest ones: a
  // new series, or a new x-domain to join it onto, really is a new join.
  const overlay = useMemo<ChartOverlayColumn | undefined>(
    () =>
      props.overlay === undefined
        ? undefined
        : { label: props.overlay.label, values: overlayValuesByIndex(points, props.overlay) },
    [props.overlay, points],
  );
  // An overlay running above the forecast would otherwise be drawn off the top
  // of the plot. With no overlay this is `highestValueKw` unchanged, which is
  // seeded at 0 and so cannot be lowered by the second argument.
  const peakKw = Math.max(
    highestValueKw(points),
    overlay === undefined ? 0 : highestOverlayKw(overlay.values),
  );
  const scale: ChartScale = {
    plot: chartPlot(width),
    axisMaxKw: niceAxisMax(peakKw),
    pointCount: points.length,
  };
  const spanHours = seriesSpanHours(points);
  const activePoint = activeIndex === null ? undefined : points[activeIndex];
  const overlayReading = useMemo<ChartOverlayReading | undefined>(
    () => (activeIndex === null ? undefined : overlayReadingAt(overlay, activeIndex)),
    [overlay, activeIndex],
  );
  const bandRuns = contiguousRuns(points.length, (index) => points[index]?.band !== undefined);
  // Three series, one rule: each is drawn once per contiguous run of hours it
  // actually has a value for. The median joined that rule in #264, when a union
  // x-domain gave it hours with no forecast on them.
  const medianRuns = contiguousRuns(points.length, (index) => points[index]?.medianKw != null);
  const actualRuns = contiguousRuns(points.length, (index) => points[index]?.actualKw != null);
  const lastMeasuredIndex = actualRuns.at(-1)?.indices.at(-1);

  const clearReadout = (): void => {
    hover.selectSample(null);
  };

  const readAtPointer = (event: ReactPointerEvent<SVGRectElement>): void => {
    hover.trackPointer(
      pointerSample({
        clientX: event.clientX,
        svg: svgRef.current,
        viewBoxWidth: width,
        scale,
      }),
    );
  };

  /** Focus opens the readout on the first sample; a live pointer readout stands. */
  const readAtFocus = (): void => {
    if (activeIndex === null) {
      hover.selectSample(0);
    }
  };

  const readAtKey = (event: ReactKeyboardEvent<SVGSVGElement>): void => {
    const action = hoverKeyAction({ key: event.key, activeIndex, pointCount: points.length });
    if (action.kind === 'ignored') {
      return;
    }
    // Only keys the chart actually acts on lose their default — arrows must not
    // scroll the page out from under a focused chart, and Tab must still tab.
    event.preventDefault();
    hover.selectSample(action.kind === 'cleared' ? null : action.activeIndex);
  };

  return (
    <figure className="forecast-chart-figure" ref={figureRef}>
      {/* Draw order is back to front: grid → band → bounds → horizon → median →
          overlay → actuals → marker. Actuals are drawn last of the data and win
          every overlap — an added series never covers the measurement — and the
          hover chrome and its pointer target sit above all of it. */}
      <svg
        ref={svgRef}
        className="forecast-chart"
        viewBox={`0 0 ${String(width)} ${String(CHART_VIEW_BOX_HEIGHT)}`}
        /* Pinned, and not left to the aspect ratio. Once a measurement lands the
           two agree — the view box is the rendered width, so `height: auto`
           would resolve to this anyway — but on the frame before it, the view
           box is still `DEFAULT_CHART_WIDTH` wide in a wider column, and an
           unpinned height would draw that first frame tall and then collapse it.
           Stating the height makes the pre-measurement frame a narrower chart
           centred in its box rather than a vertical jump. */
        height={CHART_VIEW_BOX_HEIGHT}
        role="img"
        aria-label={props.ariaLabel}
        tabIndex={0}
        onFocus={readAtFocus}
        onBlur={clearReadout}
        onKeyDown={readAtKey}
      >
        {gridElements(scale)}
        {bandElements(points, bandRuns, scale)}
        {boundElements(points, bandRuns, scale)}
        {lastMeasuredIndex === undefined ? null : horizonElements(lastMeasuredIndex, scale)}
        {medianElements(points, medianRuns, scale)}
        {overlay === undefined ? null : overlayElements(overlay.values, scale)}
        {actualsElements(points, actualRuns, scale, lastMeasuredIndex)}
        {xAxisElements(points, scale)}
        {axisTitleElements(scale.plot)}
        <ForecastChartHoverLayer
          points={points}
          activeIndex={activeIndex}
          pointerX={hover.pointerX}
          scale={scale}
          spanHours={spanHours}
          overlay={overlayReading}
        />
        {/* Last child, and the whole plot: the readout must never depend on the
            pointer hitting a 2px line. `charts.css` gives it the pointer-events
            it needs and no fill. */}
        <rect
          className="forecast-chart-pointer-target"
          x={scale.plot.left}
          y={scale.plot.top}
          width={scale.plot.right - scale.plot.left}
          height={scale.plot.bottom - scale.plot.top}
          onPointerMove={readAtPointer}
          onPointerLeave={clearReadout}
        />
      </svg>

      {/* The readout's only route to a screen reader. The svg above is a
          `role="img"` with one name, so its subtree — tooltip included — is
          collapsed to that label and the selected sample is never spoken from
          inside it. This region is mounted empty with the chart and filled only
          when a reader moves the selection, so every announcement is a real
          change rather than text that was already there (`react.md`). Both
          input routes feed it, because both set the same `activeIndex`. */}
      <p className="forecast-chart-readout" aria-live="polite">
        {activePoint === undefined ? '' : readoutText(activePoint, spanHours, overlayReading)}
      </p>

      {forecastChartLegend(overlay?.label)}
      {forecastChartTable({ points, spanHours, caption: props.tableCaption, overlay })}
    </figure>
  );
};
