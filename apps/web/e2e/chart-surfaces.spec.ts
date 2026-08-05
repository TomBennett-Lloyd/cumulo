import type { Locator } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { routeBasemap } from './hermetic-basemap';

/*
 * Chart geometry, which is the one question jsdom answers with a shrug.
 *
 * `ForecastChart` is drawn in view-box units and scaled to whatever width its
 * panel gives it, so every fact about where a mark actually landed is a fact
 * about layout: a plot's rendered box, and whether the text hung off its axes
 * still fits inside that box once the browser has shaped the glyphs. jsdom has
 * no layout — `getBoundingClientRect` there is zeros all the way down, which is
 * why `HORIZON_LABEL_WIDTH` in `ForecastChart.tsx` is an estimated constant
 * rather than a measurement — so the chart's own suite under `src/` can assert
 * the attributes the component wrote and never the pixels they turned into.
 * That is exactly the class of defect #19 kept producing: labels clipped at the
 * canvas edge, and elements that mounted at zero height.
 *
 * Two charts rather than one, because they are laid out by different states of
 * the same column: the fleet chart takes the width of the resting panel, a
 * site's chart the width of the panel that replaced it, and each draws its own
 * axis from its own numbers. A chart that fits in one and not the other is a
 * real defect that a single case would miss.
 *
 * Nothing here waits on the demo's first-forecast delay
 * (`DEFAULT_FIRST_FORECAST_DELAY_MS`, src/data/demo-fleet-data-source.ts). That
 * delay belongs to *created* sites, whose first forecast has to be generated;
 * the seeded fleet answers on its first poll, and no case below creates a site.
 */

/**
 * How far a label may reach past the plot before it is a clipped label,
 * as a share of that label's own height.
 *
 * A share rather than a pixel count, and this is the whole subtlety of the
 * measurement. A `<text>` element's client rect is the *font's* box — the full
 * ascent and descent of the typeface, not the ink of the glyphs actually in it —
 * so a label whose baseline sits a cap-height below the canvas edge still
 * reports a box that pokes out above it, by the empty band between the ascent
 * and the tallest letter. The chart's two axis titles do exactly that: measured
 * here at 1.7px over a 13px box (1.9px at a 500x600 viewport), while a
 * screenshot shows "kW" and "Times in UTC" drawn whole. A one-pixel budget would
 * therefore fail on the shipping chart for a band of empty space.
 *
 * Stated as a share it is scale-invariant, which a pixel count is not: the view
 * box scales to its column, and the slack scales with the text inside it. A
 * quarter leaves room over the ~0.13–0.15 measured above for a CI image whose
 * `system-ui` resolves to a font with a taller ascent, and is still far below
 * what any genuinely cut label loses — the #19 horizon label ran off the plot by
 * most of its width.
 */
const LABEL_CONTAINMENT_TOLERANCE = 0.25;

/**
 * The plot, told apart from the legend keys.
 *
 * `.forecast-chart-figure` holds four `<svg>` elements — the chart, and one
 * swatch per legend row — so a bare `svg` would measure whichever came first
 * and quietly assert the containment of a 28x14 swatch with no text in it.
 */
const PLOT_SVG = 'svg.forecast-chart';

/**
 * Every label that is not inside the plot it belongs to, described.
 *
 * Descriptions rather than a boolean, because the failure is the reading: an
 * empty array proves containment, and a populated one names the label, the edge
 * it escaped over, and by how much in both pixels and its own height — the
 * difference between "the chart is wrong" and a diagnosis. Both boxes are read
 * in client space, the space the reader's screen is in, so no view-box
 * arithmetic is restated here.
 */
const escapedLabels = async (figure: Locator): Promise<readonly string[]> =>
  figure.locator(PLOT_SVG).evaluate((svg, tolerance) => {
    const plot = svg.getBoundingClientRect();

    return [...svg.querySelectorAll('text')].flatMap((label) => {
      const box = label.getBoundingClientRect();
      const budget = box.height * tolerance;
      const overflows: Readonly<Record<string, number>> = {
        left: plot.left - box.left,
        right: box.right - plot.right,
        top: plot.top - box.top,
        bottom: box.bottom - plot.bottom,
      };
      const escaped = Object.entries(overflows)
        .filter(([, pixels]) => pixels > budget)
        .map(
          ([edge, pixels]) =>
            `${edge} by ${pixels.toFixed(1)}px (${(pixels / box.height).toFixed(2)} of its height)`,
        );
      const text = label.textContent === '' ? '(no text)' : label.textContent;

      return escaped.length === 0 ? [] : [`${text} — escapes ${escaped.join(', ')}`];
    });
  }, LABEL_CONTAINMENT_TOLERANCE);

/**
 * The whole geometric contract one chart owes, asserted where it is drawn.
 *
 * The same assertions for both charts because they are the same intent: a chart
 * is laid out, or it is one of #19's two failure shapes. If one of these ever
 * needs to differ per surface, that is two contracts and this splits into two
 * functions rather than growing a flag (`structure.md` rule 7).
 */
const expectChartLaidOut = async (figure: Locator): Promise<void> => {
  await expect(figure).toBeVisible();

  /*
   * The zero-height class of defect. Visibility alone would pass on a plot
   * collapsed to nothing, which is what a chart mounted into a container with
   * no measured size looks like from the DOM — and a chart drawing nothing is
   * the one thing a `role="img"` with a good accessible name still hides.
   */
  const box = await figure.locator(PLOT_SVG).boundingBox();
  if (box === null) {
    throw new Error('The chart figure is visible but its plot has no layout box.');
  }
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);

  // Vacuity guard: containment passes trivially on a plot with no labels, which
  // is also precisely what a chart that failed to draw its axes looks like.
  await expect(figure.locator(`${PLOT_SVG} text`)).not.toHaveCount(0);

  /*
   * Polled rather than read once. Glyph advances settle with the font, and the
   * axis is laid out again whenever the column's width changes, so a single
   * measurement taken on arrival can be taken mid-shape; the state being waited
   * on is "the labels have stopped moving, and they are inside".
   */
  await expect
    .poll(async () => escapedLabels(figure), {
      message: 'Axis labels are being clipped at the edge of the plot.',
    })
    .toEqual([]);
};

test.beforeEach(async ({ page }) => {
  await routeBasemap(page);
  await page.goto('/');
});

test('draws the fleet chart at a real size, with its labels inside it', async ({ page }) => {
  /*
   * The resting state: nothing selected, so the column shows the fleet, and its
   * chart is the one on screen when the app opens. The default view is the one
   * every visitor gets and the one no jsdom test can measure.
   */
  await expectChartLaidOut(page.locator('.fleet-panel .forecast-chart-figure'));
});

test('draws a selected site’s chart at a real size, with its labels inside it', async ({
  page,
}) => {
  /*
   * The same contract in the other column state. A site's chart is drawn from
   * one site's series rather than the fleet's sum, so its axis carries different
   * numbers — a scale that fits the fleet's four-hundred-kW labels can still be
   * laid out differently under a single site's.
   *
   * A seeded row, so the panel's forecast is answered on the first poll; the
   * first-forecast delay named above belongs to sites this session creates, and
   * nothing here creates one.
   */
  await page.locator('[data-site-id]').first().click();
  await expect(page.locator('.site-panel-title')).toBeVisible();

  await expectChartLaidOut(page.locator('.site-panel .forecast-chart-figure'));
});
