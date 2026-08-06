import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { routeBasemap } from './hermetic-basemap';
import { openSiteTable } from './site-table';

/*
 * Who gets the focus when a site opens, driven by a real keyboard and a real
 * address bar.
 *
 * The dashboard's answer to a *reader-initiated* selection is a focus move: the
 * site's card focuses its own heading on mount so the new surface announces
 * itself rather than leaving a reader's focus on a control that is about to
 * unmount (#93). Under jsdom that is provable only as far as
 * `document.activeElement` — the assertion `Dashboard.focus.test.tsx` already
 * makes. What it cannot show is the half a reader actually experiences: whether
 * the ring `@cumulo/ui` paints on `:focus-visible` is on the heading afterwards.
 * `:focus-visible` is a browser heuristic over *how* focus arrived, jsdom
 * implements no heuristic and paints nothing, and no amount of unit testing can
 * substitute for one.
 *
 * So the first case is one interaction performed the way a keyboard user
 * performs it: Tab to the fleet table's summary, open it with Enter, Tab until a
 * row has focus, press Enter again, and measure what the browser then decided to
 * paint. Every step is a real key event — `Locator.press` on the row would reach
 * the same handler while telling us nothing about whether the row is reachable
 * by tabbing at all.
 *
 * The disclosure is part of that claim rather than a preamble to it. The rows
 * are folded away by default since #265, so a `<details>` that could not be
 * opened from the keyboard would put the entire table view — the relief
 * `map-treatment.md` requires for a marker palette that cannot carry state by
 * colour alone — out of a keyboard reader's reach, with every other assertion
 * here unable to see it.
 *
 * The second case is the other half of the same rule, and it is the reason #260
 * was routed to this lane at all. A `?site=` link is *not* a reader asking for
 * anything now, so the card must take no focus — and "no focus was taken" is a
 * claim about the whole assembled page arriving over HTTP, which is what this
 * lane is and jsdom's synchronous mount is not.
 */

/**
 * How many Tab presses to allow before calling the row unreachable.
 *
 * A ceiling, not a measurement of the tab order: the map's marker buttons come
 * before the content column in DOM order — the map is the first thing in the
 * dashboard and the column follows it down the page (#265) — and their number
 * moves with the clustering, so pinning an exact count would make this case
 * fail on a camera change rather than on a defect. Generous enough to cross
 * every marker, small enough that a site table nothing can tab into fails loudly
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
 * Tab to the fleet table's summary and open it with Enter.
 *
 * The first half of a keyboard reader's route to a row, and an assertion in its
 * own right: the disclosure is shut when the page loads, so every row below it
 * is unreachable unless a keystroke on the summary opens it. Visibility is what
 * says it opened — a closed `<details>` keeps its children in the DOM, so a
 * count would pass against a table nobody can see.
 *
 * Throws rather than returning quietly when the summary never takes focus: the
 * message names the element that failed, where a bare timeout on the row below
 * would blame the wrong one.
 */
const openSiteTableFromKeyboard = async (page: Page): Promise<void> => {
  const summary = page.locator('.site-table-summary');

  await expect(summary).toBeVisible();

  for (let press = 0; press < MAX_TAB_PRESSES; press += 1) {
    if (await summary.evaluate((element) => element === document.activeElement)) {
      await page.keyboard.press('Enter');
      await expect(page.locator('[data-site-id]').first()).toBeVisible();

      return;
    }

    await page.keyboard.press('Tab');
  }

  throw new Error(
    `The fleet table's summary took no focus within ${String(MAX_TAB_PRESSES)} Tab presses.`,
  );
};

