import { expect, test } from '@playwright/test';

import { routeBasemap } from './hermetic-basemap';
import { maybeBoxOf } from './layout-box';

/*
 * One distance: the step between the fleet chart's controls row and the plot it
 * introduces.
 *
 * The row and the body below it touched at 0px until #449, and the chrome read
 * as stuck to the chart it names. The declaration that fixed it —
 * `margin-bottom: var(--space-1)` on `.fleet-chart-controls` — and the whole of
 * its reasoning live in `dashboard/fleet-panel.css`. What did not exist until
 * this file is anything that would notice it going away again.
 *
 * **Why this is not the D15 arm in `chart-surfaces.spec.ts`.** That case
 * compares the same two boxes, and its own docblock says outright that the
 * comparison is `>` and touching is the passing case. That is deliberate and it
 * stays: the arm owns *ordering* — the row wholly above the plot rather than
 * positioned over it, overlapped, or drawn under it — and it is written to keep
 * catching that one defect whatever step is chosen between the two. Which means
 * a margin deleted tomorrow leaves the row touching the plot, and touching is
 * that arm's passing case by construction. The two are complementary rather than
 * duplicate, and a reader meeting both should read them that way: the ordering
 * arm survives any future decision about the size of the gap, and this case is
 * the one that is meant to go red the day the gap changes.
 *
 * **Its own file**, because `chart-surfaces.spec.ts` — the sibling that owns
 * where the chart's marks land — measures 297 code lines against `max-lines`'
 * 300-line ceiling, which is less headroom than this addition needs.
 * `structure.md` rule 4 makes that ceiling a hard one and says to cut rather
 * than grow past it, and the lane already splits a spec off per concern when it
 * bites: `attribution-band.spec.ts` is the precedent, out of
 * `map-regressions.spec.ts` for the same reason. The concern here is the step
 * above the plot, which is not what that file is about.
 *
 * Browser-only by construction (`testing.md` rule 10): a margin is a length the
 * layout engine resolves, and jsdom's `getBoundingClientRect` is zeros all the
 * way down. `fleet-panel.css` can be read for the declaration's *presence* by a
 * CSS-contract test; whether it produces a gap on screen is a question only a
 * laid-out page answers.
 */

/** The two boxes this file is about, and the band they sit in. */
const CONTROLS_ROW = '.fleet-chart-controls';
const PLOT_SVG = '.fleet-chart-section svg.forecast-chart';

/**
 * How far apart the row's bottom edge and the plot's top edge may be.
 *
 * Centred on the 4px that ships. The owner asked for "~5px" and 4px is what the
 * scale can express: `margin` and `/^margin-/` are on stylelint.config.mjs's
 * strict-value list with `ignoreFunctions: false`, so the declaration may only
 * take a bare `var(--space-*)`, and `--space-1` is the quantum nearest the ask.
 * `fleet-panel.css` owns that argument in full; it is summarised here so a
 * reader wondering why the band is centred on 4 rather than 5 finds the answer
 * without leaving the file.
 *
 * A band rather than an equality, because the number is a *rendered* distance:
 * the column's width resolves against a fractional viewport on a scaled display,
 * and both boxes are laid out against font metrics that differ by platform. One
 * pixel either side absorbs that and nothing else — what the floor forbids is
 * the 0px regression, the row and the plot touching again, which is the state
 * the margin was added to leave behind.
 *
 * Written down rather than read off `--space-1` at runtime, on the same
 * principle as `chart-surfaces.spec.ts`'s gutter budgets: a case that resolved
 * the token would agree with whatever value the token took, which is precisely
 * the state this exists to end.
 */
const GAP_FLOOR_PX = 3;
const GAP_CEILING_PX = 5;

/** What the reading below says when the step is the one that shipped. */
const STANDS_OFF_THE_PLOT = 'stands clear of the plot';

test.beforeEach(async ({ page }) => {
  await routeBasemap(page);
  await page.goto('/');
});

test('holds the controls row a token step clear of the chart it introduces', async ({ page }) => {
  const plot = page.locator(PLOT_SVG);

  await expect(plot).toBeVisible();

  /*
   * The map is not waited on, unlike the D15 case's reading, and the difference
   * is what is being measured rather than an oversight: the row and the plot are
   * consecutive in one column, so the map taking its band above them moves both
   * by the same amount and the *difference* between them is invariant under it.
   * The same holds for the chart's own states: the plot is one `<svg>` drawn at
   * an owned height (`CHART_VIEW_BOX_HEIGHT`, `charts/chart-geometry.ts`) in
   * every state the panel has, so there is no settled-versus-loading frame for
   * this number to differ between.
   *
   * Polled all the same, like every geometry read in this lane: the column is
   * laid out again as the fonts resolve, and the failure is the diagnosis — a
   * message carrying the measured step tells a regressed margin (0px) apart from
   * something new arriving between the row and the plot (a notice, which would
   * read as the body's own `--space-2` plus its height).
   */
  await expect
    .poll(
      async () => {
        const plotBox = await maybeBoxOf(plot);
        const rowBox = await maybeBoxOf(page.locator(CONTROLS_ROW));

        if (plotBox === null || rowBox === null) {
          return 'the chart’s controls row or its plot has no layout box';
        }

        const gap = plotBox.y - (rowBox.y + rowBox.height);

        return gap < GAP_FLOOR_PX || gap > GAP_CEILING_PX
          ? `the controls row stands ${gap.toFixed(1)}px clear of the plot, outside the ${String(GAP_FLOOR_PX)}–${String(GAP_CEILING_PX)}px band`
          : STANDS_OFF_THE_PLOT;
      },
      { message: 'The fleet chart’s controls row is not a token step clear of the plot.' },
    )
    .toBe(STANDS_OFF_THE_PLOT);
});
