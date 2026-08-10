import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { routeBasemap } from './hermetic-basemap';
import { PRESSED_RANGE_BUTTON } from './range-picker';

/*
 * What the browser paints when the reader arrived by pointer: nothing.
 *
 * `design.md` rule 11 (P11) splits focus into two interactions that look
 * identical to `document.activeElement` and completely different to a reader. A
 * keyboard reader needs the ring — it is the only thing telling them where they
 * are standing (WCAG 2.4.7). Someone who just clicked already knows where they
 * are, and a ring blooming under their cursor is the rule's named defect signal.
 * The CSS that tells the two apart is `:focus-visible`, never bare `:focus`.
 *
 * That distinction is a *browser heuristic over how focus arrived*, which is
 * exactly what `testing.md` rule 10 routes out of jsdom: jsdom implements no
 * heuristic, computes no styles and paints no ring, so a component test can
 * prove an element took focus and nothing whatever about what the reader sees.
 * Only a real Chromium reached by a real mouse can answer this one.
 *
 * Each case below is therefore two assertions rather than one, and the pairing
 * is the whole of why it means anything. Focus first, because "no ring painted"
 * is trivially true of an element that took no focus at all — a control that had
 * stopped being focusable would sail through the ring assertion on its own while
 * being thoroughly broken. Focus moved *and* nothing painted is the conjunction
 * that only `:focus-visible` produces.
 *
 * Honest scope, twice over.
 *
 * This passes on the tree that preceded it. Issue 339 audited every focus rule
 * in the repo and found `:focus-visible` throughout, so there was no bare
 * `:focus` here to fix and these cases assert a property the app already had.
 * They exist as a ratchet: a future bare `:focus`, or a ring hand-rolled in JS
 * and forced on regardless of how focus arrived, fails here. Lint is the fast
 * half of that catch — `selector-pseudo-class-disallowed-list` in
 * `stylelint.config.mjs`, added by the same issue — and this is the half that
 * still sees the regressions a linter reads as innocent.
 *
 * And this spec must never be read as covering keyboard rings. Every assertion
 * in it is satisfied by an app that paints no rings at all, which would be a
 * WCAG 2.4.7 failure of the worst kind. `keyboard-focus.spec.ts` holds that end
 * — it measures the same outline and demands `solid` at a non-zero width — and
 * the two bound rule 11 only together. Neither is meaningful alone, so a change
 * that deletes one should be read as deleting half a rule.
 */

/**
 * The fleet table's disclosure control.
 *
 * Spelled out rather than imported because `site-table.ts` keeps its own copy
 * private and exports only the open-the-table gesture, which is not what this
 * spec wants: the click *is* the measurement here, so a helper performing it
 * would be the assertion answering itself (that module's own comment makes the
 * same point about the keyboard route).
 */
const SITE_TABLE_SUMMARY = '.site-table-summary';

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

test('paints no ring on the range picker when a pointer presses it', async ({ page }) => {
  /*
   * The already-pressed button, and not for convenience: `PRESSED_RANGE_BUTTON`
   * selects by `aria-pressed`, so clicking an unpressed one would move the
   * pressed state to it and leave the selector resolving to a *different*
   * element than the one that was clicked — the ring would then be measured on a
   * button nobody touched. Pressing the current window is also a real gesture
   * that changes no state, which keeps this case about focus and nothing else.
   *
   * This control is worth pinning beyond being convenient to reach. Until this
   * batch it was where a reader-initiated selection landed programmatically, so
   * it is the button on the page most likely to reacquire a ring by accident.
   */
  const ring = await ringAfterPointerClick(page, PRESSED_RANGE_BUTTON);

  expect(
    paintsARing(ring),
    `The range picker painted ${ring.style} at ${String(ring.widthPx)}px after a pointer click.`,
  ).toBe(false);
});

test('paints no ring on the fleet table disclosure when a pointer opens it', async ({ page }) => {
  /*
   * A `<summary>`, which is the interesting second case rather than a repeat of
   * the first: it is focusable by platform default rather than by anything this
   * codebase wrote, so it would be the natural place for a stray ring to arrive
   * from a user-agent stylesheet or from the zero-specificity default in
   * `@cumulo/ui`'s styles.css widening past `:focus-visible`.
   *
   * That the click also opens the table is deliberately not asserted here. The
   * disclosure's behaviour has its own owners (`site-table.ts` and the specs
   * using it), and re-proving it would make this case fail on a change to the
   * table's default state — a result that would say nothing about focus.
   */
  const ring = await ringAfterPointerClick(page, SITE_TABLE_SUMMARY);

  expect(
    paintsARing(ring),
    `The fleet table's summary painted ${ring.style} at ${String(ring.widthPx)}px after a pointer click.`,
  ).toBe(false);
});
