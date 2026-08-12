import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { routeBasemap } from './hermetic-basemap';
import { RANGE_TRIGGER } from './range-picker';

/*
 * What the browser paints when the reader arrived by pointer — mouse or finger:
 * nothing.
 *
 * `design.md` rule 11 (P11) splits focus into two interactions that look
 * identical to `document.activeElement` and completely different to a reader. A
 * keyboard reader needs the ring — it is the only thing telling them where they
 * are standing (WCAG 2.4.7). Someone who just clicked or tapped already knows
 * where they are, and a ring blooming under their finger is the rule's named
 * defect signal. `:focus-visible` is normally the CSS that tells the two apart,
 * and never bare `:focus`; where an engine's own heuristic gets a pointer focus
 * wrong, the element observes how its focus arrived and suppresses the ring
 * itself — which is what `charts.css` does, and what the chart case below is for.
 *
 * Either way the distinction is a *judgement about how focus arrived*, which is
 * exactly what `testing.md` rule 10 routes out of jsdom: jsdom implements no
 * heuristic, computes no styles and paints no ring, so a component test can
 * prove an element took focus and nothing whatever about what the reader sees.
 * Only a real Chromium reached by a real mouse or a real finger can answer this.
 *
 * Each case below is therefore two assertions rather than one, and the pairing
 * is the whole of why it means anything. Focus first, because "no ring painted"
 * is trivially true of an element that took no focus at all — a control that had
 * stopped being focusable would sail through the ring assertion on its own while
 * being thoroughly broken. Focus moved *and* nothing painted is the conjunction
 * the rule is actually about.
 *
 * Two arms, because a mouse and a finger are different inputs and only one of
 * them was measured here until #440. Everything above the `test.describe` at the
 * foot of this file is a mouse; inside it `hasTouch` makes `Locator.tap`
 * dispatch a real touch pointer. A spec that said "pointer" while only ever
 * clicking is precisely what let the touch path go unmeasured, so the arms are
 * named rather than merged.
 *
 * Honest scope, and the two kinds of case here are not the same kind of evidence.
 *
 * Most of them pass on the tree that preceded them. Issue 339 audited every focus
 * rule in the repo and found `:focus-visible` throughout, so there was no bare
 * `:focus` here to fix and those cases — both mouse cases, and the range picker's
 * touch twin — assert a property the app already had. They exist as a ratchet: a
 * future bare `:focus`, or a ring hand-rolled in JS and forced on regardless of
 * how focus arrived, fails here. Lint is the fast half of that catch —
 * `selector-pseudo-class-disallowed-list` in `stylelint.config.mjs`, added by the
 * same issue — and this is the half that still sees the regressions a linter
 * reads as innocent.
 *
 * The chart's tap case is the other kind, and it is worth reading as such: it
 * asserts something that was measurably *false* before #440. A `hasTouch`
 * Chromium probe on the tapped chart found the focus taken,
 * `element.matches(':focus-visible')` false, and a ring painted anyway. Whatever
 * paints that ring, an author selector carrying that conjunct is evaluated by the
 * same engine that answered false, so it cannot match and the suppression would
 * simply stop working — which is why the guard in
 * `src/charts/forecast-chart-hover-boundary.tsx` observes the focus's source
 * instead, and why the one rule it feeds in `src/charts/charts.css` carries no
 * pseudo-class. Those two are what turned this case green, so it is a regression
 * test rather than a ratchet.
 *
 * And this spec must never be read as covering keyboard rings. Every assertion
 * in it is satisfied by an app that paints no rings at all, which would be a
 * WCAG 2.4.7 failure of the worst kind. `keyboard-focus.spec.ts` holds that end
 * — it measures the same outline and demands `solid` at a non-zero width, on a
 * site's marker on the map and on this same chart — and the two bound rule 11
 * only together. Neither is meaningful alone, so a change that deletes one should be
 * read as deleting half a rule.
 */

/**
 * The chart's `Raw data` disclosure control (`charts/forecast-chart-table.tsx`).
 *
 * The page's surviving `<summary>` since #451 took the fleet's table off it,
 * which is what this case measured before. Written out here rather than reached
 * through a helper: the click *is* the measurement, so a helper performing it
 * would be the assertion answering itself.
 */
const RAW_DATA_SUMMARY = '.forecast-chart-summary';

/**
 * The fleet chart's canvas — since #421 the element the pointer lands on, axis
 * gutters included, rather than the plot rect inside it.
 */