/**
 * Tab until a site row holds focus, and hand back which site it is.
 *
 * Called with the disclosure already open, so the Tab that leaves the summary
 * lands on the first row's button: the column headers are not focusable and
 * nothing else sits between the two.
 *
 * Throws rather than returning null when no row is ever reached: a caller has
 * nothing to do with "no row", and the message names the reason where a bare
 * timeout would not.
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

test('hands a keyboard selection to the card heading, ring and all', async ({ page }) => {
  /*
   * Both halves of the page first. The table is what this tabs to; the map is
   * what it tabs *through*, and starting before its markers have mounted would
   * mean tabbing through a document that is still growing in front of the
   * cursor. The summary rather than a row, because a row is not on screen yet —
   * opening the disclosure is the next step and is this case's to perform.
   */
  await expect(page.locator('.maplibregl-canvas')).toBeVisible();
  await expect(page.locator('.site-table-summary')).toBeVisible();

  await openSiteTableFromKeyboard(page);

  const siteId = await tabToSiteRow(page);

  await page.keyboard.press('Enter');

  /*
   * The row answered, and answered for the site whose row it was. Without this
   * the case would still pass if Enter had selected some other site — the
   * heading would be focused either way, and the reader would be looking at a
   * site they did not ask for.
   */
  await expect.poll(() => new URL(page.url()).searchParams.get('site')).toBe(siteId);

  await expect(page.locator('.site-popover-title')).toBeFocused();

  /*
   * And the ring is on it. The heading is `tabIndex={-1}` and takes focus
   * programmatically, so this measures the browser's `:focus-visible` heuristic
   * as much as the stylesheet: Chromium carries focus-visible across a
   * programmatic move when the interaction that triggered it was a keystroke,
   * which is the whole reason the card is allowed to move focus silently. If
   * this ever reads `none`, a keyboard reader is being moved to a heading with
   * no visible sign of where they landed.
   */
  const ring = await focusRing(page, '.site-popover-title');

  expect(ring.style).toBe('solid');
  expect(ring.widthPx).toBeGreaterThan(0);

  await page.keyboard.press('Escape');

  /*
   * And back where they came from. Escape closes from inside the card, which
   * unmounts the Close button focus would otherwise fall off — so the landing is
   * the row that opened it, matched by the id this case already holds rather
   * than by position in the list.
   */
  await expect(page.locator('.site-popover')).toHaveCount(0);
  await expect.poll(async () => focusedSiteId(page)).toBe(siteId);
});

// The issue number is spelled out rather than written with a hash: the frontend
// gate's hex-colour rule matches `#260` in a string literal, and a rule fighting
// you is a design signal rather than a thing to suppress (CLAUDE.md).
test('takes no focus at all when ?site= opens the card (issue 260)', async ({ page }) => {
  /*
   * The regression this issue is: the card mounts when the fleet listing
   * resolves, and on a deep link that moment is not page load — it is whenever
   * the listing comes back, which over a real network can be well after the
   * reader has started using the page. A card that focused its heading on mount
   * therefore took focus from somebody who had done nothing to ask for it (WCAG
   * 3.2.5). The settlement is that focus follows the *reader*, never the address
   * bar, and this is the case that would fail if that rule were dropped.
   *
   * An id read off the running page rather than a constant, for the reason
   * `dashboard-test-fixture.ts` gives about the same thing: a link's id comes
   * from a real fleet, and one derived the way the demo fleet derives its own
   * would still pass if both drifted together. Opening the table to read it is
   * a pointer gesture here and nothing is being claimed about it — the keyboard
   * route to the same rows is the case above.
   */
  const row = await openSiteTable(page);
  const siteId = await row.getAttribute('data-site-id');

  if (siteId === null) {
    throw new Error('The first site row carries no data-site-id to deep-link with.');
  }

  await page.goto(`/?site=${siteId}`);

  // The card really did open. Asserted first and deliberately: a card that
  // failed to mount at all would leave focus on `body` too, and would pass the
  // assertion below while proving nothing.
  await expect(page.locator('.site-popover')).toBeVisible();
  await expect(page.locator('.site-popover-title')).toHaveCount(1);

  /*
   * `body` is where a freshly loaded document leaves focus, and it is where this
   * page has to leave it. Read as the tag name rather than through
   * `toBeFocused`, because what is being asserted is that *nothing* took focus —
   * there is no element to point a locator at.
   */
  const focusedTag = await page.evaluate(() => document.activeElement?.tagName ?? null);

  expect(focusedTag).toBe('BODY');
});
