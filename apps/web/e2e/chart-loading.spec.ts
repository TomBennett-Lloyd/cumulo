import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { routeBasemap } from './hermetic-basemap';

/*
 * The frames the fleet chart spends waiting, and the one thing about them the
 * owner actually complained about: *"It also causes the page to jump."*
 *
 * #448 answered that by moving the loading state *inside* the plot — a curve
 * that traces itself where the fleet's line is about to be — and deleting the
 * sentence that used to arrive above the chart and leave again. So the claim is
 * a claim about a box: a loading chart occupies exactly the box the settled
 * chart occupies, so nothing below it ever moves. That is a measurement, which
 * makes it this lane's (`testing.md` rule 10) — jsdom lays nothing out, so a
 * height read there is zero in both renders and proves nothing. What jsdom
 * *can* hold is the structural half, and it does:
 * `src/dashboard/FleetPanel.structure.test.tsx` pins the same view box and the
 * chart still being the panel body's first child across the settle. Neither
 * case is the other's weaker copy — an app that passed one could fail the
 * other — so a change deleting either is deleting half a criterion.
 *
 * The instrument is installed before the app boots, which is
 * `chart-first-paint.spec.ts`'s idiom and necessary for the same reason: the
 * demo source resolves within a few frames, so a recorder attached after
 * `goto` would be looking at a chart that had already settled. A
 * `MutationObserver` rather than that file's frame loop, because the two
 * measure different things — it asks which values reached the *screen*, and
 * this asks whether a DOM state ever existed at all, which is exactly the shape
 * of "no pending notice was ever rendered here".
 */

/** The plot, told apart from the legend's swatches — the selector every chart spec measures. */
const PLOT_SVG = 'svg.forecast-chart';

/** The wait, drawn (`src/charts/chart-loading-curve.ts`). */
const LOADING_TRACE = '.forecast-chart-loading-trace';

/**
 * The pending treatment, scoped to the section that stopped using it.
 *
 * The class rather than the retired words. Two reasons and the second is the
 * load-bearing one: `panel-states.tsx` is where a pending notice comes from, so
 * the class is what any regression would actually render — and quoting the
 * deleted sentence here would leave a copy of it in the tree for the sweep that
 * proves it is gone to keep matching.
 */
const CHART_SECTION_PENDING = '.fleet-chart-section .panel-pending';

/** What the observer accumulates while the fleet read is out. */
interface ChartLoadingRecord {
  /** Every distinct `d` the trace wore — a set, because one path is the whole story. */
  traceDs: string[];
  /** Every distinct rendered height of the plot while the trace was on it. */
  loadingSvgHeights: number[];
  /** How many times a pending notice was seen inside the chart section. */
  pendingSightings: number;
  /** Whether the observer ever saw the trace — the premise every claim below rests on. */
  sawTrace: boolean;
}

declare global {
  interface Window {
    cumuloChartLoadingRecord: ChartLoadingRecord;
  }
}

/**
 * Watch the chart section from before the first application script runs.
 *
 * The observer disconnects once the trace has been seen and then gone, so the
 * map's own churn is not sampled for the rest of the test. Everything this
 * records can only happen inside that window: the pending notice it looks for
 * belonged to the same state, and a height is only taken while the trace is on
 * the plot.
 */
const recordLoadingState = async (page: Page): Promise<void> => {
  await page.addInitScript(
    (selectors: { plot: string; trace: string; pending: string }) => {
      const record: ChartLoadingRecord = {
        traceDs: [],
        loadingSvgHeights: [],
        pendingSightings: 0,
        sawTrace: false,
      };
      window.cumuloChartLoadingRecord = record;

      /*
       * The observer arrives as the callback's second argument, which is the
       * platform handing it over rather than this closure reaching back for a
       * binding it sits above (`structure.md` rule 1 — a parameter is visible
       * in the signature, a captured variable is not).
       */
      const sample = (_records: MutationRecord[], observer: MutationObserver): void => {
        if (document.querySelector(selectors.pending) !== null) {
          record.pendingSightings += 1;
        }

        const trace = document.querySelector(selectors.trace);

        if (trace === null) {
          if (record.sawTrace) {
            observer.disconnect();
          }
          return;
        }

        record.sawTrace = true;

        const d = trace.getAttribute('d') ?? '';

        if (!record.traceDs.includes(d)) {
          record.traceDs.push(d);
        }

        // `getBoundingClientRect` rather than the attribute: the claim is about
        // the box a reader's page reserves, which is a laid-out fact and not a
        // number written on the element.
        const height = document.querySelector(selectors.plot)?.getBoundingClientRect().height ?? 0;

        if (height > 0 && !record.loadingSvgHeights.includes(height)) {
          record.loadingSvgHeights.push(height);
        }
      };

      /*
       * `document`, not `document.documentElement`. An init script runs before
       * any page script and therefore before the parser has produced an
       * element: `documentElement` is `null` at this moment, `observe` throws on
       * it, and the whole init script dies — leaving a record that was
       * assigned a line earlier and never written to again, so every negative
       * assertion downstream passes for free. Measured on this spec's first
       * run, where `sawTrace` came back false against an app that draws the
       * trace. The document node is always there, and `subtree` reaches
       * everything under it either way.
       */
      new MutationObserver(sample).observe(document, {
        childList: true,
        subtree: true,
        attributes: true,
      });
    },
    { plot: PLOT_SVG, trace: LOADING_TRACE, pending: CHART_SECTION_PENDING },
  );
};

test.beforeEach(async ({ page }) => {
  await routeBasemap(page);
  await recordLoadingState(page);
  await page.goto('/');
});

test('waits inside the chart’s own box, and never above it', async ({ page }) => {
  const plot = page.locator(PLOT_SVG);

  await expect(plot).toBeVisible();

  /*
   * The wait for the settle, and it is what makes the comparison below a
   * comparison of two states rather than of one state with itself. The trace is
   * rendered by exactly the loading arm, so its absence is that arm being over.
   */
  await expect(page.locator(LOADING_TRACE)).toHaveCount(0);

  const record = await page.evaluate(() => window.cumuloChartLoadingRecord);

  /*
   * The instrument control, first, because everything after it is either "no
   * such state was seen" or a comparison against something the observer
   * recorded — and both pass for free against an observer that saw nothing.
   */
  expect(record.sawTrace).toBe(true);
  expect(record.traceDs.filter((d) => d.trim() === '')).toEqual([]);
  expect(record.traceDs.length).toBeGreaterThan(0);

  // The deletion, measured on a rendered page: the section never carried a
  // pending notice at any point in the read. Its control is the line above —
  // the same observer, over the same window, did see something.
  expect(record.pendingSightings).toBe(0);

  /*
   * And the criterion itself: the loading chart's box is the settled chart's
   * box.
   *
   * One height rather than a list, which is the stronger half and comes free
   * from recording distinct values — the chart does not change height *during*
   * the wait either, so there is no jump hiding inside the loading window.
   *
   * Compared within a pixel rather than exactly, for `chart-first-paint.spec.ts`'s
   * reason: these are two reads of a fractional box through APIs that round
   * differently, and a sub-pixel difference is not a page jump. A notice
   * arriving above the chart — the defect — moves it by a line of text.
   */
  const settled = await plot.boundingBox();

  expect(settled).not.toBeNull();
  expect(record.loadingSvgHeights).toHaveLength(1);
  expect(
    Math.abs((record.loadingSvgHeights[0] ?? Number.NaN) - (settled?.height ?? 0)),
  ).toBeLessThan(1);
});
