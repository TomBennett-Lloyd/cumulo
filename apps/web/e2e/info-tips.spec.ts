import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { routeBasemap } from './hermetic-basemap';

/*
 * A description behind an (i), driven by a real keyboard.
 *
 * The unit lane owns what the tip *is*: that its content is absent until pressed
 * and present after, that Escape closes it, that a press outside does too
 * (`src/info/InfoTip.test.tsx`, against the component in isolation). None of
 * that needs a browser and none of it is repeated here.
 *
 * What is only true here is that a reader can get to it. `aria-expanded` and a
 * mounted `<span>` are jsdom facts; whether the button is reachable by tabbing
 * through the assembled page, whether the panel that appears is *painted* rather
 * than merely present in the DOM, and whether Escape leaves the reader standing
 * on the button they pressed are facts about layout, stacking and real key
 * events. jsdom has no layout, so a panel positioned under the map's controls or
 * collapsed to nothing looks identical there to one a reader can read
 * (`testing.md` rule 10).
 *
 * The fleet panel's tip is the one driven, because it is the one every visitor
 * gets in the lane's configuration: the demo source can look back, so the panel
 * renders the range picker rather than the horizon tip, and the chart tip is the
 * only (i) inside `.fleet-panel`.
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

const FLEET_TIP_BUTTON = '.fleet-panel .info-tip-button';
const FLEET_TIP_PANEL = '.fleet-panel .info-tip-panel';

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

  await tabToFleetTip(page);

  await page.keyboard.press('Enter');

  /*
   * Visible, and with a box worth reading. `toBeVisible` alone passes on a panel
   * the map's controls are painted over — Playwright's visibility is a box and a
   * `visibility` computed style, not an occlusion test — so the sentence itself
   * is read back as well: an empty panel is what a tip that lost its children
   * would look like, and a zero-height one is what a stacking or layout failure
   * would leave.
   *
   * The sentence is deliberately not restated here. It belongs to `FleetPanel`
   * and is asserted against its own constant in the unit lane; a copy in this
   * file would be the second place it is written down, and would go green
   * against the old words after an edit in its one home.
   */
  await expect(panel).toBeVisible();

  const box = await panel.boundingBox();

  if (box === null) {
    throw new Error('The info tip panel is visible but has no layout box.');
  }

  expect(box.height).toBeGreaterThan(0);
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
