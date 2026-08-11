import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { DEFAULT_CHART_WIDTH } from '../src/charts/use-chart-width';
import { routeBasemap } from './hermetic-basemap';

/*
 * The frames before the chart knows how wide it is — the one question no jsdom
 * suite can be asked, because jsdom never paints. It can be made to measure: a
 * stubbed rect is read during the commit and adopted, which is what
 * `use-chart-width.test.tsx` does. What it cannot do is say whether that
 * adoption beat the paint, because there is no paint for it to beat.
 *
 * `use-chart-width.ts` seeds its state at `DEFAULT_CHART_WIDTH` and the chart is
 * drawn 1:1 with that number since #284 D15, so on any column that is not
 * exactly that wide the pre-measurement render pass draws the whole plot at the
 * wrong scale. Whether a reader ever *sees* that pass is a fact about when the
 * measurement lands relative to paint, and that is what this file measures: a
 * measurement taken in a passive effect lands a frame late and the wrong-width
 * pass reaches the screen as a flash that then snaps; a measurement taken before
 * paint means the pass exists but no frame carrying it is ever painted.
 *
 * `chart-surfaces.spec.ts` is the sibling that owns where the marks land once
 * everything has settled. It waits for exactly the state this file refuses to
 * wait for, which is why the two cannot be one case: a settled chart is correct
 * under both implementations, and the difference between them lives entirely in
 * the frames a settled assertion is written to skip past.
 */

/**
 * A phone-shaped viewport, chosen because its column is nowhere near
 * `DEFAULT_CHART_WIDTH`.
 *
 * The defect is invisible at a width where the seeded default happens to be
 * right, so the viewport is load-bearing rather than incidental — and the last
 * assertion below proves this one really is wrong-by-default rather than
 * trusting the arithmetic. 390x844 is a common phone logical size, and a phone
 * column is far narrower than the seeded default.
 */
test.use({ viewport: { width: 390, height: 844 } });

declare global {
  interface Window {
    /**
     * Every distinct `viewBox` the plot has worn, in the order it wore them.
     *
     * Distinct rather than every frame's value: the interesting quantity is the
     * set of scales the chart was drawn at, and a per-frame log would be
     * thousands of copies of the same string with the same information in it.
     *
     * Installed by the init script below before any application script runs, so
     * the first value the chart is committed with is inside the record rather
     * than raced for.
     */
    cumuloChartViewBoxSamples: string[];
  }
}

/** The plot, told apart from the legend's swatches — the same selector `chart-surfaces.spec.ts` measures. */
const PLOT_SVG = 'svg.forecast-chart';

/** The figure whose measured box the plot's width is supposed to be. */
const CHART_FIGURE = '.fleet-chart-section .forecast-chart-figure';

/**
 * The width out of a `viewBox`, which is its third number.
 *
 * `Number.NaN` for anything that does not parse, deliberately: every comparison
 * below is an inequality, and a `NaN` fails all of them, so a malformed
 * attribute surfaces as a failing assertion carrying the raw string rather than
 * as a sample that quietly passes.
 */
const viewBoxWidth = (viewBox: string): number => Number(viewBox.split(' ')[2]);

/**
 * Watch the plot's `viewBox` on every animation frame, from before the app boots.
 *
 * A `requestAnimationFrame` loop rather than a `MutationObserver`, and the
 * distinction is the whole point of the instrument. A mutation record says the
 * attribute changed; it says nothing about whether the browser ever drew the
 * value it changed from. Frame callbacks run once per rendering opportunity,
 * immediately before the frame is styled, laid out and painted, so a value read
 * here is a value the frame about to be painted is carrying — which is exactly
 * the claim the case is about, and it is why a work-before-paint measurement is
 * invisible to it (React commits it, runs its layout effect and re-renders
 * inside one task, so no frame callback can land between the two) while a
 * work-after-paint one is not.
 */
/** The two numbers the vacuity guard compares, as one observation. */
interface SettledPair {
  /** The last `viewBox` the recorder saw — the scale the chart has settled at. */
  readonly viewBox: string;
  /** The figure's own width at that same instant. */
  readonly columnWidth: number;
}

/**
 * Both numbers out of one `page.evaluate`, so no task boundary sits between the
 * two reads and a reflow has no gap to land in.
 *
 * Reading them separately is the #382 class of flake: the chart is legitimately
 * re-laid-out as the map above it takes its band and as fonts resolve, so a
 * reflow between a sample snapshot and a `clientWidth` read leaves the two
 * numbers describing different layouts, and the comparison fails for a reason
 * that is not the defect — indistinguishable from a real failure in a lane with
 * `retries: 0`.
 */
