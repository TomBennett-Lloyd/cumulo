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
 * deliberately (#331, which measured it and now carries the reasoning the
 * tech-debt log held until the same ticket retired that entry).
 *
 * So the state moved down to the elements that actually read it, which is this
 * component: the `<svg>` the pointer and the keyboard land on, the hover layer,
 * and the spoken readout beneath. #331 rules it **one** decision about where
 * the boundary belongs rather than three memos bolted onto the marks, the
 * legend and the table — and this file is where the decision came out.
 *
 * **The chrome arrives as `children`, already built.** `ForecastChart` composes
 * the grid, the marks and the axes exactly as it always did and hands them down
 * as elements rather than as functions to call. Two things follow, and only
 * together do they make the saving: `ForecastChart`'s body no longer runs on a
 * hover frame, so those producers are simply never called; and this component's
 * own re-render walks straight past the elements it was handed, because their
 * references have not changed and React bails out of an unchanged child
 * (`dashboard/FleetPanel.memo.test.tsx` documents that bailout, and steps
 * around it deliberately — it re-renders its panel with a *fresh* element
 * carrying the same props, precisely so the bailout cannot be what satisfies
 * its assertion). Nothing here is memoised to achieve that — the boundary *is* the
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

  /**
   * A mouse leaving the figure clears the readout; a finger lifting off it does
   * not — #421's "a lifted finger keeps what it revealed".
   *
   * The two pointer types leave for opposite reasons, which is why one handler
   * cannot answer both. A mouse that has left is a reader who has moved on and
   * is still there to see the chart go quiet. A touch pointer *always* leaves,
   * at the end of every tap and every drag, because the finger is the pointer:
   * clearing on that event would undo the selection the tap just made, in the
   * same frame, and no touch reader could ever see a readout at all.
   *
   * So a tap has no leave event to dismiss it, and needs none — dismissal is the
   * existing blur path (`onBlur` below), which a tap anywhere else fires.
   */
  const clearReadoutForMouse = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (event.pointerType === 'mouse') {
      clearReadout();
    }
  };

  const readAtPointer = (event: ReactPointerEvent<SVGSVGElement>): void => {
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
           would resolve to this anyway — but before one lands the view box is
           still `DEFAULT_CHART_WIDTH` wide in a column of some other width, and
           an unpinned height would draw that pass tall and then collapse it.
           Stating the height makes it a narrower chart centred in its box
           rather than a vertical jump.
           Still earning its place after #343, which moved the browser's first
           measurement before paint: it removed the *painted* pre-measurement
           frame and not the arms where there is no measurement to wait for —
           an environment with no `ResizeObserver`, and jsdom, which is where
           every chart suite under `src/` reads this attribute. */
        height={CHART_VIEW_BOX_HEIGHT}
        role="img"
        aria-label={ariaLabel}
        tabIndex={0}
        onFocus={readAtFocus}
        onBlur={clearReadout}
        onKeyDown={readAtKey}
        /* The pointer listens on the whole figure — plot *and* both axis
           gutters — because #421's tap contract is that the target is the graph,
           not the drawing inside it: a thumb aimed at the start of the day lands
           on the y axis as often as beside it, and a tap that summons nothing is
           a chart that looks broken. Selection is still by x alone, and
           `pointerSample` clamps that x into the plot, so a gutter tap reads the
           end of the range it is nearest rather than a sample off the canvas.
           `onPointerDown` as well as `onPointerMove`: a finger produces no hover
           stream to be tracked, so the press *is* the reading. */
        onPointerDown={readAtPointer}
        onPointerMove={readAtPointer}
        onPointerLeave={clearReadoutForMouse}
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
        {/* Last child, and the plot exactly — two jobs since #421 moved the
            handlers up to the `<svg>`, neither of which is being the listener.
            It is the plot's geometry marker: `e2e/chart-surfaces.spec.ts`
            measures this rect as the drawn plot, and
            `forecast-chart-details.test.tsx` pins its four edges to `scale.plot`.
            And it is a hit surface over the marks — `charts.css` gives it the
            pointer-events it needs and no fill, so a pointer inside the plot has
            something solid to land on and bubbles from here into the handlers
            above, rather than depending on hitting a 2px line. */}
        <rect
          className="forecast-chart-pointer-target"
          x={scale.plot.left}
          y={scale.plot.top}
          width={scale.plot.right - scale.plot.left}
          height={scale.plot.bottom - scale.plot.top}
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
