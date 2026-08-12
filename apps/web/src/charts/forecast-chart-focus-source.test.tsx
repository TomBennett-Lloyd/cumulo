// @vitest-environment jsdom

import { cleanup, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clientXFor,
  renderChart,
  requireSvg,
  SERIES,
  stubRenderedSize,
  xOfSample,
} from './forecast-chart-test-fixture';

/**
 * How the chart records the way its focus arrived — #440's guarded pattern in
 * `forecast-chart-hover-boundary.tsx`, which `charts.css` reads off
 * `data-focus-via-pointer` to withhold the ring from a finger.
 *
 * What is under test here is **our** flag and nothing else: which events set it,
 * which clear it, and that a spent press cannot carry over to a later focus.
 * That is deterministic in jsdom because it is our own logic. The question the
 * feature exists to answer — whether a ring is *painted* — is not asked here and
 * cannot be: jsdom applies no stylesheet, computes no style, and implements no
 * `:focus-visible` heuristic, so an assertion about the ring would be an
 * assertion about nothing. `e2e/pointer-focus.spec.ts` owns it in the browser
 * lane, with `e2e/keyboard-focus.spec.ts` holding the other half — `testing.md`
 * rule 10 is the routing rule, and neither of those specs is meaningful alone.
 *
 * A new file rather than more cases in `forecast-chart-hover.test.tsx`, which is
 * ~22 code lines under the 300-line ceiling and has no room for these
 * (`structure.md` rule 4). `forecast-chart-tap.test.tsx` was cut off that same
 * suite on that same rule and `forecast-chart-details.test.tsx` off
 * `ForecastChart.test.tsx` on it, and like both this one takes its series and
 * its coordinates from the shared fixture rather than keeping a second set.
 */

// Vitest runs without global test hooks, so Testing Library's automatic cleanup
// never registers itself.
afterEach(cleanup);

/**
 * Comfortably past the press window — `PRESS_EXPLAINS_FOCUS_MS` in
 * `forecast-chart-hover-boundary.tsx`, which ledgers this constant beside it.
 *
 * A press this old cannot be the cause of a focus arriving now, and the only
 * thing this number has to be is on the far side of that line rather than near
 * it: what the cases below turn on is which side of the window they are, not how
 * close to it.
 */
const PAST_THE_PRESS_WINDOW_MS = 5_000;

/** Inside the window — a stamp still recent enough to explain the focus after it. */
const INSIDE_THE_PRESS_WINDOW_MS = 100;

/**
 * How far the component's clock has been pushed forward, in milliseconds.
 *
 * Added to the real `performance.now()` rather than replacing it, so the clock
 * the component reads stays monotonic and stays roughly the machine's — React's
 * own scheduler reads the same function, and a clock pinned to a constant is not
 * something to hand it. Jumping the offset forward is how a case says "and then
 * some time passed", which is the only thing about time these cases care about.
 */
let clockOffsetMs = 0;

const passTime = (ms: number): void => {
  clockOffsetMs += ms;
};

const stubAdvanceableClock = (): void => {
  clockOffsetMs = 0;

  const realNow = performance.now.bind(performance);

  vi.spyOn(performance, 'now').mockImplementation(() => realNow() + clockOffsetMs);
};

afterEach(() => {
  vi.restoreAllMocks();
});

/** `null` where the attribute is absent, which is the keyboard arm's shape. */
const focusSource = (svg: SVGSVGElement): string | null =>
  svg.getAttribute('data-focus-via-pointer');

const renderFocusableChart = (): SVGSVGElement => {
  const svg = requireSvg(renderChart(SERIES));
  stubRenderedSize(svg);
  return svg;
};

/**
 * A finger pressing the figure. `pointerType` is stated because jsdom defaults
 * it to the empty string, which is neither type the component tells apart — and
 * the press has to be a real reading, not a bare flag-setter, so that the flag
 * and #421's readout are proven to come out of the same handler.
 */
const pressAt = (svg: SVGSVGElement, viewBoxX: number): void => {
  fireEvent.pointerDown(svg, { clientX: clientXFor(viewBoxX), pointerType: 'touch' });
};

