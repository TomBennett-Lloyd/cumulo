import type { Locator, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { CHART_VIEW_BOX_HEIGHT } from '../src/charts/chart-geometry';
import { routeBasemap } from './hermetic-basemap';
import { openSiteTable } from './site-table';

/*
 * Chart geometry, which is the one question jsdom answers with a shrug.
 *
 * `ForecastChart` is drawn 1:1 with the width its panel gives it — one view-box
 * unit is one rendered pixel since #284 D15, where it used to be a fixed view
 * box scaled up to fill the column. That makes the *width* a thing the chart
 * has to be told, and every fact about where a mark actually landed is still a
 * fact about layout: a plot's rendered box, and whether the text hung off its
 * axes fits inside that box once the browser has shaped the glyphs. jsdom has
 * no layout — `getBoundingClientRect` there is zeros all the way down, which is
 * why `HORIZON_LABEL_WIDTH` in `forecast-chart-axes.tsx` is an estimated
 * constant rather than a measurement, and why jsdom never measures the chart at
 * all and draws every suite at `DEFAULT_CHART_WIDTH` (`use-chart-width.ts`). So
 * the chart's own suite under `src/` can assert the attributes the component
 * wrote and never the pixels they turned into. That is exactly the class of
 * defect #19 kept producing: labels clipped at the canvas edge, and elements
 * that mounted at zero height. D15 produced one more of them on its way in — at
 * 1:1 the plot's right margin stopped scaling up with the panel, and the last
 * time-axis label, centred on that edge, hung 13.8px past the canvas.
 *
 * One chart, in two states, because that is what the page has since #265: a
 * selected site is a second series *on* the fleet chart rather than a chart of
 * its own. Both states are still worth measuring separately, and for the reason
 * that mattered when they were two charts — the axis is scaled to the numbers on
 * the plot, and adding a single site's line under a sixty-site sum changes what
 * the labels say and how wide they are. A chart whose labels fit before a
 * selection and are clipped after it is exactly the #19 defect, arriving through
 * a door the resting-state case cannot see.
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
 * screenshot shows both titles — `Power (kW)` up the left gutter and
 * `Time (UTC)` under the time axis, where #284 D10 put them; the pair they
 * replaced is `docs/design/chart-treatment.md`'s to remember — drawn whole. A
 * one-pixel budget would therefore fail on the shipping chart for a band of
 * empty space.
 *
 * Stated as a share it is font-invariant, which a pixel count is not: the slack
 * this budget exists to absorb is a band of empty space inside the glyph box, so
 * it scales with the text and a share of the box is the thing that stays
 * constant. That used to be a statement about the view box scaling to its
 * column; since #284 D15 the chart is drawn 1:1 and the labels are the same
 * size at every width, so the share is now doing the simpler job of surviving a
 * different typeface rather than a different scale. A quarter leaves room over
 * the ~0.13–0.15 measured above for a CI image whose `system-ui` resolves to a
 * font with a taller ascent, and is still far below what any genuinely cut label
 * loses — the #19 horizon label ran off the plot by most of its width, and D15's
 * own clipped tick label by 0.98 of its height.
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
 * Clear space demanded between two neighbouring labels of one x-axis tier, in
 * rendered pixels.
 *
 * The browser-side half of #284 D9. `chart-axis-ticks.ts` thins each tier until
 * its labels satisfy an overlap invariant computed from a *modelled* character
 * width — a mean advance, which is the only thing a pure function can know about
 * text it will never see laid out. This is the case that checks the model
 * against the glyphs a real engine actually shaped, and it is the reason the
 * model is deliberately generous: a mean is not a bound, so a row of wide
 * characters is modelled a little narrow and the slack is what absorbs it.
 *
 * Four pixels rather than the eight user units the model demands, and the gap
 * measured differently at each end: the model works centre-to-centre with
 * modelled widths, this works edge-to-edge with real boxes. The two cannot be
 * compared directly, so this is a floor on the visible outcome — labels that are
 * plainly two labels — not a restatement of the invariant (`architecture.md`
 * rule 9). What it has to catch is #259's defect: adjacent ticks touching or
 * overlapping, which at ~436px of chart the old fixed-count axis did.
 */
const MIN_RENDERED_LABEL_GAP = 4;

/** The two rows of the time axis, each of which must not crowd itself. */
const X_TIER_SELECTORS: readonly string[] = [
  '.forecast-chart-axis-time',
  '.forecast-chart-axis-day',
];

/**
 * Every pair of neighbouring tick labels that is too close to read as two,
 * described — the same reading-is-the-diagnosis shape as `escapedLabels`.
 *
 * Per tier, never across them: the hours and the days are drawn on separate
 * rows, so a horizontal gap between an hour and a day a row below it is not a
 * collision and asserting on it would be measuring nothing. Sorted by position
 * rather than trusted in document order, so the reading survives a builder that
 * emits labels in some other sequence.
 */
const crowdedTickLabels = async (figure: Locator): Promise<readonly string[]> =>
  figure.locator(PLOT_SVG).evaluate(
    (svg, { minGap, selectors }) =>
      selectors.flatMap((selector) => {
        const labels = [...svg.querySelectorAll(selector)]
          .map((label) => ({ text: label.textContent, box: label.getBoundingClientRect() }))
          .sort((left, right) => left.box.left - right.box.left);

        return labels.flatMap((label, index) => {
          const next = labels[index + 1];
          if (next === undefined) {
            return [];
          }
          const gap = next.box.left - label.box.right;

          return gap >= minGap
            ? []
            : [`${selector}: "${label.text}" and "${next.text}" are ${gap.toFixed(1)}px apart`];
        });
      }),
    { minGap: MIN_RENDERED_LABEL_GAP, selectors: X_TIER_SELECTORS },
  );

/**
 * How far the plot's right edge may sit from its panel's before the chart is not
 * filling the panel, in pixels.
 *
 * The panel pads itself by one `--space-4` step (`dashboard/fleet-panel.css`
 * owns that, and the token owns the length), so a chart filling its column still
 * stops that step short of the panel's *border* box — which is the box
 * `boundingBox` reports. The budget is that one step at the default root size
 * plus a little sub-pixel slack, and nothing more. What it has to catch is the
 * chart being held to a *measure* narrower than its column, which before #284 D3
 * left it short by most of the panel's width at the default viewport; a budget
 * loose enough to admit that would be measuring nothing.
 */
const PANEL_FILL_TOLERANCE = 18;

/** What `panelFit` says when the plot is filling its panel. */
const FILLS_PANEL = 'fills its panel';

/**
 * Whether the plot fills the panel it is in, described.
 *
 * A description rather than a number for the same reason `escapedLabels` above
 * returns descriptions: the reading is the diagnosis. Signed, so both failures
 * are one measurement — a chart short of its panel (the D3 defect) and a chart
 * overhanging it (a plot spilling out of the card it lives in) are equally wrong
 * and read differently in the message.
 */
const panelFit = async (page: Page): Promise<string> => {
  const panel = await page.locator('.fleet-panel').boundingBox();
  const plot = await page.locator(`.fleet-panel ${PLOT_SVG}`).boundingBox();

  if (panel === null || plot === null) {
    return 'the fleet panel or its plot has no layout box';
  }

  const shortfall = panel.x + panel.width - (plot.x + plot.width);

  return Math.abs(shortfall) <= PANEL_FILL_TOLERANCE
    ? FILLS_PANEL
    : `the plot's right edge is ${shortfall.toFixed(1)}px from its panel's (budget ${String(PANEL_FILL_TOLERANCE)}px; positive is short, negative overhangs)`;
};

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

  /*
   * The second vacuity guard, and the sharper of the two. "No two labels are too
   * close" is satisfied by an axis carrying one label, or none — which is
   * exactly what over-eager thinning produces, and exactly the failure the
   * assertion below cannot see on its own. Two hours is the least that makes the
   * adjacency claim mean anything.
   */
  await expect
    .poll(async () => figure.locator(`${PLOT_SVG} .forecast-chart-axis-time`).count(), {
      message: 'The time axis is drawing fewer labels than it takes to have neighbours.',
    })
    .toBeGreaterThan(1);

  /*
   * #259, discharged: neighbouring tick labels do not touch. Polled for the same
   * reason containment is — the labels are re-laid-out as the column settles and
   * the font resolves, and a gap read mid-reflow is a gap between boxes that are
   * still moving.
   */
  await expect
    .poll(async () => crowdedTickLabels(figure), {
      message: 'Adjacent x-axis tick labels are crowding each other.',
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

/*
 * The other half of #284 D3, and the half jsdom cannot see either way: the chart
 * is only as wide as its layout makes it, and a `<details>` only hides anything
 * where the user agent's own stylesheet is applied. `forecast-chart-details.test.tsx`
 * owns the semantics — `open`, the summary's words, the table still resolving by
 * accessible name through a closed disclosure — and stops exactly where a
 * rendered box starts (`testing.md` rule 10).
 */
test('fills the panel and folds the raw data away', async ({ page }) => {
  const figure = page.locator('.fleet-panel .forecast-chart-figure');

  await expect(figure).toBeVisible();

  /*
   * Polled, like every geometry read in this file: the column is laid out again
   * as the map above it settles and as the fonts resolve, so a single read taken
   * on arrival can be taken mid-reflow.
   */
  await expect
    .poll(async () => panelFit(page), {
      message: 'The fleet chart is not filling the panel it is drawn in.',
    })
    .toBe(FILLS_PANEL);

  const summary = figure.locator('.forecast-chart-summary');
  const table = figure.locator('.forecast-chart-table');

  /*
   * Closed means closed *to a reader*, which is the claim jsdom cannot make: a
   * closed `<details>` keeps its rows in the document, so a DOM count passes
   * either way and only a rendered box tells the two states apart. Playwright's
   * visibility assertions retry, so both directions of the toggle are polled.
   */
  await expect(summary).toBeVisible();
  await expect(table).not.toBeVisible();

  /*
   * Opened with a *keystroke*, because "one keystroke away" is what the
   * treatment promises and a click would prove only the pointer half of it. This
   * is the argument `keyboard-focus.spec.ts` makes for the fleet table's
   * identical fold — a `<details>` that cannot be opened from the keyboard puts
   * the entire table view out of a keyboard reader's reach, with every other
   * assertion unable to see it — applied to the chart's twin, which carries the
   * same relief obligation (`docs/design/chart-treatment.md`). `press` focuses
   * the summary before pressing, so a summary that stopped being
   * keyboard-operable fails here rather than being activated anyway.
   */
  await summary.press('Enter');

  await expect(table).toBeVisible();
});

/**
 * The viewport D15 is a claim about: an ordinary desktop window.
 *
 * The height is the number the case is really about — everything above the
 * chart is measured against it — so it is read off this object rather than
 * written out again in the assertions.
 */
const D15_VIEWPORT = { width: 1280, height: 900 } as const;

/** How far the rendered plot may differ from the height it was drawn at. */
const ONE_TO_ONE_TOLERANCE = 2;

/**
 * What the reading below says when all three claims hold.
 *
 * The issue number stays out of these strings and lives in the comments: the
 * frontend gate reads `#284` in a string literal as a hex colour, which is the
 * gate doing its job on a shape it cannot tell apart from `#284fa1`.
 */
const FITS_FIRST_VIEWPORT = 'fits the first viewport';

test.describe('the first viewport', () => {
  test.use({ viewport: D15_VIEWPORT });

  /*
   * #284 D15: the map, the panel's heading row and the whole plot on one screen.
   *
   * The reason this is a *layout* case and not an arithmetic one is that the
   * stack above the chart is made of text boxes — a header bar, a heading row, a
   * completeness line — whose heights are the font's to decide. The chart's
   * height is the one part of that stack anybody chose (`CHART_VIEW_BOX_HEIGHT`,
   * `src/charts/chart-geometry.ts`), and it was chosen by subtracting the rest
   * from this viewport, which is a sum only a rendered page can check.
   *
   * Nothing here scrolls, deliberately: `boundingBox` is relative to the
   * viewport's own origin, so a case that scrolled first would be asserting that
   * the chart fits on *some* screenful rather than on the first one.
   */
  test('fits the map, the heading row and the whole chart in one desktop viewport (D15)', async ({
    page,
  }) => {
    const chart = page.locator(`.fleet-panel ${PLOT_SVG}`);

    // Both, and polled: the map's canvas is the thing above the chart that
    // arrives late, and a chart measured before the map has taken its band would
    // be measured in a column that is about to move down the page.
    await expect(page.locator('.maplibregl-canvas')).toBeVisible();
    await expect(chart).toBeVisible();

    /*
     * Polled as one reading rather than asserted as three, for the reason
     * `escapedLabels` is: the failure is the diagnosis. A message naming which
     * of the three claims broke, and by how much, is the difference between "the
     * chart moved" and knowing whether it grew, the map grew, or the heading row
     * wrapped to a second line.
     */
    await expect
      .poll(
        async () => {
          const chartBox = await chart.boundingBox();
          const headerBox = await page.locator('.fleet-panel-header').boundingBox();

          if (chartBox === null || headerBox === null) {
            return 'the chart or the panel heading row has no layout box';
          }

          const overhang = chartBox.y + chartBox.height - D15_VIEWPORT.height;
          const scaleError = Math.abs(chartBox.height - CHART_VIEW_BOX_HEIGHT);
          const problems = [
            overhang > 0 ? `the chart runs ${overhang.toFixed(1)}px past the fold` : null,
            headerBox.y + headerBox.height > chartBox.y
              ? 'the panel heading row is not wholly above the chart'
              : null,
            // The 1:1 claim, measured. A chart drawn in a fixed view box and
            // scaled to its column renders at whatever height the aspect ratio
            // dictates, which at this width would be several times this — so this
            // is what tells a 1:1 chart from a scaled one, and it is also what
            // makes the fit above reproducible rather than lucky.
            scaleError > ONE_TO_ONE_TOLERANCE
              ? `the chart rendered ${chartBox.height.toFixed(1)}px tall, ${scaleError.toFixed(1)}px off the height it is drawn at`
              : null,
          ].filter((problem) => problem !== null);

          return problems.length === 0 ? FITS_FIRST_VIEWPORT : problems.join('; ');
        },
        { message: 'The fleet chart does not fit the first desktop viewport (D15).' },
      )
      .toBe(FITS_FIRST_VIEWPORT);
  });

  /*
   * The containment contract again, at this viewport. It is asserted at the
   * default viewport by the resting-state case above; a chart whose labels fit
   * at one width and are clipped at another is the #19 defect arriving through a
   * door neither viewport alone can see, and D15 changed the width the plot's
   * margins have to hold a label in.
   */
  test('keeps its labels inside the plot at the desktop viewport too', async ({ page }) => {
    await expectChartLaidOut(page.locator('.fleet-panel .forecast-chart-figure'));
  });
});

/**
 * A narrow window — the width at which the axis has least room to work with.
 *
 * 500px is not a phone and is not meant to be: it is the width that makes the
 * label budget bite hardest among the viewports this lane can hold the whole
 * dashboard at. The chart's drawing width here is a few hundred pixels for a
 * window that can be two days or a week long, which is where a fixed label count
 * produced the collisions #259 was opened about.
 */
const NARROW_VIEWPORT = { width: 500, height: 800 } as const;

test.describe('a narrow window', () => {
  test.use({ viewport: NARROW_VIEWPORT });

  /*
   * The same contract as the default viewport's resting-state case, at the width
   * that tests it. Both the containment claim and the crowding claim live in
   * `expectChartLaidOut`, and both are width-dependent in opposite directions:
   * a wide plot spreads its labels and clips nothing, a narrow one has to drop
   * labels to keep the ones it draws apart. A chart asserted at only one of the
   * two widths is asserted at the easy one.
   */
  test('keeps its tick labels apart, and inside the plot, at a narrow viewport', async ({
    page,
  }) => {
    await expectChartLaidOut(page.locator('.fleet-panel .forecast-chart-figure'));
  });
});

test('keeps the fleet chart laid out once a selected site is drawn over it', async ({ page }) => {
  /*
   * The same contract in the other state of the same chart. A seeded row, so the
   * site's forecast is answered on the first poll; the first-forecast delay
   * named above belongs to sites this session creates, and nothing here creates
   * one. The row is behind the fleet table's disclosure since #265, so reaching
   * it means opening that first — `site-table.ts` is where that gesture lives.
   */
  const row = await openSiteTable(page);
  const siteName = await row.textContent();

  if (siteName === null) {
    throw new Error('The first site row has no name in it.');
  }

  await row.click();

  const figure = page.locator('.fleet-panel .forecast-chart-figure');

  /*
   * The mark, and then the name. Polled rather than read once because the
   * overlay is a second request that lands after the row is pressed — and both
   * halves are asserted because either alone is satisfiable by a broken chart: a
   * mark with no legend row is a line the reader cannot identify (the treatment's
   * rule that colour never names a series alone), and a legend row with no mark
   * is a chart claiming a series it never drew.
   */
  await expect
    .poll(async () => figure.locator('.forecast-chart-overlay').count())
    .toBeGreaterThan(0);
  await expect(figure.locator('.forecast-chart-legend')).toContainText(siteName);

  // And the geometry still holds with the extra series on the plot. The axis is
  // scaled to what is drawn, so a single site's line under a sixty-site sum is a
  // real change to where the labels land.
  await expectChartLaidOut(figure);
});