const CHART_SVG = 'svg.forecast-chart';

/** What the browser decided to paint around the focused element. */
interface FocusRing {
  /** CSS `outline-style`; `none` is the shape of a ring that never painted. */
  readonly style: string;
  readonly widthPx: number;
}

/*
 * A local twin of `keyboard-focus.spec.ts`'s helper of the same name, and a
 * deliberate one (`structure.md` rule 7). The two have the same intent — read
 * the outline the browser actually computed — so the rule points at extracting
 * one `e2e/focus-ring.ts` that both specs import, and that is the right end
 * state. It is not done in this change because that edit lands in a file this
 * change does not own, while the keyboard spec is itself being revised in the
 * same batch; extracting across two moving files is how a merge eats an
 * assertion. Recorded here rather than duplicated quietly.
 */
const focusRing = async (page: Page, selector: string): Promise<FocusRing> =>
  page.locator(selector).evaluate((element) => {
    const computed = getComputedStyle(element);

    return { style: computed.outlineStyle, widthPx: Number.parseFloat(computed.outlineWidth) };
  });

/**
 * Whether the measured ring is one a reader can actually see.
 *
 * Both halves, because either alone gets the answer wrong in one direction: a
 * `solid` outline of zero width paints nothing, and `outline-style: none` still
 * reports whatever width was set behind it. A ring is real only when the style
 * draws and the width is non-zero.
 */
const paintsARing = (ring: FocusRing): boolean => ring.style !== 'none' && ring.widthPx > 0;

/**
 * Press an element the way somebody with a mouse presses it, and measure what
 * the browser painted.
 *
 * `Locator.click` rather than `dispatchEvent` or `.focus()` deliberately: this
 * spec's entire subject is the browser's judgement about *how* focus arrived, and
 * a synthesised event or a programmatic focus call is the one input modality that
 * would not exercise it. A scroll first because a target below the fold is not
 * clickable, and Playwright's own auto-scroll is left visible here rather than
 * relied on silently.
 *
 * The focus assertion lives inside this helper because it is a precondition of
 * the measurement rather than a separate finding — without it the returned ring
 * describes an element nobody focused, and "no ring" would be a hollow pass.
 */
const ringAfterPointerClick = async (page: Page, selector: string): Promise<FocusRing> => {
  const target = page.locator(selector);

  await target.scrollIntoViewIfNeeded();
  await target.click();
  await expect(target).toBeFocused();

  return focusRing(page, selector);
};

/**
 * Press an element the way somebody with a finger presses it, and measure what
 * the browser painted.
 *
 * A twin of the helper above rather than one function with a gesture flag, and
 * deliberately (`structure.md` rule 7): the two arms have different intent and
 * are free to diverge — a touch gesture that needed a settle, or a second finger,
 * would change this one and leave the mouse one correct. `Locator.tap` is the
 * whole point of it, since a click here would be the mouse case under another
 * name; the tap needs `hasTouch` on the context, which is why every caller sits
 * inside the describe that sets it.
 *
 * The focus assertion is the same precondition it is above, and on the chart it
 * earns its keep twice: taking the focus a tap gives it is exactly what #440
 * required the chart to keep doing, so a "fix" that stopped the ring by making
 * the element unfocusable has to fail here rather than pass quietly.
 */
const ringAfterTap = async (page: Page, selector: string): Promise<FocusRing> => {
  const target = page.locator(selector);

  await target.scrollIntoViewIfNeeded();
  await target.tap();
  await expect(target).toBeFocused();

  return focusRing(page, selector);
};

test.beforeEach(async ({ page }) => {
  await routeBasemap(page);
  await page.goto('/');

  /*
   * The map is what the page lays out around and both targets sit below it, so
   * waiting for its canvas means the click lands on settled geometry rather than
   * on an element the mounting map is still pushing down the page. A click that
   * misses would fail as an unexplained timeout somewhere else entirely.
   */
  await expect(page.locator('.maplibregl-canvas')).toBeVisible();
});

