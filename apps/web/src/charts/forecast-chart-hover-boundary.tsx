import {
  useMemo,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { CHART_VIEW_BOX_HEIGHT } from './chart-geometry';
import { hoverKeyAction, pointerSample, useChartHover } from './chart-hover-input';
import {
  overlayReadingAt,
  type ChartOverlayColumn,
  type ChartOverlayReading,
  type ChartScale,
  type ForecastChartPoint,
} from './chart-series';
import { ForecastChartHoverLayer, readoutText } from './forecast-chart-hover';

/**
 * Where the chart's hover state lives — and the reason it no longer lives in
 * `ForecastChart` itself.
 *
 * Moving the tooltip is a change to one `transform`. Everything else on the
 * figure is the drawing it already was a frame ago. But state re-renders the
 * component holding it, so while `useChartHover` sat in `ForecastChart`'s body
 * every committed pointer frame — one per `POINTER_FRAME_MS`
 * (`chart-hover-input.ts`) — re-ran the whole figure to move that one panel:
 * five mark generators, both axes, the legend, and every row of the table twin.
 * React reconciled all of it to no DOM change, so nothing looked wrong; the
 * cost was element construction and reconciliation on a surface a reader hovers
 * deliberately (`docs/tech-debt.md`, 2026-08-09; #331).
 *
 * So the state moved down to the elements that actually read it, which is this
 * component: the `<svg>` the pointer and the keyboard land on, the hover layer,
 * and the spoken readout beneath. That entry rules it **one** decision about
 * where the boundary belongs rather than three memos bolted onto the marks, the
 * legend and the table — and this file is where the decision came out.
 *
 * **The chrome arrives as `children`, already built.** `ForecastChart` composes
 * the grid, the marks and the axes exactly as it always did and hands them down
 * as elements rather than as functions to call. Two things follow, and only
 * together do they make the saving: `ForecastChart`'s body no longer runs on a
 * hover frame, so those producers are simply never called; and this component's
 * own re-render walks straight past the elements it was handed, because their
 * references have not changed and React bails out of an unchanged child
 * (`dashboard/FleetPanel.memo.test.tsx` documents that bailout and relies on
 * it). Nothing here is memoised to achieve that — the boundary *is* the
 * mechanism, which is why adding a memo to a mark would be answering a question
 * this file has already answered. `forecast-chart-render-boundary.test.tsx`
 * counts the producers across a sweep and holds it.
 *
 * The division of labour around it is unchanged. Which sample an input selected
 * and how often the panel may move are `chart-hover-input.ts`'s; drawing the
 * crosshair and the panel is `forecast-chart-hover.tsx`'s; what the plot looks
 * like underneath is `ForecastChart`'s. This file is the seam, named after the
 * boundary it draws rather than after anything on screen.
 */

export interface ForecastChartHoverBoundaryProps {
  readonly points: readonly ForecastChartPoint[];
  readonly ariaLabel: string;
  /** View-box width — what `pointerSample` converts client x into. */
  readonly width: number;
  readonly scale: ChartScale;
  readonly spanHours: number;
  /** Required-and-nullable, per `ForecastChartHoverLayerProps`' precedent. */
  readonly overlay: ChartOverlayColumn | undefined;
  /** The static chrome — grid, marks, axes — built once by `ForecastChart`. */
  readonly children: ReactNode;
}

export const ForecastChartHoverBoundary = (
  props: ForecastChartHoverBoundaryProps,
): ReactElement => {
  const { ariaLabel, children, overlay, points, scale, spanHours, width } = props;
  const svgRef = useRef<SVGSVGElement>(null);
  const hover = useChartHover();
  const { activeIndex } = hover;
  const activePoint = activeIndex === null ? undefined : points[activeIndex];
  const overlayReading = useMemo<ChartOverlayReading | undefined>(
    () => (activeIndex === null ? undefined : overlayReadingAt(overlay, activeIndex)),
    [overlay, activeIndex],
  );

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
    <>
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
        aria-label={ariaLabel}
        tabIndex={0}
        onFocus={readAtFocus}
        onBlur={clearReadout}
        onKeyDown={readAtKey}
      >
        {children}
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
    </>
  );
};
