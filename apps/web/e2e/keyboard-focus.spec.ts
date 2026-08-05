import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { routeBasemap } from './hermetic-basemap';

/*
 * The keyboard path to a site, driven by a real keyboard.
 *
 * The dashboard's answer to a selection is a focus move: `SitePanel` focuses its
 * own heading on mount so the context swap announces itself rather than leaving
 * a reader's focus on a control that is about to unmount (#93, and the panel's
 * own comment). Under jsdom that is provable only as far as `document.activeElement`
 * — the assertion `Dashboard.focus.test.tsx` already makes. What it cannot show
 * is the half a reader actually experiences: whether the ring `@cumulo/ui` paints
 * on `:focus-visible` is on the heading afterwards. `:focus-visible` is a
 * browser heuristic over *how* focus arrived, jsdom implements no heuristic and
 * paints nothing, and no amount of unit testing can substitute for one.
 *
 * So the whole case is one interaction performed the way a keyboard user
 * performs it: Tab until a row has focus, press Enter, and measure what the
 * browser then decided to paint. Every step is a real key event — `Locator.press`
 * on the row would reach the same handler while telling us nothing about whether
 * the row is reachable by tabbing at all.
 */

/**
 * How many Tab presses to allow before calling the row unreachable.
 *
 * A ceiling, not a measurement of the tab order: the map's marker buttons come
 * before the content column in DOM order — the map is the first thing in the
 * dashboard and the column follows it down the page (#265) — and their number
 * moves with the clustering, so pinning an exact count would make this case
 * fail on a camera change rather than on a defect. Generous enough to cross
 * every marker, small enough that a site list nothing can tab into fails loudly
 * here rather than as an unexplained Playwright timeout.
 */
const MAX_TAB_PRESSES = 100;

/** What the browser decided to paint around the focused element. */
interface FocusRing {
  /** CSS `outline-style`; `none` is the shape of a ring that never painted. */
  readonly style: string;
  readonly widthPx: number;
}

/** The focused element's site id, or `null` when focus is elsewhere. */
const focusedSiteId = async (page: Page): Promise<string | null> =>
  page.evaluate(() => document.activeElement?.getAttribute('data-site-id') ?? null);

/**
 * Tab until a site row holds focus, and hand back which site it is.
 *
 * Throws rather than returning null when the site list is never reached: a caller
 * has nothing to do with "no row", and the message names the reason where a
 * bare timeout would not.
 */
const tabToSiteRow = async (page: Page): Promise<string> => {
  for (let press = 0; press < MAX_TAB_PRESSES; press += 1) {
    const siteId = await focusedSiteId(page);

    if (siteId !== null) {
      return siteId;
    }

    await page.keyboard.press('Tab');
  }

  throw new Error(`No site row took focus within ${String(MAX_TAB_PRESSES)} Tab presses.`);
};

/**
 * The ring on one element, as the browser computed it.
 *
 * Both halves, because either alone is satisfiable by a ring nobody sees: a
 * `solid` outline of zero width paints nothing, and a wide outline of style
 * `none` paints nothing either.
 */
const focusRing = async (page: Page, selector: string): Promise<FocusRing> =>
  page.locator(selector).evaluate((element) => {
    const computed = getComputedStyle(element);

    return { style: computed.outlineStyle, widthPx: Number.parseFloat(computed.outlineWidth) };
  });

test.beforeEach(async ({ page }) => {
  await routeBasemap(page);
  await page.goto('/');
});

test('hands a keyboard selection to the panel heading, ring and all', async ({ page }) => {
  /*
   * Both halves of the page first. The rows are what this tabs to; the map is
   * what it tabs *through*, and starting before its markers have mounted would
   * mean tabbing through a document that is still growing in front of the
   * cursor.
   */
  await expect(page.locator('.maplibregl-canvas')).toBeVisible();
  await expect(page.locator('[data-site-id]').first()).toBeVisible();

  const siteId = await tabToSiteRow(page);

  await page.keyboard.press('Enter');

  /*
   * The row answered, and answered for the site whose row it was. Without this
   * the case would still pass if Enter had selected some other site — the
   * heading would be focused either way, and the reader would be looking at a
   * panel they did not ask for.
   */
  await expect.poll(() => new URL(page.url()).searchParams.get('site')).toBe(siteId);

  await expect(page.locator('.site-panel-title')).toBeFocused();

  /*
   * And the ring is on it. The heading is `tabIndex={-1}` and takes focus
   * programmatically, so this measures the browser's `:focus-visible` heuristic
   * as much as the stylesheet: Chromium carries focus-visible across a
   * programmatic move when the interaction that triggered it was a keystroke,
   * which is the whole reason the panel is allowed to move focus silently. If
   * this ever reads `none`, a keyboard reader is being moved to a heading with
   * no visible sign of where they landed.
   */
  const ring = await focusRing(page, '.site-panel-title');

  expect(ring.style).toBe('solid');
  expect(ring.widthPx).toBeGreaterThan(0);
});
