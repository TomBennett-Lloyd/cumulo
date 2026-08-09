import { useEffect, useState, type RefObject } from 'react';

/**
 * How wide the chart is, in rendered pixels — the one thing a chart drawn 1:1
 * cannot know without asking the layout (`chart-geometry.ts`'s `chartPlot`).
 *
 * A hook and not a measurement helper because the answer changes: a column
 * re-flows when the window resizes, when the map above it settles, and when a
 * scrollbar appears. `ResizeObserver` is the platform's own answer to that
 * question and it is an external system, which is the one thing an effect is for
 * (`react.md` rule 1) — there is no derived value here to compute during render
 * and no interaction to handle.
 */

/**
 * The width the chart draws at before anything has been measured, and the width
 * it keeps where there is no `ResizeObserver` to measure with.
 *
 * A real width rather than zero: a chart is mounted and drawn on the frame
 * before its first observation arrives, and a plot 0px wide would put every mark
 * on top of every other one for that frame. 640 is a plausible column, so the
 * pre-measurement frame is a chart at a slightly wrong width rather than a chart
 * collapsed to a line.
 *
 * It is also the width every jsdom suite draws at, deliberately — see the guard
 * below.
 */
export const DEFAULT_CHART_WIDTH = 640;

export const useChartWidth = (ref: RefObject<Element | null>): number => {
  const [width, setWidth] = useState(DEFAULT_CHART_WIDTH);

  // The dependency is the ref itself, which is stable, so this subscribes once
  // per mount — the honest array, not a trimmed one (`react.md` rule 2). The
  // element is captured here rather than read from `ref.current` in the cleanup,
  // so the observer is always detached from the element it was attached to.
  useEffect(() => {
    const element = ref.current;
    /*
     * The fallback arm, and it is not defensive: jsdom ships no
     * `ResizeObserver` (checked against this repo's version), so *every* chart
     * test under `src/` renders through here at `DEFAULT_CHART_WIDTH`. That is
     * what makes the jsdom suites able to assert exact view-box coordinates at
     * all, and it means the measured arm below has no coverage in this lane.
     * Its coverage is the browser lane's — `e2e/chart-surfaces.spec.ts`
     * measures the rendered plot against its panel and against the viewport,
     * which is a fact about layout and belongs there (`testing.md` rule 10).
     */
    if (element === null || typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width;
      // A zero measurement is a box that is not laid out yet — a `display: none`
      // ancestor, a tab that has not been shown. Keeping the last good width
      // through it means the chart is not rebuilt at a degenerate scale and then
      // rebuilt again when the box comes back.
      if (measured !== undefined && measured > 0) {
        setWidth(Math.round(measured));
      }
    });
    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [ref]);

  return width;
};
