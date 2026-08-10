import { useEffect, useRef, useState } from 'react';
import { snapToNearestIndex } from './chart-geometry';
import type { ChartScale } from './chart-series';

/**
 * Everything between an input event and a selection: which sample a pointer is
 * over, what a keystroke does to the readout, and how often the panel is allowed
 * to move. No JSX, and no opinion about who calls it: since #331 the component
 * holding `useChartHover` is `forecast-chart-hover-boundary.tsx`, which is the
 * point re-rendering stops, and `forecast-chart-hover.tsx` draws whatever the
 * selection settles on. This is a file of its own because sizing a panel and
 * rate-limiting a pointer are separate jobs that happened to start in one place
 * (`structure.md` rule 4).
 */

export interface PointerSampleParams {
  readonly clientX: number;
  /** The chart's `<svg>`, or `null` before it mounts. */
  readonly svg: SVGSVGElement | null;
  /**
   * The width of the space the marks are drawn in. Since #284 D15 the chart is
   * drawn 1:1 with its measured width (`use-chart-width.ts`), so in the settled
   * state this equals the rendered width and the conversion below is the
   * identity — but only in the settled state, which is why it stays a parameter
   * rather than becoming an assumption. On the frame before the first
   * measurement, and wherever there is no `ResizeObserver` to measure with, the
   * view box is `DEFAULT_CHART_WIDTH` inside a box of some other width, and this
   * is what keeps the crosshair under the pointer there too.
   */
  readonly viewBoxWidth: number;
  readonly scale: ChartScale;
}

/** What one pointer position means to the chart: a landmark, and a place. */
export interface PointerSample {
  /** The sample the crosshair and the tooltip's rows belong to. */
  readonly activeIndex: number;
  /** The pointer itself, in SVG user units — what the panel follows. */
  readonly pointerX: number;
}

/**
 * Where the pointer is and which sample it is over. A client-space x means
 * nothing until it is divided by the rendered width and multiplied back into
 * view-box units — the space every mark is drawn in — which the chart's own
 * width makes a 1:1 conversion in the settled state and does not on the frames
 * `viewBoxWidth` above describes. Nothing measurable to divide by (unmounted, or
 * laid out at zero width) is a `null` readout rather than a NaN crosshair.
 *
 * Both halves come out of the one conversion, which is the point: the snapped
 * index and the continuous position are two readings of the same pointer, and
 * computing them apart would let them disagree about which sample the panel is
 * standing next to.
 */
export const pointerSample = ({
  clientX,
  svg,
  viewBoxWidth,
  scale,
}: PointerSampleParams): PointerSample | null => {
  if (svg === null) {
    return null;
  }
  const bounds = svg.getBoundingClientRect();
  if (bounds.width <= 0) {
    return null;
  }
  const pointerX = ((clientX - bounds.left) / bounds.width) * viewBoxWidth;
  return {
    activeIndex: snapToNearestIndex({ pointerX, plot: scale.plot, count: scale.pointCount }),
    pointerX,
  };
};

/**
 * What a keystroke does to the readout. `ignored` is a distinct outcome rather
 * than "no change": it is the caller's signal to leave the browser default
 * alone, so the chart never swallows Tab or a page key it does not act on.
 */
export type HoverKeyAction =
  | { readonly kind: 'ignored' }
  | { readonly kind: 'cleared' }
  | { readonly kind: 'moved'; readonly activeIndex: number };

export interface HoverKeyParams {
  /** `KeyboardEvent.key`. */
  readonly key: string;
  readonly activeIndex: number | null;
  readonly pointCount: number;
}

const IGNORED: HoverKeyAction = { kind: 'ignored' };

const moved = (activeIndex: number): HoverKeyAction => ({ kind: 'moved', activeIndex });

/**
 * Keyboard parity with the pointer: arrows step, Home/End jump, Escape
 * dismisses. Both ends produce the same `activeIndex`, which is why focus
 * shows exactly what hover shows.
 *
 * Entering the series from nothing (after Escape, or focus on an empty
 * readout) lands on the first sample rather than stepping off it, so the first
 * ArrowRight never skips index 0.
 */
export const hoverKeyAction = ({
  key,
  activeIndex,
  pointCount,
}: HoverKeyParams): HoverKeyAction => {
  if (key === 'Escape') {
    return { kind: 'cleared' };
  }
  const lastIndex = pointCount - 1;
  if (lastIndex < 0) {
    return IGNORED;
  }
  switch (key) {
    case 'ArrowRight':
      return moved(activeIndex === null ? 0 : Math.min(lastIndex, activeIndex + 1));
    case 'ArrowLeft':
      return moved(activeIndex === null ? 0 : Math.max(0, activeIndex - 1));
    case 'Home':
      return moved(0);
    case 'End':
      return moved(lastIndex);
    default:
      return IGNORED;
  }
};