test('paints no ring on the range picker’s trigger when a pointer presses it', async ({ page }) => {
  /*
   * The calendar trigger, and not for convenience. This case measured the
   * already-pressed chip until the 2026-08-11 fold, on the grounds that pressing
   * the current window is a real gesture changing no state — so the selector
   * still resolved to the element that was clicked, where pressing an unpressed
   * chip would have moved the pressed state and left the ring measured on a
   * button nobody touched. The chips are behind a disclosure now and a press on
   * one *closes* it, which breaks that property much harder than moving the
   * state would: the measured element leaves the document before the ring can be
   * read.
   *
   * The trigger has the same property in a stronger form. It is on the row in
   * every state, a press toggles a disclosure rather than moving anything the
   * selector depends on, and focus stays on it throughout — which is what the
   * helper's own focus assertion needs in order to mean anything.
   *
   * This control is worth pinning beyond being convenient to reach. Until this
   * batch the picker was where a reader-initiated selection landed
   * programmatically, so it is the part of the page most likely to reacquire a
   * ring by accident, and the trigger inherited both that history and the
   * picker's place on the row.
   */
  const ring = await ringAfterPointerClick(page, RANGE_TRIGGER);

  expect(
    paintsARing(ring),
    `The range picker’s trigger painted ${ring.style} at ${String(ring.widthPx)}px after a pointer click.`,
  ).toBe(false);
});

test('paints no ring on the chart’s Raw data disclosure when a pointer opens it', async ({
  page,
}) => {
  /*
   * A `<summary>`, which is the interesting second case rather than a repeat of
   * the first: it is focusable by platform default rather than by anything this
   * codebase wrote, so it would be the natural place for a stray ring to arrive
   * from a user-agent stylesheet or from the zero-specificity default in
   * `@cumulo/ui`'s styles.css widening past `:focus-visible`.
   *
   * The fleet's table carried that property until #451 removed it; the chart's
   * table twin is the same platform element on the same page, so the reasoning
   * above is unchanged rather than re-argued — what a `<summary>` does with
   * focus is the platform's, not the disclosure's.
   *
   * That the click also opens the twin is deliberately not asserted here. The
   * disclosure's behaviour has its own owners (`chart-surfaces.spec.ts` presses
   * it and measures what unfolds), and re-proving it would make this case fail
   * on a change to the twin's default state — a result that would say nothing
   * about focus.
   */
  const ring = await ringAfterPointerClick(page, RAW_DATA_SUMMARY);

  expect(
    paintsARing(ring),
    `The chart's Raw data summary painted ${ring.style} at ${String(ring.widthPx)}px after a pointer click.`,
  ).toBe(false);
});

/*
 * The touch arm. `hasTouch` is a browser-context option rather than a per-action
 * one, so it has to be scoped by a describe — and scoped rather than set
 * file-wide, because the mouse cases above must keep arriving as a mouse: a
 * context with a touchscreen is not what a desktop reader has, and the two
 * modalities are exactly what this file is separating.
 */
test.describe('under a finger', () => {
  test.use({ hasTouch: true });

  test('paints no ring on the forecast chart when a finger taps it', async ({ page }) => {
    /*
     * The case this arm was opened for, and the only element on the page that
     * needed code written to satisfy it — see the header for what the probe
     * measured before that code existed.
     *
     * That the tap also pins a tooltip is #421's contract and `chart-tap.spec.ts`
     * measures it. Deliberately not restated here: this case would then fail on a
     * change to what a tap reveals, a result that would say nothing about rings.
     */

    /*
     * Waited for explicitly rather than left to the tap's own actionability. The
     * chart draws when the forecast resolves, and `playwright.config.ts` sets no
     * `actionTimeout` — so a chart that never arrived would hang the gesture
     * indefinitely, where this gives up in seconds and names what was missing.
     */
    await expect(page.locator(CHART_SVG)).toBeVisible();

    const ring = await ringAfterTap(page, CHART_SVG);

    expect(
      paintsARing(ring),
      `The forecast chart painted ${ring.style} at ${String(ring.widthPx)}px after a tap.`,
    ).toBe(false);
  });

  test('paints no ring on the range picker’s trigger when a finger taps it', async ({ page }) => {
    /*
     * The mouse case's twin, and the ratchet the rest of the sweep rests on. The
     * trigger already painted nothing under a mouse, so a ring found here would
     * mean the touch path reaches rings the mouse path does not — which is the
     * exact shape of the defect #440 found on the chart, and the reason one
     * measured element is not a sample. It keeps the properties that made it the
     * right mouse subject: always on the row, a press toggles a disclosure rather
     * than moving anything the selector depends on, and focus stays on it.
     */
    const ring = await ringAfterTap(page, RANGE_TRIGGER);

    expect(
      paintsARing(ring),
      `The range picker’s trigger painted ${ring.style} at ${String(ring.widthPx)}px after a tap.`,
    ).toBe(false);
  });
});