const readSettledPair = async (page: Page): Promise<SettledPair> =>
  page.evaluate((figureSelector: string) => {
    const samples = window.cumuloChartViewBoxSamples;
    const figure = document.querySelector(figureSelector);

    return {
      viewBox: samples[samples.length - 1] ?? '',
      // `NaN` for a missing figure, for `viewBoxWidth`'s reason: every
      // comparison below is an inequality and a `NaN` fails all of them.
      columnWidth: figure === null ? Number.NaN : figure.clientWidth,
    };
  }, CHART_FIGURE);

const recordViewBoxes = async (page: Page): Promise<void> => {
  await page.addInitScript((plotSelector: string) => {
    window.cumuloChartViewBoxSamples = [];

    const sample = (): void => {
      const viewBox = document.querySelector(plotSelector)?.getAttribute('viewBox');
      const samples = window.cumuloChartViewBoxSamples;

      if (viewBox !== null && viewBox !== undefined && viewBox !== samples[samples.length - 1]) {
        samples.push(viewBox);
      }

      requestAnimationFrame(sample);
    };

    requestAnimationFrame(sample);
  }, PLOT_SVG);
};

test.beforeEach(async ({ page }) => {
  await routeBasemap(page);
  await recordViewBoxes(page);
  await page.goto('/');
});

test('paints no frame at the pre-measurement width', async ({ page }) => {
  const figure = page.locator(CHART_FIGURE);

  await expect(figure).toBeVisible();

  /*
   * Polled until the recorder has something, because the assertions below are
   * all of the form "no sample is wrong" and every one of them passes vacuously
   * on an empty log. This is the wait, and it is a wait on the instrument rather
   * than on the chart settling — waiting for the chart to settle is what would
   * make the case unable to see the defect at all.
   */
  await expect
    .poll(async () => page.evaluate(() => window.cumuloChartViewBoxSamples.length), {
      message: 'The frame recorder never saw the plot carry a view box.',
    })
    .toBeGreaterThan(0);

  const samples = await page.evaluate(() => window.cumuloChartViewBoxSamples);

  // The instrument control, stated rather than left to the poll above: every
  // claim below is a claim about frames that were observed, so "frames were
  // observed" is the premise all of them rest on.
  expect(samples.length).toBeGreaterThanOrEqual(1);

  /*
   * The defect, and the whole case. A chart drawn at the seeded width in a
   * column that is not that wide is the flash; that no *painted* frame carries
   * it is what the before-paint measurement buys.
   *
   * Deliberately not "exactly one distinct value". The chart is legitimately
   * allowed to be re-laid-out as the map above it takes its band and as the
   * fonts resolve, and a case asserting a single scale would fail on that
   * blameless reflow — in a lane with `retries: 0`, where a flake is
   * indistinguishable from the defect. What is forbidden is the one width that
   * is never a measurement of anything.
   */
  expect(samples.filter((viewBox) => viewBoxWidth(viewBox) === DEFAULT_CHART_WIDTH)).toEqual([]);

  /*
   * And the case's own vacuity guard, in the direction that matters: the
   * assertion above is satisfied for free by a viewport whose column happens to
   * be 640px wide, which would leave the whole file measuring nothing. Reading
   * the figure's own `clientWidth` proves this viewport forces a width that is
   * both a real measurement of the column and not the seed.
   *
   * Polled until two consecutive observations agree, and not read off the
   * snapshot above: that snapshot was taken before this line, so comparing it
   * with a width read now is comparing two moments (`readSettledPair`'s note).
   * Stability is the weakest wait that fixes it — it does not wait for the
   * chart to be *correct*, which would make the guard assert itself, only for
   * the layout to have stopped moving. The assertions stay assertions.
   */
  let pair = await readSettledPair(page);

  await expect
    .poll(
      async () => {
        const next = await readSettledPair(page);
        const stable = next.viewBox === pair.viewBox && next.columnWidth === pair.columnWidth;

        pair = next;
        return stable;
      },
      { message: 'The plot and its column never held still long enough to be read together.' },
    )
    .toBe(true);

  /*
   * Within a pixel, not equal, because the hook rounds its measurement
   * (`Math.round`, `use-chart-width.ts`) while `clientWidth` truncates the same
   * fractional box.
   */
  expect(pair.columnWidth).not.toBe(DEFAULT_CHART_WIDTH);
  expect(Math.abs(viewBoxWidth(pair.viewBox) - pair.columnWidth)).toBeLessThanOrEqual(1);
});
