import type { Locator, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { CHART_VIEW_BOX_HEIGHT } from '../src/charts/chart-geometry';
import { routeBasemap } from './hermetic-basemap';
import { layoutBoxOf, maybeBoxOf, settledBoxOf } from './layout-box';
import { revealSiteMarker } from './marker-reveal';
import { PHONE_VIEWPORT } from './viewports';

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
 * why `TOOLTIP_CHAR_WIDTH` in `tooltip-geometry.ts` sizes columns from an
 * estimated mean advance rather than a measurement, and why the chart's own
 * measurement finds nothing to adopt there and every suite draws at
 * `DEFAULT_CHART_WIDTH`
 * (`use-chart-width.ts`). So the chart's own suite under `src/` can assert the
 * attributes the component wrote and never the pixels they turned into. That is
 * exactly the class of defect #19 kept producing: labels clipped at the canvas
 * edge, and elements that mounted at zero height. D15 produced one more of them
 * on its way in — at 1:1 the plot's right margin stopped scaling up with the
 * panel, and the last time-axis label, centred on that edge, hung 13.8px past
 * the canvas.
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
 * loses — the #19 horizon label, since deleted by #429, ran off the plot by most
 * of its width, and D15's own clipped tick label by 0.98 of its height.
 */
const LABEL_CONTAINMENT_TOLERANCE = 0.25;

/**
 * The plot, named rather than inferred.
 *
 * `.forecast-chart-figure` used to hold four `<svg>` elements — the chart, and
 * one swatch per legend row — and this selector was what stopped a bare `svg`
 * measuring a 28x14 swatch with no text in it. The legend has since moved into
 * the (i) popover, so the figure holds exactly one `<svg>` now and a bare query
 * would find the right element by luck.
 *
 * The class stays because that is the fact it refuses to depend on. The figure's
 * `<svg>` count has already changed once under this constant, and the reads
 * below are all about the plot's own box — so naming the plot keeps them
 * measuring the plot on the day something else is drawn inside the figure again,
 * instead of measuring whatever the DOM happened to order first.
 */
const PLOT_SVG = 'svg.forecast-chart';

/**
 * The full-width band the chart lives in since #323, and the figure inside it.
 *
 * Named rather than written out at each of the ten reads below, which is what
 * this file's own history argues for: the band was `.fleet-panel` until #323
 * turned the card into a section, and the rename cost ten identical edits here
 * alone (`structure.md` rule 7). One constant is one edit next time.
 *
 * Scoped to the band rather than bare, because the page draws legend swatches and
 * — while a site is selected — a popover of its own; a bare `.forecast-chart-figure`
 * would be a claim about whichever figure the DOM happened to order first.
 */
const CHART_SECTION = '.fleet-chart-section';
const CHART_FIGURE = `${CHART_SECTION} .forecast-chart-figure`;

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
 * How far the plot's right edge may sit from its section's before the chart is
 * not filling the section, in pixels.
 *
 * The chart section pads itself *horizontally* by one `--space-4` step
 * (`dashboard/fleet-panel.css` owns that, and the token owns the length), so a
 * chart filling its column still stops that step short of the section's *border*
 * box — which is the box `boundingBox` reports. The axis is named because the two
 * stopped agreeing in #323: the vertical step is `--space-2` now, and this budget
 * is about the horizontal one alone. It is that one step at the default root size
 * plus a little sub-pixel slack, and nothing more. What it has to catch is the
 * chart being held to a *measure* narrower than its column, which before #284 D3
 * left it short by most of the section's width at the default viewport; a budget
 * loose enough to admit that would be measuring nothing.
 */
const PANEL_FILL_TOLERANCE = 18;

/** What `panelFit` says when the plot is filling its section. */
const FILLS_PANEL = 'fills its section';

/**
 * The *drawn* plot, as opposed to the canvas it is drawn on.
 *
 * `panelFit` above measures the `<svg>`, which fills its column by CSS and
 * therefore always passes the moment the column is right; what a reader sees as
 * the chart's edge is the plot rect inside it, held off the canvas by the
 * margins the axis labels need (`src/charts/chart-geometry.ts`). Those are the
 * two different questions, and the owner's #430 complaint — a gap on the right
 * "equivalent to the width of the y axis" — is the second one: the svg was
 * filling the section perfectly while the plot stopped 32px inside it.
 *
 * This element is the plot's geometry and nothing else:
 * `forecast-chart-hover-boundary.tsx` sizes it from `scale.plot`, so measuring
 * it is measuring where the marks may go. It used to be sized that way so a
 * reader could aim anywhere in the plot; since #421 the pointer is heard by the
 * `<svg>` around it — plot *and* both axis gutters — with an x the plot does not
 * contain clamped into the one it does, so aiming is the canvas's business and
 * these four edges are held here purely as the drawn plot's box. The widened
 * target is measured in `e2e/chart-tap.spec.ts`; what is measured here is
 * unchanged by it.
 */
const PLOT_RECT = '.forecast-chart-pointer-target';

/** How far the drawn plot's two edges sit inside its section's content box. */
interface PlotEdgeGaps {
  readonly left: number;
  readonly right: number;
}

/**
 * That reading, in rendered pixels — `null` where either box is missing.
 *
 * Against the section's **content** box, not the border box `boundingBox`
 * reports, and the padding is read off the element rather than written down
 * here: `dashboard/fleet-panel.css` chooses that step and the token owns the
 * length, so a spec that restated it would fail on a padding change that broke
 * nothing (`architecture.md` rule 9). `PANEL_FILL_TOLERANCE` above does restate
 * it, and says so; one such restatement in this file is enough.
 *
 * Both edges in one reading because they are one question asked twice, and
 * because a single `page.evaluate` cannot be caught halfway between two
 * differently-timed reads of a column that is still settling.
 */
const plotEdgeGaps = async (page: Page): Promise<PlotEdgeGaps | null> =>
  page.locator(CHART_SECTION).evaluate((section, selector) => {
    const plot = section.querySelector(selector)?.getBoundingClientRect();

    if (plot === undefined) {
      return null;
    }

    const box = section.getBoundingClientRect();
    const padding = globalThis.getComputedStyle(section);

    return {
      left: plot.left - (box.left + Number.parseFloat(padding.paddingLeft)),
      right: box.right - Number.parseFloat(padding.paddingRight) - plot.right,
    };
  }, PLOT_RECT);

/**
 * How far the plot's right edge may sit inside its section's content edge.
 *
 * A **ceiling**, and the half of the contract the containment poll cannot
 * state. Containment is the floor: a margin too small clips the last time-axis
 * label, and `escapedLabels` fails. Nothing until #430 said the margin must not
 * be *larger* than the label needs — so it was 32 against a requirement of
 * 22.19 (half of `Wed 29` at the shipping type, measured), and the plot gave up
 * a tenth of a phone's chart to hold nothing. The two together pin it from both
 * sides, which is why this is a separate case rather than a tighter tolerance
 * on `panelFit`.
 *
 * 25 is the 24 the chart ships plus a pixel, and the pixel is for sub-pixel
 * layout rather than for slack in the margin: the section's padding and the
 * svg's `width: 100%` both resolve against a fractional viewport on a scaled
 * display. It is deliberately not derived from `chart-geometry.ts` — importing
 * the constant would make a case that passes at any margin, which is precisely
 * the state this exists to leave behind.
 */
const PLOT_RIGHT_GAP_BUDGET = 25;

/**
 * The same ceiling on the left, at the widths the thinner gutter is used at.
 *
 * 51 for the 50 the narrow gutter ships. It is a different number from the one
 * above rather than the same claim twice: this gutter holds the rotated
 * `Power (kW)` title *and* a whole kW label, where the right margin holds half
 * of one time label, so the two are only ever equal by coincidence. What it
 * catches is the width-dependent gutter silently not applying — a threshold
 * retuned past these viewports, or `chartPlot` losing its argument — which
 * leaves a chart that is correct in every other assertion in this file and 6px
 * narrower than the owner asked for.
 */
const NARROW_PLOT_LEFT_GAP_BUDGET = 51;

/** What the reading below says when the plot reaches both of those edges. */
const REACHES_ITS_SECTION = 'reaches its section’s content edges';

/**
 * Whether the drawn plot reaches its section's content edges, described — the
 * same reading-is-the-diagnosis shape as `escapedLabels` and `panelFit`.
 *
 * `leftBudget` is a parameter because the left gutter is the one margin that
 * varies with the width the chart is drawn at (#430), so a caller has to say
 * which regime it is asserting; the right margin is one distance everywhere and
 * is not.
 */
const plotEdgeFit = async (page: Page, leftBudget: number): Promise<string> => {
  const gaps = await plotEdgeGaps(page);

  if (gaps === null) {
    return 'the fleet chart section or its plot rect has no layout box';
  }

  const problems = [
    gaps.right > PLOT_RIGHT_GAP_BUDGET
      ? `the plot stops ${gaps.right.toFixed(1)}px inside the section's right edge (budget ${String(PLOT_RIGHT_GAP_BUDGET)}px)`
      : null,
    gaps.left > leftBudget
      ? `the plot starts ${gaps.left.toFixed(1)}px inside the section's left edge (budget ${String(leftBudget)}px)`
      : null,
  ].filter((problem) => problem !== null);

  return problems.length === 0 ? REACHES_ITS_SECTION : problems.join('; ');
};

/** The wide gutter, which is what every viewport above the threshold draws. */
const WIDE_PLOT_LEFT_GAP_BUDGET = 57;

/**
 * Whether the plot fills the section it is in, described.
 *
 * A description rather than a number for the same reason `escapedLabels` above
 * returns descriptions: the reading is the diagnosis. Signed, so both failures
 * are one measurement — a chart short of its section (the D3 defect) and a chart
 * overhanging it (a plot spilling out of the band it lives in) are equally wrong
 * and read differently in the message.
 */
const panelFit = async (page: Page): Promise<string> => {
  const panel = await maybeBoxOf(page.locator(CHART_SECTION));
  const plot = await maybeBoxOf(page.locator(`${CHART_SECTION} ${PLOT_SVG}`));

  if (panel === null || plot === null) {
    return 'the fleet chart section or its plot has no layout box';
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
   * The zero-height class of defect — a chart mounted into a container with no
   * measured size, which is the one thing a `role="img"` with a good accessible
   * name still hides.
   *
   * The pair earns its place here, and the reason is which element the gate
   * above is on. `toBeVisible` was asserted of the *figure*, and Playwright's
   * visibility is a claim about that element's own box: an ancestor with a
   * perfectly good box says nothing whatever about a descendant's, and the plot
   * inside a laid-out figure is exactly the thing that can be collapsed to
   * nothing here. So this is not the same assertion twice, as it would be if the
   * gate and the measurement named one element (#404 — `composition.spec.ts` had
   * that shape and lost the pair).
   *
   * The read is polled because the plot's box arrives as the column settles, and
   * it is the poll that makes the gate the element actually measured.
   */
  const box = await layoutBoxOf(figure.locator(PLOT_SVG), 'The chart figure’s plot');

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
  await expectChartLaidOut(page.locator(CHART_FIGURE));
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
  const figure = page.locator(CHART_FIGURE);

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

  /*
   * Scoped to the section rather than to the figure: since 2026-08-11 the twin
   * is a panel *after* the figure instead of a row inside it, so a figure-scoped
   * locator would resolve to nothing and every assertion below would fail on a
   * chart that is behaving perfectly (`charts/ForecastChart.tsx` carries the
   * move). The band is kept as the scope even so, though the reason weakened on
   * 2026-08-12: the fleet's table was the page's other disclosure and #451 took
   * it away, so this now guards against a second chart arriving rather than
   * against a neighbour that is there today.
   */
  const summary = page.locator(`${CHART_SECTION} .forecast-chart-summary`);
  const table = page.locator(`${CHART_SECTION} .forecast-chart-table`);

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
   * treatment promises and a click would prove only the pointer half of it. A
   * `<details>` nothing can open from the keyboard puts the entire table view
   * out of a keyboard reader's reach, with every other assertion here unable to
   * see it — and that view is the chart's own relief obligation
   * (`docs/design/chart-treatment.md`), so reaching it is the obligation rather
   * than a convenience. The fleet's table made the identical argument for its
   * identical fold until #451 removed it, and this is the case that carries it
   * now. `press` focuses the summary before pressing, so a summary that stopped
   * being keyboard-operable fails here rather than being activated anyway.
   */
  await summary.press('Enter');

  await expect(table).toBeVisible();
});

/*
 * #430's right-hand half, at the viewport a visitor opens the app in. The owner
 * asked for the graph to "fill the remaining width on the RHS", where it was
 * stopping a whole y-axis gutter short of one — and the case that would have
 * caught it did not exist, because the assertion this file already had measures
 * the svg and the svg was filling the section the whole time. This measures the
 * plot instead.
 *
 * Polled, like every geometry read here: the column is laid out again as the map
 * settles and as the fonts resolve.
 */
test('draws its plot out to the section’s edges, not just its canvas', async ({ page }) => {
  await expect(page.locator(`${CHART_SECTION} ${PLOT_RECT}`)).toBeVisible();

  await expect
    .poll(async () => plotEdgeFit(page, WIDE_PLOT_LEFT_GAP_BUDGET), {
      message: 'The fleet chart is drawing its plot short of the section it fills.',
    })
    .toBe(REACHES_ITS_SECTION);
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
   * #284 D15: the map, the row of controls over the chart, and the whole plot on
   * one screen. The separate heading row that phrasing named went in #323, and
   * what is above the plot — and what is measured below — has been one element
   * since: `.fleet-chart-controls`. The owner's 2026-08-11 reversal put the
   * heading and the fleet's numbers back *onto that row* rather than above it,
   * so the thing measured here is unchanged and so is its height: the row is one
   * flex line whose tallest item is still the picker (`charts/chart-geometry.ts`
   * adds the stack up and states why `CHART_VIEW_BOX_HEIGHT` did not move).
   *
   * The reason this is a *layout* case and not an arithmetic one is that the
   * stack above the chart is made of text boxes — a header bar, a row of chips —
   * whose heights are the font's to decide. The chart's height is the one part of
   * that stack anybody chose (`CHART_VIEW_BOX_HEIGHT`,
   * `src/charts/chart-geometry.ts`), and that docblock's arithmetic is a sum only
   * a rendered page can check.
   *
   * Nothing here scrolls, deliberately: `boundingBox` is relative to the
   * viewport's own origin, so a case that scrolled first would be asserting that
   * the chart fits on *some* screenful rather than on the first one.
   */
  test('fits the map, the controls row and the whole chart in one desktop viewport (D15)', async ({
    page,
  }) => {
    const chart = page.locator(`${CHART_SECTION} ${PLOT_SVG}`);

    // Both, and polled: the map's canvas is the thing above the chart that
    // arrives late, and a chart measured before the map has taken its band would
    // be measured in a column that is about to move down the page.
    await expect(page.locator('.maplibregl-canvas')).toBeVisible();
    await expect(chart).toBeVisible();

    /*
     * Polled as one reading rather than asserted as three, for the reason
     * `escapedLabels` is: the failure is the diagnosis. A message naming which
     * of the three claims broke, and by how much, is the difference between "the
     * chart moved" and knowing whether it grew, the map grew, or the controls row
     * left the flow above it.
     *
     * What the controls row's box is doing in the reading, now that the row it
     * replaced carried the section's heading: it is the one part of the stack
     * above the plot that this file can see at all, and reading it keeps the
     * failure legible — a row with no box is a row that never rendered, which is
     * a different defect from a chart in the wrong place. Its *height* is not
     * asserted, deliberately. A row that wraps to a second line pushes the plot
     * down rather than over it, so that failure arrives as an overhang and is the
     * first arm's to report; what the second arm catches is the row leaving the
     * flow — positioned, overlapped, or drawn under the plot it introduces.
     * Normal flow puts the plot's top at the row's bottom plus whatever margin
     * the row carries — 4px of it since #449 — so the comparison is `>` and
     * touching is the passing case, which is what it takes for the arm to keep
     * catching only that one defect whatever the step between them is. That
     * leaves the 4px itself unowned *here*, deliberately, and it is owned:
     * `chart-controls-gap.spec.ts` is the case that pins it, in its own file
     * because this one is at `max-lines`' ceiling. The two are complementary —
     * this arm survives any future decision about the size of the step, that one
     * is meant to go red the day the step changes.
     */
    await expect
      .poll(
        async () => {
          const chartBox = await maybeBoxOf(chart);
          const controlsBox = await maybeBoxOf(page.locator('.fleet-chart-controls'));

          if (chartBox === null || controlsBox === null) {
            return 'the chart or the section’s controls row has no layout box';
          }

          const overhang = chartBox.y + chartBox.height - D15_VIEWPORT.height;
          const scaleError = Math.abs(chartBox.height - CHART_VIEW_BOX_HEIGHT);
          const problems = [
            overhang > 0 ? `the chart runs ${overhang.toFixed(1)}px past the fold` : null,
            controlsBox.y + controlsBox.height > chartBox.y
              ? 'the section’s controls row is not wholly above the chart'
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
    await expectChartLaidOut(page.locator(CHART_FIGURE));
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
    await expectChartLaidOut(page.locator(CHART_FIGURE));
  });

  /*
   * #430's other half: at this width the gutter is the thinner one, and the
   * case above is what proves the six units it gave back were not taken out of
   * a label. The two are the ceiling and the floor on the same distance, and
   * running both here is the whole of what makes either safe to tighten.
   */
  test('spends the thinner gutter at a narrow viewport', async ({ page }) => {
    await expect(page.locator(`${CHART_SECTION} ${PLOT_RECT}`)).toBeVisible();

    await expect
      .poll(async () => plotEdgeFit(page, NARROW_PLOT_LEFT_GAP_BUDGET), {
        message: 'The fleet chart is not using the narrow gutter at a narrow viewport.',
      })
      .toBe(REACHES_ITS_SECTION);
  });
});

/*
 * A phone, where the owner's complaint was made: "the axis takes up too much of
 * the screen on those devices".
 *
 * A separate describe from the narrow window above rather than a second width in
 * that one, because the two are different claims about the same geometry — 500px
 * is where the *label budget* bites hardest, and this is where the *gutter* costs
 * most as a share of the canvas. The section gives the chart 358px here, so the
 * two margins were a quarter of it before #430 and are a fifth after.
 *
 * The width comes from `./viewports` rather than a fourth declaration of 390x844
 * in this lane (#404).
 */
test.describe('a phone', () => {
  test.use({ viewport: PHONE_VIEWPORT });

  test('spends the thinner gutter at a phone width', async ({ page }) => {
    await expect(page.locator(`${CHART_SECTION} ${PLOT_RECT}`)).toBeVisible();

    await expect
      .poll(async () => plotEdgeFit(page, NARROW_PLOT_LEFT_GAP_BUDGET), {
        message: 'The fleet chart is not using the narrow gutter at a phone width.',
      })
      .toBe(REACHES_ITS_SECTION);
  });

  /*
   * And the floor, at the width where the gutter has least room to be wrong in.
   * This is the case that would fail if the thinner gutter had been bought by
   * clipping the `Power (kW)` title or a kW label against the canvas edge —
   * which a gap measurement cannot see, because a clipped label leaves the plot
   * exactly where the geometry put it.
   */
  test('keeps its labels inside the plot in the thinner gutter', async ({ page }) => {
    await expectChartLaidOut(page.locator(CHART_FIGURE));
  });
});

test('keeps the fleet chart laid out once a selected site is drawn over it', async ({ page }) => {
  /*
   * The same contract in the other state of the same chart. A seeded site, so
   * its forecast is answered on the first poll; the first-forecast delay named
   * above belongs to sites this session creates, and nothing here creates one.
   * The map is where a site is selected since #451, and the demo fleet starts
   * clustered — so reaching one marker means zooming in first, which is what
   * `marker-reveal.ts` owns. The marker's `aria-label` is the site's name
   * (`src/map/MarkerButton.tsx`), which is what the legend below is checked for.
   */
  const marker = await revealSiteMarker(page);
  const siteName = await marker.getAttribute('aria-label');

  if (siteName === null) {
    throw new Error('The revealed site marker has no name on it.');
  }

  await marker.click();

  const figure = page.locator(CHART_FIGURE);

  /*
   * The mark, and then the name. Polled rather than read once because the
   * overlay is a second request that lands after the marker is pressed — and both
   * halves are asserted because either alone is satisfiable by a broken chart: a
   * mark with no legend row is a line the reader cannot identify (the treatment's
   * rule that colour never names a series alone), and a legend row with no mark
   * is a chart claiming a series it never drew.
   *
   * The name half is read out of the (i)'s panel since 2026-08-11, when the
   * owner's round moved the legend off the plot and behind that press (#429) —
   * so the tip is opened here, after the mark has landed, and the row is looked
   * for there rather than in the figure. What is being asserted is unchanged:
   * the drawn line has a name a reader can reach. It is opened *after* the poll
   * on purpose, because a legend read before the overlay arrives would be a
   * legend that honestly has no row for it yet.
   */
  await expect
    .poll(async () => figure.locator('.forecast-chart-overlay').count())
    .toBeGreaterThan(0);
  const tipButton = page.locator('.fleet-chart-section .info-tip-button');

  await tipButton.click();
  await expect(page.locator('.fleet-chart-section .info-tip-panel')).toContainText(siteName);
  // Put it away before measuring: the geometry claim below is about the chart a
  // reader sees, and a sheet floated over the top of it is not part of that.
  await tipButton.click();

  // And the geometry still holds with the extra series on the plot. The axis is
  // scaled to what is drawn, so a single site's line under a sixty-site sum is a
  // real change to where the labels land.
  await expectChartLaidOut(figure);
});

/**
 * Where the pointer arrives on the plot, and where it parks, as shares of the
 * plot's rendered width.
 *
 * Both are well inside the plot's own box, and since #421 that is no longer
 * because it is the only place a pointer is heard: the `<svg>` hears one across
 * the whole figure, both axis gutters included, and an x the plot does not
 * contain is clamped into the one it does
 * (`src/charts/forecast-chart-hover-boundary.tsx`, measured in
 * `e2e/chart-tap.spec.ts`). Both values stand unchanged all the same — a share
 * out in a gutter now reads the clamped edge sample, so a sweep between two of
 * them would travel nowhere and prove nothing. Both are also on the same side of the
 * point where the panel flips to the *left* of the pointer to stay on the canvas
 * (`tooltipAnchorX`, `src/charts/chart-geometry.ts`): that flip moves the anchor
 * backwards by the panel's whole width, and a sweep straddling it would be
 * asserting a rightward travel the chart never promised. Nothing here has to
 * know where the flip is, which is the point of measuring travel rather than
 * position below — a sweep that started straddling it fails naming the distance
 * it actually moved.
 */
const SWEEP_ARRIVAL = 0.4;
const SWEEP_PARKING = 0.7;

/**
 * Intermediate positions in the closing move, so it is a pointer *stream* and
 * not a jump.
 *
 * The stream is what this case exists to run: a single teleporting move would be
 * one event, which any implementation lands correctly, while a run of them is
 * what the panel's frame budget (`POINTER_FRAME_MS`, `src/charts/chart-hover-input.ts`)
 * drops all but one of — and dropping the *last* one is the freeze this case
 * ends by ruling out.
 */
const SWEEP_STEPS = 12;

/**
 * The panel's left edge in view-box units, read back out of the tooltip group's
 * `transform`; `Number.NaN` where no tooltip is drawn.
 *
 * A lane-local twin of `tooltipAnchor` in `src/charts/forecast-chart-test-fixture.tsx`,
 * duplicated deliberately (`structure.md` rule 7). The two run in different
 * runtimes — this body is serialised into the page and executed by the browser,
 * that one runs inside the vitest process against a jsdom container — so there
 * is no module both could import even if they wanted one. What they have in
 * common is one attribute's shape, which either would fail loudly on rather than
 * silently, and they are free to diverge in everything else: the fixture wants an
 * exact user-unit coordinate from a component it rendered itself, and this wants
 * whatever a real pointer over a real build put there.
 */
const tooltipAnchor = async (figure: Locator): Promise<number> =>
  figure.evaluate((element) => {
    const transform = element.querySelector('.forecast-chart-tooltip')?.getAttribute('transform');
    const anchor = /translate\((?<x>[-\d.]+)/u.exec(transform ?? '')?.groups?.x;

    return anchor === undefined ? Number.NaN : Number(anchor);
  });

/**
 * How far the panel's travel may differ from the pointer's, in pixels.
 *
 * The two are the same distance and not merely proportional, which is the whole
 * claim: a client x becomes a view-box x by dividing by the rendered width and
 * multiplying by the view box (`pointerSample`, `src/charts/chart-hover-input.ts`),
 * and since #284 D15 those are the same number, so a pointer that moved 300px
 * moves the anchor 300 user units. The slack is sub-pixel arithmetic and the
 * `Math.round` the measured width goes through (`use-chart-width.ts`) — the same
 * order of error `ONE_TO_ONE_TOLERANCE` above absorbs, and orders below the
 * failure this has to catch, which is a panel that stopped at a frame the sweep
 * passed through rather than at the one it ended on.
 */
const TRAVEL_TOLERANCE = 2;

/** What the settled reading says when the panel is where the pointer left it. */
const LANDED_WITH_THE_POINTER = 'landed where the pointer stopped';

/*
 * The hover readout under a real pointer, which is the half jsdom cannot see.
 *
 * `forecast-chart-tooltip.test.tsx` owns everything about this layer that is
 * arithmetic — which sample an x snaps to, where the panel sits beside it, that
 * a held frame lands — and it owns it against a stubbed `getBoundingClientRect`
 * and fake timers, feeding the component client coordinates it invented. Two
 * things are therefore untested until a browser runs it: the conversion from a
 * client x to a view-box x, which needs a plot with a real rendered width, and a
 * genuine pointer stream under real timers, where the frame budget is a wall
 * clock rather than a `vi.advanceTimersByTime` (`testing.md` rule 10).
 *
 * Travel and not position, throughout. Where the panel *is* depends on the
 * width the column happened to give the chart, which is not this case's
 * business; how far it moved when the pointer moved is the contract, and it is
 * one number at every viewport.
 */
test('follows a real pointer across the plot and lands where it stops', async ({ page }) => {
  const figure = page.locator(CHART_FIGURE);
  const plot = figure.locator(PLOT_SVG);

  // The map is what pushes the panel down the page after first paint, so it is
  // waited on before a single coordinate is computed — the same reason the D15
  // case above waits for the canvas.
  await expect(page.locator('.maplibregl-canvas')).toBeVisible();
  await expect(plot).toBeVisible();

  const box = await settledBoxOf(plot, 'The plot');
  const pointerY = box.y + box.height / 2;
  const pointerXAt = (share: number): number => box.x + box.width * share;
  const pointerTravel = box.width * (SWEEP_PARKING - SWEEP_ARRIVAL);

  /*
   * Arriving is one `pointermove` and nothing else — no click, no dwell. The
   * readout opens on the first event the plot's target rect sees, which is what
   * the treatment's "the pointer never has to land on a line" costs.
   */
  await page.mouse.move(pointerXAt(SWEEP_ARRIVAL), pointerY);
  await expect(figure.locator('.forecast-chart-tooltip')).toHaveCount(1);

  const arrivalAnchor = await tooltipAnchor(figure);

  await page.mouse.move(pointerXAt(SWEEP_PARKING), pointerY, { steps: SWEEP_STEPS });

  /*
   * Both halves of the layer, because either alone is satisfiable by a broken
   * one: a panel with no crosshair is a readout with nothing marking the sample
   * it is reading, and the crosshair is the piece that has to *stay* attached
   * while the panel moves independently of it (#284 D7).
   */
  await expect(figure.locator('.forecast-chart-crosshair')).toHaveCount(1);
  await expect
    .poll(async () => tooltipAnchor(figure), {
      message: 'The panel did not move at all while the pointer swept across the plot.',
    })
    .toBeGreaterThan(arrivalAnchor);

  /*
   * The trailing flush, under a real clock: the pointer has stopped, so nothing
   * more is coming, and the panel has to end up where the reader parked the
   * cursor rather than at whichever frame the throttle last let through. Two
   * equal reads a poll interval apart is "it has stopped"; the travel is "it
   * stopped in the right place". Polled rather than slept on, because the state
   * being waited for is a settled anchor and this lane keeps no retry budget to
   * hide a sleep that was a little short.
   */
  let previous = Number.NaN;

  await expect
    .poll(
      async () => {
        const current = await tooltipAnchor(figure);
        const held = current === previous;
        const travelled = current - arrivalAnchor;
        previous = current;

        if (!held) {
          return `the panel is still moving (anchor ${current.toFixed(1)})`;
        }

        return Math.abs(travelled - pointerTravel) <= TRAVEL_TOLERANCE
          ? LANDED_WITH_THE_POINTER
          : `the panel travelled ${travelled.toFixed(1)}px against the pointer's ${pointerTravel.toFixed(1)}px`;
      },
      { message: 'The panel froze short of where the pointer stopped.' },
    )
    .toBe(LANDED_WITH_THE_POINTER);
});
