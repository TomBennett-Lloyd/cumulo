import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { routeBasemap } from './hermetic-basemap';
import { layoutBoxOf } from './layout-box';
import { PHONE_VIEWPORT } from './viewports';

/*
 * A description behind an (i), driven by a real keyboard.
 *
 * The unit lane owns what the tip *is*: that its content is absent until pressed
 * and present after, that Escape closes it, that a press outside does too
 * (`src/info/InfoTip.test.tsx`, against the component in isolation). None of
 * that needs a browser and none of it is repeated here.
 *
 * What is only true here is that a reader can get to it. `aria-expanded` and a
 * mounted `<div>` are jsdom facts; whether the button is reachable by tabbing
 * through the assembled page, whether the panel that appears is *painted* rather
 * than merely present in the DOM, and whether Escape leaves the reader standing
 * on the button they pressed are facts about layout, stacking and real key
 * events. jsdom has no layout, so a panel positioned under the map's controls or
 * collapsed to nothing looks identical there to one a reader can read
 * (`testing.md` rule 10).
 *
 * **Where the panel lands** is the second thing only true here, and it arrived
 * with the 2026-08-11 round (#429): the panel is clamped to the controls row's
 * width and right edge, which is a claim about two boxes and therefore has no
 * jsdom twin at all. The phone-width case at the foot of this file is that pin.
 *
 * One tip is driven, because one is the whole count. There were three when this
 * file was written and both departures were deletions rather than moves. #284 D5
 * removed the fleet panel's window caption — it rendered only on the arm with no
 * range picker, the picker renders wherever there is a window to choose now, and
 * on the one arm left without one the window is pinned and the chart's own name
 * states it. #284 D13 removed the header's, whose sentence the About dialog
 * behind the menu already opens with, and which was a control on the bar in the
 * tab order ahead of the search.
 *
 * That second departure took something with it that is not about tips at all,
 * and it went somewhere rather than away: the header's panel was the one overlay
 * hanging *over the map* that anything measured (`.site-search-listbox` hangs
 * there too, equally stacked and measured by nothing), so this file carried the
 * stacking half — whether an overlay is painted above maplibre's canvas or under
 * it, which `toBeVisible` cannot tell, Playwright's visibility being a box and a
 * computed style rather than an occlusion test. `header.spec.ts` makes that measurement
 * on `.header-menu-popover` now: same `z-index`, same bar, same canvas beneath.
 *
 * So what is left here is the reachability half, on the tip a reader reaches by
 * tabbing through the whole page. That "About this chart" is the fleet panel's
 * only (i) in every mode is a fact this spec depends on rather than merely
 * records — `FLEET_TIP_BUTTON` is a class selector, so a second tip growing back
 * in that panel would make every locator below ambiguous. The count is asserted
 * for that reason; which tip is which is the unit lane's
 * (`FleetPanel.structure.test.tsx`).
 */

/**
 * How many Tab presses to allow before calling the tip unreachable.
 *
 * A ceiling rather than a measurement of the tab order, for the reason
 * `keyboard-focus.spec.ts` gives about the same ceiling: the map's markers sit
 * between the header and the reading, and their number moves with the
 * clustering, so an exact count would fail on a camera change rather than on a
 * defect.
 */
const MAX_TAB_PRESSES = 100;

const FLEET_TIP_BUTTON = '.fleet-chart-section .info-tip-button';
const FLEET_TIP_PANEL = '.fleet-chart-section .info-tip-panel';

/** Tab until the fleet panel's (i) holds focus, or say which element never did. */
const tabToFleetTip = async (page: Page): Promise<void> => {
  const button = page.locator(FLEET_TIP_BUTTON);

  await expect(button).toBeVisible();

  for (let press = 0; press < MAX_TAB_PRESSES; press += 1) {
    if (await button.evaluate((element) => element === document.activeElement)) {
      return;
    }

    await page.keyboard.press('Tab');
  }

  throw new Error(
    `The fleet panel's info tip took no focus within ${String(MAX_TAB_PRESSES)} Tab presses.`,
  );
};

test.beforeEach(async ({ page }) => {
  await routeBasemap(page);
  await page.goto('/');
});

