import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';

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
 * it keeps wherever nothing can measure it.
 *
 * A real width rather than zero, because the pre-measurement render pass has not
 * gone anywhere: the component is committed at this width and only then asked
 * how wide its box is, and a plot 0px wide would put every mark on top of every
 * other one for that pass. What #343 removed is the *painted frame* carrying it
 * — in a browser the measurement now lands inside the same commit, before paint
 * — so this is the width of a pass no reader sees rather than of a flash they
 * do.
 *
 * It is still a real width and not a placeholder, because there are two states
 * where the pass is the whole story: wherever there is no `ResizeObserver` to
 * take over afterwards, and wherever the layout answers zero. jsdom is both at
 * once, which is why every suite under `src/` draws at this number — see the
 * guards on both measurements below.
 */
export const DEFAULT_CHART_WIDTH = 640;

export const useChartWidth = (ref: RefObject<Element | null>): number => {
  const [width, setWidth] = useState(DEFAULT_CHART_WIDTH);

  /*
   * The first measurement, taken before the frame it belongs to is painted.
   *
   * `useLayoutEffect` rather than `useEffect`, and that is `react.md` rule 1's
   * sanctioned case rather than an exception to it: the external system being
   * synchronized with is the layout engine, whose answer exists only once the
   * commit has landed in the document, and the entire value of the answer is
   * that it arrives before anything is drawn. A passive effect runs *after*
   * paint, so the chart is painted once at `DEFAULT_CHART_WIDTH` and redrawn a
   * frame later at its real width — the flash-then-snap #343 was opened about,
   * reproduced in `e2e/chart-first-paint.spec.ts` and provable nowhere else.
   *
   * It is not the only route to the first answer: `ResizeObserver` delivers an
   * initial callback on `observe()`, so the observer below re-answers the same
   * question after paint. That repeat costs nothing — the two reads agree for
   * the reason the box note below gives, and `Math.round` of the same width
   * hands `setWidth` the value already in state — so what this effect owns is
   * having the answer *before* paint rather than owning it alone. Both effects
   * take the same stable ref as their one dependency and so run once per mount,
   * for the reason the observer's own comment gives.
   */
  useLayoutEffect(() => {
    const measured = ref.current?.getBoundingClientRect().width;
    /*
     * The same zero guard the observer keeps, for the same reason — an element
     * with no layout yet is not a measurement of zero — and load-bearing for a
     * second one: jsdom lays every box out at zero, so this arm is what leaves
     * every chart suite under `src/` drawing at `DEFAULT_CHART_WIDTH` and able
     * to assert exact view-box coordinates. `use-chart-width.test.tsx` runs both
     * sides of it.
     *
     * The same *number* as the observer's, but not the same box: this is the
     * border box and `contentRect` below is the content box. They coincide only
     * because `.forecast-chart-figure` carries no padding and no border
     * (`charts.css`), so if it is ever given either, this read has to become a
     * content-box one — otherwise the first width and every later width differ
     * by the padding, and the one-frame jump #343 removed comes back wearing a
     * smaller number.
     */
    if (measured !== undefined && measured > 0) {
      setWidth(Math.round(measured));
    }
  }, [ref]);

  // The dependency is the ref itself, which is stable, so this subscribes once
  // per mount — the honest array, not a trimmed one (`react.md` rule 2). The
  // element is captured here rather than read from `ref.current` in the cleanup,
  // so the observer is always detached from the element it was attached to.
  useEffect(() => {
    const element = ref.current;
    /*
     * The fallback arm, and it is not defensive: jsdom ships no
     * `ResizeObserver` (checked against this repo's version), so *every* chart
     * test under `src/` renders through here. Taken together with the zero
     * layout that stops the measurement above from adopting anything, that is
     * what leaves the jsdom suites at `DEFAULT_CHART_WIDTH` and able to assert
     * exact view-box coordinates at all — two guards, one outcome, and
     * `use-chart-width.test.tsx` is where the pair is stated rather than
     * assumed.
     *
     * What has no coverage in this lane is *resizing*: a stubbed rect can be
     * read once during a commit, and no jsdom test can make a box change size
     * and be observed doing it. That coverage is the browser lane's —
     * `e2e/chart-surfaces.spec.ts` measures the rendered plot against its panel
     * and against the viewport, and `e2e/chart-first-paint.spec.ts` measures
     * which widths reach the screen — both facts about layout, which is where
     * they belong (`testing.md` rule 10).
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
