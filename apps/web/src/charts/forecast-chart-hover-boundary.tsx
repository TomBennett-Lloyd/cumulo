import {
  useEffect,
  useMemo,
  useRef,
  useState,
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

/**
 * How long a press stays able to explain a focus, in milliseconds — counted from
 * where the gesture last touched this element, which is its lift where it has
 * one and its press where it has not, rather than from the press always.
 *
 * The press flag has to outlive the event that set it, which is what makes a
 * bound necessary at all: the focus a tap produces arrives *after* `pointerup`,
 * so clearing on the lift would not bound the flag, it would delete the
 * mechanism. Time is what is left to bound it with.
 *
 * **What it bounds is one input dispatch, not a gesture.** `endGestureAtLift`
 * below re-stamps the ref on the way up, so the interval this has to survive is
 * the gap between the gesture's last pointer event and the focus that gesture
 * causes: for a finger, the lift and the focus that lift takes — its own, where
 * a reading stands, and otherwise the `click` synthesized from it; for a mouse,
 * the press and its own default action, which focuses on the way down and never
 * waits for a lift. Neither interval contains any of the reader's own time.
 * Anchoring at the *press* instead would put the whole dwell inside the window,
 * and the tap contract in `docs/design/chart-treatment.md` names the gesture
 * that then breaks it: a reader who lands an hour off is expected to hold on and
 * correct with a few pixels of drag, which stays inside the tap slop and so
 * still ends in a focus — arriving after a window anchored at the press had
 * closed, and wearing the ring #440 removed.
 *
 * The press this defends against is the one that focuses nothing, and since the
 * lift takes the focus a standing reading is dismissed through, that is the
 * press which never reaches a lift at all: a finger still on the glass, on a
 * chart that held no focus and therefore has no blur coming either. Nothing in
 * the event stream is owed to that press, so an unbounded flag simply waits, and
 * the *next* focus wears it whatever brought it.
 *
 * This is the second of the two gates that press needs, and the weaker one on
 * purpose. Every focus a *key* causes is answered exactly by the document
 * keydown listener below, which is a proof rather than an estimate; what is left
 * for a duration to cover is the focus no key and no press caused — a
 * programmatic `focus()`, a browser handing focus back to a restored page —
 * where there is nothing to observe and an unbounded flag would still be waiting.
 * That job is what it always was; only the endpoint the clock runs from moved.
 *
 * Half a second is chosen to sit between two intervals rather than to match a
 * measurement of either. Below it: one input dispatch, which by the paragraph
 * above is now the whole of what has to fit inside the window. Above it: any
 * plausible gap before a focus that no longer has anything to do with that
 * gesture. Both failure directions are bounded, which is the property an
 * open-ended flag did not have — err long and such a focus inside the window is
 * marked, err short and a tap whose focus was merely slow to be dispatched
 * regains the ring #440 removed. Re-anchoring widened the margin on the short
 * side without touching the value, which is why the value did not move.
 *
 * Restatement ledger (`architecture.md` rule 9) — the sites carrying a literal
 * derived from this one, which would need re-deriving if it moved:
 *   - `forecast-chart-focus-source.test.tsx`: `PAST_THE_PRESS_WINDOW_MS` and
 *     `INSIDE_THE_PRESS_WINDOW_MS`, chosen to fall either side of this value.
 *
 * The list is a floor rather than a census (`architecture.md` rule 10). It is
 * what `git grep -nE 'PRESS_WINDOW_MS|PRESS_EXPLAINS_FOCUS_MS|press window' --
 * :/` found on 2026-08-12; re-run it before moving this value, and widen it,
 * because a site phrasing the window some other way is invisible to those arms.
 * Nothing in the browser lane restates it. What that lane did measure is why a
 * duration cannot be the whole mechanism: a scrub-then-Tab case there once
 * *failed* against a purely temporal bound, because a test crosses the gap
 * between a finger and a keystroke in a fraction of the time a hand does, and a
 * bound a machine can outrun is not a bound. That measurement is the keydown
 * gate's evidence rather than this window's, and it is history now on its own
 * gesture: a scrub's lift takes a focus that spends the flag where it stands, so
 * nothing of that press is left for either gate to reach.
 */
const PRESS_EXPLAINS_FOCUS_MS = 500;

export const ForecastChartHoverBoundary = (
  props: ForecastChartHoverBoundaryProps,
): ReactElement => {
  const { ariaLabel, children, overlay, points, scale, spanHours, width } = props;
  const svgRef = useRef<SVGSVGElement>(null);
  /**
   * How the focus the `<svg>` is holding arrived — #440's one hard case.
   *
   * The chart has to keep taking focus on a tap: `readAtFocus` below is what
   * opens the spoken readout, and #421's dismissal is the blur that focus makes
   * possible. What it must not do is *ring* for a finger, and the engine will
   * not decide that for us — a tap on this element leaves `:focus-visible`
   * measurably false while a ring is painted anyway (measured in a `hasTouch`
   * Chromium probe on #440), so a rule carrying that conjunct is evaluated by
   * the same engine that answered false and cannot match. The source of the
   * focus is therefore a fact we have to carry ourselves, and `charts.css` reads
   * it off the attribute below.
   *
   * The ref and the state are two different questions and neither answers the
   * other. The ref is *when* a pointer gesture was last on this element — the
   * press, and again the lift that re-stamps it — which only the `focus` event
   * that follows may consume; the state is "the focus we are holding came from a
   * pointer", which is what the rule keys on.
   *
   * Ending a press's claim on the next focus takes four gates, because the
   * presses that reach a focus and the presses that reach nothing fail
   * differently. A `focus` consumes it, which is the ordinary tap. A `blur`
   * clears it, and the case that needs it is a *fast* one: a press on an
   * *already-focused* chart fires no `focus` event for anything to consume, so if
   * focus then leaves and comes straight back with no keystroke in between, the
   * returning focus would wear a press that had nothing to do with it. Elapsed
   * time is exactly what that round trip does not spend, which is why the window
   * cannot be what covers it — the longer such a press is left sitting, the more
   * the window handles it unaided. A keydown anywhere in the document clears it
   * (the effect below), which is what covers the press that focused nothing on a
   * chart holding nothing — a finger still down when a key arrives, which has no
   * focus to consume it and no blur to clear it, and whose flag would otherwise
   * be worn by the next focus whatever brought it. And it expires
   * (`PRESS_EXPLAINS_FOCUS_MS` above), which
   * bounds the arrivals no keystroke announces, counted from the gesture's last
   * pointer event on this element rather than from its press. `clearAtCancel`
   * clears it as well, as a consequence of the reading being withdrawn rather
   * than as a gate this needs.
   *
   * Pointer state stays imprisoned in this component, per #331/#347: nothing
   * above the boundary learns that a finger was involved.
   */
  const pressStampRef = useRef<number | null>(null);
  const [focusViaPointer, setFocusViaPointer] = useState(false);

  /**
   * A keydown anywhere in the document spends a pending press, which is the gate
   * that makes this guard *provably* safe rather than merely unlikely to be
   * wrong.
   *
   * A document listener because the event it needs never reaches this element:
   * the Tab that focuses the chart is dispatched at whatever held the focus
   * before it, and the focus that follows is that key's own default action. The
   * document in the capture phase is therefore the one place a focus-by-keyboard
   * can be seen coming, and the ordering it relies on is the platform's — the key
   * event is dispatched, then its default action moves the focus — so no press
   * can survive into a keyboard focus, whatever the clock says.
   *
   * `PRESS_EXPLAINS_FOCUS_MS` is not made redundant by it; the two cover
   * different arrivals. This covers every focus a *key* causes. The window covers
   * the ones no key does — a programmatic `focus()`, or a browser handing focus
   * back to a page the reader returned to — which no listener sees coming, and
   * which an unbounded flag would still be waiting for.
   *
   * An effect because it is a subscription to something outside this tree, which
   * is what effects are for (`react.md` rule 1). It reads a ref and sets a ref,
   * so it subscribes once for the component's life and never re-runs.
   */
  useEffect(() => {
    const forgetPress = (): void => {
      pressStampRef.current = null;
    };

    document.addEventListener('keydown', forgetPress, true);

    return () => {
      document.removeEventListener('keydown', forgetPress, true);
    };
  }, []);

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
   * Leaving the chart clears the readout and forgets how the focus arrived —
   * both flags, not just the state. The next focus event is entitled to be
   * judged on its own arrival, and a ref left set here would hand a keyboard
   * reader a pointer verdict on their way in.
   */
  const clearAtBlur = (): void => {
    setFocusViaPointer(false);
    pressStampRef.current = null;
    clearReadout();
  };

  /**
   * A cancelled gesture takes its reading with it — which is the one place a
   * touch pointer going away *does* clear, and the distinction the pin turns on.
   *
   * A lift is the end of a tap: the reader asked a question and the answer is
   * what they lifted their finger to read, so it stands (`clearReadoutForMouse`
   * above). A cancel is the browser taking the gesture away mid-flight — a
   * vertical drag becoming a page scroll under `touch-action`, most of all — and
   * the press that opened the reading was the first frame of a gesture that
   * turned out to be about something else. Nobody asked for that reading.
   *
   * Without this the reading has no route out at all on that path. `pointerout`
   * and `pointerleave` follow a cancel with `pointerType: 'touch'`, which the
   * mouse-only clear above ignores by design; and a cancel ends the gesture *in
   * place of* the lift, so `endGestureAtLift` below never runs and the focus a
   * standing reading is dismissed through is never taken. The crosshair, the
   * panel and the `aria-live` announcement would stand until the reader tapped
   * the chart and then tapped off it.
   *
   * Which is the right answer here rather than a gap: a reading nobody asked for
   * should not survive at all, so it is withdrawn instead of being made
   * dismissable.
   *
   * The press flag goes with it for the same reason: a gesture that was taken
   * away explains nothing about a focus that arrives afterwards.
   */
  const clearAtCancel = (): void => {
    pressStampRef.current = null;
    clearReadout();
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
   * So a touch reading has no leave event to dismiss it, and needs none —
   * dismissal is the existing blur path (`onBlur` below), which a tap anywhere
   * else fires. That path is available to every gesture that leaves a reading
   * standing, because every such gesture leaves the chart holding the focus, and
   * by the same line: a reading standing is exactly `endGestureAtLift`'s guard
   * below, so the lift takes that focus itself where one does — for a tap as much
   * as for a drag past the tap slop, which fires no click at all. The
   * one touch reading that goes away without being dismissed is the one nobody
   * asked for, and it does not go away through here either: see `clearAtCancel`
   * above for why a cancelled gesture and a lifted finger are opposite answers.
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

  /**
   * A press reads, and stamps the gesture that may be about to focus this
   * element. The time rather than a bare flag, because "a press happened" has no
   * end and "a press happened just now" does — see `PRESS_EXPLAINS_FOCUS_MS`.
   *
   * Not made redundant by `endGestureAtLift` below, and this is the pointer type that
   * needs it: a mouse focuses on the way *down*, as the press's own default
   * action, so for a mouse the press is the last event before the focus and there
   * is no lift to wait for.
   *
   * `performance.now()` rather than `Date.now()`: this is an elapsed interval,
   * and a wall clock stepped by the system between the two reads would answer
   * the question with an adjustment rather than with a duration.
   */
  const readAtPress = (event: ReactPointerEvent<SVGSVGElement>): void => {
    pressStampRef.current = performance.now();
    readAtPointer(event);
  };

  /**
   * A lift re-stamps the press, and takes the focus the reading it leaves
   * standing is dismissed through.
   *
   * **The stamp** is what makes the window a measure of one input dispatch
   * rather than of how long a finger stayed on the glass. The focus a lifted
   * finger produces arrives after `pointerup` — from the line below, or from the
   * `click` synthesized after it where there is nothing to keep dismissable — so
   * the lift is the last thing this element sees before that focus, and it is the
   * only endpoint the window can run from without the reader's own dwell inside
   * it. `PRESS_EXPLAINS_FOCUS_MS` above has why that difference decides whether
   * an unhurried tap keeps its suppression.
   *
   * Unconditional rather than guarded on a press still being pending, so a flag
   * a keydown already spent is re-armed here. That is the wanted answer twice
   * over: a reader who pressed a key with a finger still down has still tapped,
   * and the focus following their lift is still that tap's; and it costs the
   * keydown gate nothing, because that gate answers a *focus* rather than a
   * press — any focus a key causes is preceded by that key's own keydown, which
   * clears the ref again before the focus can arrive.
   *
   * **The focus** is what makes #421's one dismissal route true for a gesture
   * that never reaches a `click`. A drag past the tap slop is not a tap and not a
   * cancel either: `touch-action: pan-y pinch-zoom` (`charts.css`) leaves
   * horizontal movement to this chart, so the browser never claims the gesture
   * and no `pointercancel` arrives, while the engine cancels the tap and with it
   * the click and the focus that click would have carried. The reading such a
   * drag leaves standing then has *no* way to go away — the mouse-only leave
   * ignores a finger by design, `clearAtCancel` never fires, and blur needs a
   * focus nothing took — so it stands until the reader taps the chart and then
   * taps off it. Taking the focus here is the tap's own dismissal route arriving
   * one dispatch earlier by another road, not a second route: a scrub and a tap
   * both end holding the focus, and both are dismissed by leaving it.
   *
   * The order is load-bearing. The stamp is written first, so the `focus` this
   * dispatches consumes a stamp of its own age and `readAtFocus` marks it
   * pointer-sourced — a scrub must no more paint a ring than a tap does.
   *
   * Guarded on a reading standing, because a focus is not free: `readAtFocus`
   * opens the readout at the first sample when nothing is selected, so focusing
   * after a lift that read nothing would summon a reading the reader never asked
   * for. A mouse whose press landed here is unaffected in a browser whatever the
   * guard says — it focused on the way down, and focusing the already-focused
   * element fires no event.
   *
   * `preventScroll` because this focus is the component's rather than the
   * reader's: a programmatic focus scrolls its element into view, and a reader
   * who has just dragged a finger across a chart put the page where they want it.
   *
   * It still reads nothing. A lift changes no selection: #421's "a lifted finger
   * keeps what it revealed" is the whole of what happens to the readout here, and
   * the guard above is why the focus cannot change it either.
   */
  const endGestureAtLift = (): void => {
    pressStampRef.current = performance.now();

    if (activeIndex !== null) {
      svgRef.current?.focus({ preventScroll: true });
    }
  };

  /**
   * Focus opens the readout on the first sample; a live pointer readout stands.
   *
   * It also consumes the press flag, first and unconditionally, because that is
   * what makes this focus's *source* known: a gesture that touched this element a
   * moment ago is this focus's cause, and one that touched it and focused nothing
   * is spent either way. A stamp older than the window is not this focus's cause
   * — it is a gesture that ended without focusing anything — so it is spent
   * without marking. The readout logic below is #421's and is untouched by both — the
   * two share the handler because a tap fires one focus event, not two.
   */
  const readAtFocus = (): void => {
    const pressStamp = pressStampRef.current;
    pressStampRef.current = null;

    if (pressStamp !== null && performance.now() - pressStamp <= PRESS_EXPLAINS_FOCUS_MS) {
      setFocusViaPointer(true);
    }

    if (activeIndex === null) {
      hover.selectSample(0);
    }
  };

  const readAtKey = (event: ReactKeyboardEvent<SVGSVGElement>): void => {
    // A reader who starts driving by keyboard earns the ring back, whatever
    // brought them here — the same conclusion the engine's own heuristic
    // reaches, arrived at from the state we can actually observe. Ahead of the
    // action lookup deliberately: a key this chart ignores is still a keyboard.
    setFocusViaPointer(false);

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
        /* The focus source, published for `charts.css` and for
           `e2e/pointer-focus.spec.ts` to read. Absent rather than `'false'` on
           the keyboard path: the rule that suppresses the ring is an attribute
           selector, so the attribute not being there *is* the keyboard arm, and
           a chart that has never been touched carries nothing at all. */
        data-focus-via-pointer={focusViaPointer ? 'true' : undefined}
        onFocus={readAtFocus}
        onBlur={clearAtBlur}
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
        onPointerDown={readAtPress}
        /* And the lift re-stamps that press without disturbing the reading it
           made, then takes the focus that reading is dismissed through: the focus
           a lifted finger produces arrives after this event, so this is the
           endpoint `PRESS_EXPLAINS_FOCUS_MS` is measured from, and a drag that
           fires no `click` has no other way to reach one. */
        onPointerUp={endGestureAtLift}
        onPointerMove={readAtPointer}
        onPointerLeave={clearReadoutForMouse}
        /* And the one way a touch reading is dismissed without a blur: the
           browser taking the gesture away. `clearAtCancel` above has why a
           cancel and a lift are opposite answers. */
        onPointerCancel={clearAtCancel}
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