test('opens the fleet chart’s description from the keyboard, and closes it back onto the button', async ({
  page,
}) => {
  const button = page.locator(FLEET_TIP_BUTTON);
  const panel = page.locator(FLEET_TIP_PANEL);

  // One (i) in this panel, which is what makes the selectors above name a single
  // control rather than whichever of two matched first.
  await expect(page.locator(FLEET_TIP_BUTTON)).toHaveCount(1);

  await tabToFleetTip(page);

  await page.keyboard.press('Enter');

  /*
   * Visible, and with a box worth reading. `toBeVisible` alone passes on a panel
   * the map's controls are painted over — Playwright's visibility is a box and a
   * `visibility` computed style, not an occlusion test — so the sentence itself
   * is read back as well: an empty panel is what a tip that lost its children
   * would look like, and the `innerText` read below is what catches one. A
   * zero-height panel is not the other half of that pair: it would already have
   * failed the `toBeVisible` on this same element, which Playwright grants only
   * to a non-empty box (#404).
   *
   * The sentence is deliberately not restated here. It belongs to `FleetPanel`
   * and is asserted against its own constant in the unit lane; a copy in this
   * file would be the second place it is written down, and would go green
   * against the old words after an edit in its one home.
   */
  await expect(panel).toBeVisible();

  expect((await panel.innerText()).trim().length).toBeGreaterThan(0);

  await page.keyboard.press('Escape');

  /*
   * Gone, and the reader is still where they were. A dismissal that unmounted
   * the panel while dropping focus to `body` would satisfy the first of these
   * and strand a keyboard reader at the top of the document — which is the whole
   * reason the component refocuses rather than trusting that focus never moved.
   */
  await expect(panel).toHaveCount(0);
  await expect(button).toBeFocused();
});

test.describe('at a phone width', () => {
  test.use({ viewport: PHONE_VIEWPORT });

  test('opens the description inside the page rather than off its edge', async ({ page }) => {
    /*
     * The owner's second ask of 2026-08-11, in their words: *"the (i) tooltip
     * hangs off the edge of the page"*. The panel used to be anchored to the
     * `.info-tip` itself — a 24px button carried to the *right* end of the
     * controls row — and hung from its left edge at its own measure, so at a
     * phone width most of it was drawn past the viewport and the sentence was
     * unreadable without a horizontal scroll. It is anchored to the controls
     * row and clamped to that row's width and right edge now
     * (`src/info/info.css`, `src/dashboard/fleet-panel.css`).
     *
     * This lane, because there is nothing here jsdom can see: the defect is
     * where a box lands, and jsdom lays nothing out (`testing.md` rule 10).
     *
     * `clientWidth` rather than the configured 390, for the reason
     * `composition.spec.ts` gives at its own edge comparison: the page scrolls,
     * so a classic scrollbar takes real width out of the layout viewport and a
     * comparison against the window would fail by exactly a scrollbar on any
     * engine that draws one.
     */
    const button = page.locator(FLEET_TIP_BUTTON);
    const panel = page.locator(FLEET_TIP_PANEL);

    await expect(button).toHaveCount(1);
    await button.click();
    await expect(panel).toBeVisible();

    const layoutWidth = await page.evaluate(() => document.documentElement.clientWidth);
    const panelBox = await layoutBoxOf(panel, 'The fleet chart’s description panel');

    expect(panelBox.x).toBeGreaterThanOrEqual(0);
    expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(layoutWidth);

    /*
     * And what is inside it is the legend, painted. `innerText` is rendered
     * text rather than markup, so a key that reached the DOM but was clipped to
     * nothing inside a panel this case has just called well-placed does not
     * satisfy it. The row's own text is read first and asserted non-empty,
     * which is the control the containment check needs: without it a legend of
     * blank `<li>`s would pass on `''` being a substring of anything.
     *
     * The words are deliberately not written out, for the reason the case above
     * gives about the sentence — the legend's copy has one home in
     * `charts/forecast-chart-legend.tsx` and is asserted against it in the unit
     * lane. A second copy here would go green against the old words.
     */
    const firstRow = panel.locator('.forecast-chart-legend li').first();
    const rowText = (await firstRow.innerText()).trim();

    expect(rowText.length).toBeGreaterThan(0);
    expect(await panel.innerText()).toContain(rowText);

    /*
     * Still the topmost thing at its own centre. The row it now hangs from
     * carries `container-type: inline-size`, whose layout containment makes it
     * both the panel's containing block and a stacking context — so re-anchoring
     * the panel outwards is exactly the change that could have dropped it behind
     * the chart below. `toBeVisible` cannot see that: Playwright's visibility is
     * a box and a computed style, not an occlusion test, which is the same
     * reason `header.spec.ts` hit-tests its own popover over the map canvas.
     */
    const topmostAtCentre = await panel.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);

      return hit !== null && element.contains(hit);
    });

    expect(topmostAtCentre).toBe(true);
  });
});
