import { expect, test } from '@playwright/test';

import { routeBasemap } from './hermetic-basemap';

/*
 * The header, driven by a keyboard, in a browser that has a top layer.
 *
 * Everything here is out of jsdom's reach by construction rather than by
 * preference (`testing.md` rule 10). jsdom 30 implements `HTMLDialogElement`
 * with `open` and nothing else — no `showModal`, no `close` — so modality, the
 * backdrop, Escape raising `cancel`, and the focus restoration a browser
 * performs when a modal closes have no implementation there to assert against.
 * The unit lane covers what it honestly can (`src/header/*.test.tsx`): what is
 * in the document, in which state, and what each control means. This covers the
 * rest, once, as one continuous interaction.
 *
 * One continuous interaction rather than a case per step, because the sequence
 * is the behaviour: a reader arrives, finds the menu with Tab, flips the theme,
 * reads About, and backs out — and the interesting failures are all in the
 * seams between those steps. Every move is a real key event; `Locator.press`
 * would reach the same handlers while telling us nothing about whether anything
 * here is reachable by tabbing at all.
 */

test.beforeEach(async ({ page }) => {
  await routeBasemap(page);
  await page.goto('/');
});

test('opens the header menu, flips the theme and reads About, all from the keyboard', async ({
  page,
}) => {
  const menuButton = page.locator('.header-menu-button');
  const popover = page.locator('.header-menu-popover');
  const aboutDialog = page.locator('dialog.about-dialog');

  /*
   * Wait for the surface before touching the keyboard. The map's markers mount
   * after the fleet resolves and they come after the header in DOM order, so
   * tabbing into a document that is still growing would be tabbing through a
   * moving target.
   */
  await expect(page.locator('[data-site-id]').first()).toBeVisible();

  // The header is the first thing in the document and the menu is the only
  // control on it, so one Tab from a fresh page lands here. That it is the
  // *first* stop is the design (`App.test.tsx` pins the bar's contents); this
  // is the half that needs a real focus order to be true at all.
  await page.keyboard.press('Tab');
  await expect(menuButton).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(popover).toBeVisible();
  await expect(menuButton).toHaveAttribute('aria-expanded', 'true');

  // The toggle is the first thing inside the popover, and Enter on it is a
  // press — a disclosure of ordinary buttons rather than an ARIA menu is
  // exactly what makes that true without a roving tabindex to manage.
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Dark theme' })).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await page.keyboard.press('Tab');
  const aboutButton = page.getByRole('button', { name: 'About Cumulo' });
  await expect(aboutButton).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(aboutDialog).toBeVisible();

  /*
   * The credit inside the dialog, visible rather than merely present. A modal
   * puts its content in the top layer, and a credit that has been painted under
   * something else discharges no licence obligation (CC BY 4.0, CLAUDE.md hard
   * constraints) — which is a statement about layout, so only this lane can
   * make it.
   */
  await expect(aboutDialog.getByRole('link', { name: 'Open-Meteo.com' })).toBeVisible();

  /*
   * Escape, twice, and the two dismissals are deliberately separate.
   *
   * The first is the browser's: an unprevented `cancel` closes the modal and
   * restores focus to the control that opened it. The popover behind it is
   * untouched — which is the whole reason `HeaderMenu` renders the dialog as a
   * sibling of the popover rather than inside it, since React's synthetic
   * events bubble along the React tree and would otherwise hand this keypress
   * to the popover as well, collapsing both and leaving the browser restoring
   * focus to a button that no longer exists.
   */
  await page.keyboard.press('Escape');
  await expect(aboutDialog).toBeHidden();
  await expect(popover).toBeVisible();
  await expect(aboutButton).toBeFocused();

  // The second is the component's, and it owes the same courtesy by hand: the
  // control the reader is standing on is about to unmount, so focus goes back
  // to the button that opened the popover rather than to `body`.
  await page.keyboard.press('Escape');
  await expect(popover).toBeHidden();
  await expect(menuButton).toHaveAttribute('aria-expanded', 'false');
  await expect(menuButton).toBeFocused();
});