/**
 * ~30 position updates a second — the rate #284 D7 asks the panel to move at.
 *
 * The decision is owned by `docs/design/chart-treatment.md` ("The panel follows
 * the pointer; the data snaps"); this is the code's one declaration of it, and
 * every other comment in the charts describes the throttle by this name rather
 * than by a number.
 *
 * Restatement ledger (`architecture.md` rule 9) — the sites carrying a literal
 * derived from this one, which would need re-deriving if it moved:
 *   - `forecast-chart-tooltip.test.tsx`: `INSIDE_ONE_FRAME_MS` and
 *     `PAST_ONE_FRAME_MS`, chosen to fall either side of this value.
 *   - `forecast-chart-render-boundary.test.tsx`: `PAST_ONE_FRAME_MS`, the wait
 *     each move in its pointer sweep advances by to commit exactly one frame.
 *   - `docs/design/chart-treatment.md`: the D7 bullet, which owns the decision
 *     and states it as a rate rather than as this interval.
 */
const POINTER_FRAME_MS = 33;

/** What the hover layer is showing, and where. */
export interface HoverSelection {
  /** `null` while nothing is hovered or focused. */
  readonly activeIndex: number | null;
  /** `null` for a keyboard selection: the panel then sits at the sample. */
  readonly pointerX: number | null;
}

export interface ChartHover extends HoverSelection {
  /**
   * A pointer move. Applied at once if no frame is open, held until the frame
   * closes otherwise — and the held one always lands.
   */
  readonly trackPointer: (sample: PointerSample | null) => void;
  /**
   * A keyboard move, a focus, or a dismissal. Immediate, and it drops any
   * pointer frame still in flight so a stale position cannot arrive after it.
   */
  readonly selectSample: (activeIndex: number | null) => void;
}

/** One stable object, so clearing an already-clear readout re-renders nothing. */
const NOTHING_HOVERED: HoverSelection = { activeIndex: null, pointerX: null };

/**
 * The chart's hover state, rate-limited on the pointer side.
 *
 * A pointer move is a stream, not an event: a mouse crossing the plot fires
 * far more often than a person can read, and every one of those events would
 * otherwise be a React commit. So pointer-driven updates open a window, and
 * moves arriving inside it are held rather than applied.
 *
 * **The held move always lands**, which is the part a naive throttle gets
 * wrong. Dropping the moves inside the window is fine while the pointer keeps
 * going — another is along in a moment — but a pointer that *stops* mid-window
 * sends nothing more, and the panel would freeze wherever the last applied
 * frame left it, short of where the reader actually parked the cursor. So the
 * window closes by flushing whatever it captured and, if it captured anything,
 * opening the next one.
 *
 * Keyboard selections bypass the window entirely. They are discrete acts, one
 * per keystroke, and there is nothing to rate-limit; more to the point, a
 * pointer frame flushing after an arrow key would drag the panel back to a
 * cursor the reader has stopped using.
 */
export const useChartHover = (): ChartHover => {
  const [selection, setSelection] = useState<HoverSelection>(NOTHING_HOVERED);
  const heldRef = useRef<HoverSelection | null>(null);
  const frameRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A timer is an external system, which is the one thing an effect is for
  // (`react.md` rule 1) — this one exists only to stop the frame outliving the
  // chart. Refs are stable, so the empty dependency list is the honest one.
  //
  // The handle is cleared *and* forgotten. Cancelling alone leaves `frameRef`
  // holding a dead timer id, which every writer here reads as "a frame is
  // open" — harmless today, because nothing calls back into a hook whose
  // component has gone, and a freeze-forever the moment anything does (every
  // later move held, no timer left alive to flush it). Two lines that agree
  // beat one line that relies on the caller never arriving.
  useEffect(
    () => () => {
      clearTimeout(frameRef.current ?? undefined);
      frameRef.current = null;
    },
    [],
  );

  const closeFrame = (): void => {
    frameRef.current = null;
    const held = heldRef.current;
    if (held === null) {
      return;
    }
    heldRef.current = null;
    setSelection(held);
    frameRef.current = setTimeout(closeFrame, POINTER_FRAME_MS);
  };

  const stopFrames = (): void => {
    if (frameRef.current !== null) {
      clearTimeout(frameRef.current);
      frameRef.current = null;
    }
    heldRef.current = null;
  };

  const trackPointer = (sample: PointerSample | null): void => {
    if (sample === null) {
      stopFrames();
      setSelection(NOTHING_HOVERED);
      return;
    }
    // A `PointerSample` is a `HoverSelection` that happens to know it is not
    // empty, so there is nothing to convert between the two.
    if (frameRef.current !== null) {
      heldRef.current = sample;
      return;
    }
    setSelection(sample);
    frameRef.current = setTimeout(closeFrame, POINTER_FRAME_MS);
  };

  const selectSample = (activeIndex: number | null): void => {
    stopFrames();
    setSelection(activeIndex === null ? NOTHING_HOVERED : { activeIndex, pointerX: null });
  };

  return { ...selection, trackPointer, selectSample };
};