/**
 * That finger coming back off the glass, which is where the press window is
 * measured from and where the chart takes the focus a standing reading is
 * dismissed through (`endGestureAtLift`). `pointerType` for the same reason
 * `pressAt` states it; no coordinate, because a lift moves no reading — #421's
 * contract is that it keeps the one the press made.
 */
const liftFrom = (svg: SVGSVGElement): void => {
  fireEvent.pointerUp(svg, { pointerType: 'touch' });
};

describe('ForecastChart focus source', () => {
  it('marks a focus that a pointer press brought with it', () => {
    const svg = renderFocusableChart();

    pressAt(svg, xOfSample(SERIES, 2));
    fireEvent.focus(svg);

    expect(focusSource(svg)).toBe('true');
  });

  it('marks the focus a lift takes to keep a reading dismissable', () => {
    const svg = renderFocusableChart();

    /*
     * The focus the component takes for itself, rather than one arriving from
     * the platform. A drag that fires no `click` leaves a reading with no way to
     * go away, so the lift focuses the chart to restore the blur route
     * (`endGestureAtLift`, and `forecast-chart-tap.test.tsx` for the reading that
     * survives it) — and that focus is as pointer-sourced as the tap's. Nothing
     * here would be visible in the ring assertions if the stamp were written
     * after the focus instead of before it: the chart would hold a focus a finger
     * caused and wear the ring #440 took off a finger.
     */
    pressAt(svg, xOfSample(SERIES, 2));
    liftFrom(svg);

    expect(svg.ownerDocument.activeElement).toBe(svg);
    expect(focusSource(svg)).toBe('true');
  });

  it('leaves a focus that arrived without a press unmarked', () => {
    const svg = renderFocusableChart();

    // The keyboard arm — a reader tabbing in. Nothing to suppress, so the
    // design system's `:focus-visible` ring is the one that paints.
    fireEvent.focus(svg);

    expect(focusSource(svg)).toBeNull();
  });

  it('drops the mark when the reader starts driving by keyboard', () => {
    const svg = renderFocusableChart();
    pressAt(svg, xOfSample(SERIES, 2));
    fireEvent.focus(svg);

    fireEvent.keyDown(svg, { key: 'ArrowRight' });

    expect(focusSource(svg)).toBeNull();
  });

  it('does not let a press that focused nothing mark a later focus', () => {
    const svg = renderFocusableChart();

    /*
     * The state the name describes, with nothing supplied by hand to reach it. A
     * finger still on the glass is how a reader gets here: the press read the
     * chart and focused nothing — touch takes no focus on the way down — and
     * until that finger lifts there is no focus to consume the flag and, on a
     * chart that was holding none, no `blur` to clear it. Nothing in the event
     * stream is owed to that press at all. Deliberately no lift, because a lift
     * is what would end it without the key: it takes the focus that keeps the
     * reading dismissable (`endGestureAtLift`), and that focus spends the flag.
     *
     * What ends it is the Tab itself. The key is dispatched at whatever held the
     * focus before — not at this chart, which is why the component listens for it
     * on the document — and the focus below is that key's own default action, so
     * the press is already spent by the time it arrives. A keyboard focus wearing
     * a pointer verdict is the WCAG 2.4.7 failure the whole guard exists to
     * prevent, and this is the ordering that makes it unreachable rather than
     * unlikely. No spec in the browser lane runs this sequence: every completed
     * gesture there ends in a lift, and a lift now focuses, so a press left
     * pending needs a finger held down across a keystroke — a gesture that lane
     * has no primitive for. The ordering is the platform's rather than a
     * measurement, which is why jsdom can hold it; what that lane holds is the
     * ring in the states a completed gesture leaves (`e2e/keyboard-focus.spec.ts`).
     */
    pressAt(svg, xOfSample(SERIES, 2));
    fireEvent.keyDown(document, { key: 'Tab' });
    fireEvent.focus(svg);

    expect(focusSource(svg)).toBeNull();
  });

  it('lets a press that focused nothing expire when no key is pressed at all', () => {
    stubAdvanceableClock();
    const svg = renderFocusableChart();

    /*
     * The same spent press, reaching a focus that no keystroke announced — a
     * programmatic `focus()`, or a browser handing focus back to a page the
     * reader returned to. The case above is answered by the document keydown the
     * Tab itself fires; there is no such event here, so what has to end the press
     * is the window closing.
     *
     * Never lifted, and that is the whole of why the window can still reach it:
     * the finger is notionally still on the glass, so nothing has re-stamped the
     * window's start and nothing has taken a focus of its own
     * (`endGestureAtLift`). Lift it and this becomes the slow-tap case below,
     * which must come out the other way.
     */
    pressAt(svg, xOfSample(SERIES, 2));
    passTime(PAST_THE_PRESS_WINDOW_MS);
    fireEvent.focus(svg);

    expect(focusSource(svg)).toBeNull();
  });

  it('still marks a focus the press was merely slow to reach', () => {
    stubAdvanceableClock();
    const svg = renderFocusableChart();

    /*
     * The other side of the same line, and the case above's control: expiry that
     * fired on any elapsed time at all would satisfy that case while quietly
     * handing back the ring #440 removed. No lift here either, so the stamp being
     * measured is still the press's own — which is the *mouse's* shape, where
     * focus is the press's own default action and arrives a dispatch later rather
     * than after a finger comes up.
     */
    pressAt(svg, xOfSample(SERIES, 2));
    passTime(INSIDE_THE_PRESS_WINDOW_MS);
    fireEvent.focus(svg);

    expect(focusSource(svg)).toBe('true');
  });

  it('still marks a focus a slow tap reached long after the finger went down', () => {
    stubAdvanceableClock();
    const svg = renderFocusableChart();

    /*
     * The gesture `docs/design/chart-treatment.md`'s tap contract expects of a
     * reader who lands an hour off: press, read the panel, correct with a few
     * pixels of drag, lift. However long the reader dwelt, the focus that follows
     * is the *lift's* — the one the lift takes itself where a reading stands, and
     * the `click`'s where one does not — which is the endpoint
     * `PRESS_EXPLAINS_FOCUS_MS` is measured from.
     *
     * Anchored at the press instead, this focus falls outside the window, the
     * attribute is never set and the chart paints a ring under a finger that is
     * only just off it — #440's defect, on the gesture this repo's own design
     * record most expects. The case above is what makes this one a claim about
     * the *anchor* rather than about the window being long: the same elapsed time
     * expires an unlifted press and does not expire this one.
     */
    pressAt(svg, xOfSample(SERIES, 2));
    passTime(PAST_THE_PRESS_WINDOW_MS);
    liftFrom(svg);

    expect(focusSource(svg)).toBe('true');
  });

  it('forgets a press once focus has left the chart', () => {
    const svg = renderFocusableChart();

    /*
     * The gate the window cannot cover, and the state it uniquely covers is the
     * *fast* one rather than a slow one. A press on an already-focused chart
     * fires no `focus` event for anything to consume, so it is left pending; if
     * focus then leaves and comes straight back with no keystroke in between, the
     * returning focus would wear a press that had nothing to do with it. This
     * case passes no time at all, and that is the point — elapsed time is what
     * the window needs and what a round trip like this does not spend. The longer
     * such a press is left sitting, the more the window handles it unaided, which
     * is the opposite of what a gate for slow holds would look like. Blur is what
     * ends it, so the focus after — a reader tabbing back in, owed their ring —
     * is judged on its own arrival.
     */
    pressAt(svg, xOfSample(SERIES, 2));
    fireEvent.blur(svg);
    fireEvent.focus(svg);

    expect(focusSource(svg)).toBeNull();
  });

  it('forgets a press the browser cancelled the gesture out from under', () => {
    const svg = renderFocusableChart();

    // A cancel is the gesture being taken away — a scroll the browser claimed,
    // most of all. It leaves nothing behind to explain a later focus, so the
    // press is spent there rather than left for the window to time out.
    pressAt(svg, xOfSample(SERIES, 2));
    fireEvent.pointerCancel(svg, { pointerType: 'touch' });
    fireEvent.focus(svg);

    expect(focusSource(svg)).toBeNull();
  });
});
