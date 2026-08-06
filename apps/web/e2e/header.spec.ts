import type { Locator, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { routeBasemap } from './hermetic-basemap';

/*
 * The header, driven by a keyboard and a pointer, in a browser that has a top
 * layer and a camera.
 *
 * Everything here is out of jsdom's reach by construction rather than by
 * preference (`testing.md` rule 10). jsdom 30 implements `HTMLDialogElement`
 * with `open` and nothing else — no `showModal`, no `close` — so modality, the
 * backdrop, Escape raising `cancel`, and the focus restoration a browser
 * performs when a modal closes have no implementation there to assert against.
 * jsdom has no WebGL either, so a map with bounds, and a selection arriving from
 * outside them, exist only here. The unit lane covers what it honestly can
 * (`src/header/*.test.tsx`): what is in the document, in which state, and what
 * each control means.
 *
 * Two cases, one per thing only this lane can see.
 *
 * The first is the menu, as one continuous interaction rather than a case per
 * step, because the sequence is the behaviour: a reader arrives, finds the menu
 * with Tab, flips the theme, reads About, and backs out — and the interesting
 * failures are all in the seams between those steps. Every move is a real key
 * event; `Locator.press` would reach the same handlers while telling us nothing
 * about whether anything here is reachable by tabbing at all.
 *
 * The second is the search, and it is really `map/SelectionCamera.tsx`'s
 * criterion asserted through the surface that motivated it: a site named in the
 * header can be anywhere, including well outside the camera's current bounds,
 * and the answer must not be drawn off the edge of the screen. So the fleet is
 * panned out of view for real, a site is chosen by name, and the card that opens
 * is *measured* against the viewport. A unit test could assert that the camera
 * was asked to move; only a browser can say the reader can see what they asked
 * for.
 */

/** How far one drag moves the camera, in CSS pixels. */
const PAN_STEP_PX = 500;

/**
 * Drags needed to put every marker outside the map's bounds.
 *
 * A margin over what the opening camera (`src/map/framing.ts`) and a drag of
 * {@link PAN_STEP_PX} actually need, which is fewer — the fleet occupies well
 * under half the opening viewport, so it clears the edge before this many. The
 * numbers themselves are `framing.ts`'s and the fleet generator's and are not
 * restated here; if either changes enough to matter, the `toHaveCount(0)` below
 * is what says so, by name.
 *
 * A count rather than a loop that stops when the map is empty, because the
 * emptiness is then still an assertion — a version that panned "until clear"
 * would report success by exiting its own loop.
 */
const PANS_TO_CLEAR_THE_FLEET = 3;

/** Every marker the fleet draws, of either kind — the map is empty when this is. */
const fleetMarkers = (page: Page): Locator => page.locator('.map-site-marker, .map-cluster-marker');

/**
 * Whether an element's box lies entirely inside the viewport.
 *
 * `false` rather than a throw when there is no box yet, because every caller
 * polls this: an element mid-animation is a "not yet", and the poll's own
 * timeout is what turns a permanent one into a failure.
 */
const isWithinViewport = async (page: Page, locator: Locator): Promise<boolean> => {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();

  if (box === null || viewport === null) {
    return false;
  }

  return (
    box.x >= 0 &&
    box.y >= 0 &&
    box.x + box.width <= viewport.width &&
    box.y + box.height <= viewport.height
  );
};

/**
 * Pan the map until the whole fleet is outside its bounds.
 *
 * The drag starts at the centre of the map's own box and moves sideways, which
 * keeps it clear of both things a drag must not begin on: the credits band along
 * the bottom edge (a licence obligation, and a link) and the control group in
 * the top-right corner.
 *
 * Markers are drawn only for what the current viewport contains
 * (`map/clustering.ts`), so "no marker of either kind" is exactly "no site is on
 * screen" — which is the precondition the case needs and cannot assume.
 */
const panFleetOutOfView = async (page: Page): Promise<void> => {
  const canvas = page.locator('.map-canvas');
  const box = await canvas.boundingBox();

  if (box === null) {
    throw new Error('The map has no layout box to drag inside.');
  }

  const startX = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  for (let pan = 0; pan < PANS_TO_CLEAR_THE_FLEET; pan += 1) {
    await page.mouse.move(startX, y);
    await page.mouse.down();
    // Stepped, so maplibre receives a real gesture rather than one jump it
    // would read as a click.
    await page.mouse.move(startX + PAN_STEP_PX, y, { steps: 12 });
    await page.mouse.up();
  }

  await expect(
    fleetMarkers(page),
    'The fleet is still on screen after panning away from it.',
  ).toHaveCount(0);
};

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
   *
   * The fleet table's summary is the thing waited on rather than a row: the
   * table renders only once the listing has answered, and its rows are folded
   * away behind that summary until somebody opens it (#265).
   */
  await expect(page.locator('.site-table-summary')).toBeVisible();

  // The header is the first thing in the document and carries two controls, in
  // this order: the site search, then the menu. So two Tabs from a fresh page
  // land here, and the first of them lands on the field. That both are ahead of
  // everything else is the design (`App.test.tsx` pins the bar's contents); this
  // is the half that needs a real focus order to be true at all.
  await page.keyboard.press('Tab');
  await expect(page.locator('.site-search-input')).toBeFocused();

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
   * Two dismissals live on this one key, and they are deliberately separate —
   * the dialog's, then the popover's, with a reopen in between.
   *
   * This first one is the browser's: an unprevented `cancel` closes the modal
   * and restores focus to the control that opened it. The popover behind it is
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

  /*
   * And it reopens — which is the assertion that makes the `cancel` wiring
   * load-bearing rather than decorative.
   *
   * Escape dismisses the element whether or not anything is listening: the
   * browser closes it and this spec would see it hidden either way. What only a
   * *second* opening can show is whether the component was told. Unwired, React
   * still believes the dialog is open, the next press sets state that is
   * already set, no effect re-runs, and About is dead for the rest of the
   * session — a dialog that opens exactly once per page load, with every
   * assertion above still green.
   */
  await page.keyboard.press('Enter');
  await expect(aboutDialog).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(aboutDialog).toBeHidden();
  await expect(aboutButton).toBeFocused();

  // The popover's dismissal is the component's own, and it owes the same
  // courtesy by hand: the control the reader is standing on is about to
  // unmount, so focus goes back to the button that opened the popover rather
  // than to `body`.
  await page.keyboard.press('Escape');
  await expect(popover).toBeHidden();
  await expect(menuButton).toHaveAttribute('aria-expanded', 'false');
  await expect(menuButton).toBeFocused();
});

test('finds a site by name and brings the camera to it when it is off screen', async ({ page }) => {
  const searchInput = page.locator('.site-search-input');
  const popover = page.locator('.site-popover');

  /*
   * The row is read before anything moves, and both halves come off the same
   * element: the id the URL will have to carry, and the name a reader would
   * type. Read off the running page rather than restated from the seed, for the
   * reason `keyboard-focus.spec.ts` gives about the same thing — a name derived
   * the way the demo fleet derives its own would still pass if both drifted.
   *
   * Read through the closed disclosure rather than by opening it (#265). Both
   * reads are DOM reads — an attribute and a text node — which Playwright
   * performs on any attached element, and neither of them presses anything. The
   * alternative costs this case its precondition: opening the table means
   * clicking a summary below the fold, Playwright scrolls it into view to click
   * it, and the pan below then drags at a `boundingBox` the map has scrolled out
   * of. That is a real red, seen here rather than reasoned about.
   */
  const row = page.locator('[data-site-id]').first();
  await expect(row).toBeAttached();

  const siteId = await row.getAttribute('data-site-id');
  const siteName = await row.textContent();

  if (siteId === null || siteName === null) {
    throw new Error('The first site row names neither a site nor an id to search for.');
  }

  await expect(page.locator('.maplibregl-canvas')).toBeVisible();
  await panFleetOutOfView(page);

  await searchInput.fill(siteName);

  // The popup answered before the key that acts on it — otherwise Enter would
  // be pressed against whatever the list happened to hold, and a search that
  // matched nothing would look identical to one whose Enter did nothing.
  await expect(page.locator('.site-search-option').first()).toHaveText(new RegExp(siteName));

  await searchInput.press('Enter');

  /*
   * The right site, not merely a site. The search picks from a filtered list, so
   * an off-by-one in the highlight would open a neighbour's card with every
   * other assertion here still green.
   */
  await expect.poll(() => new URL(page.url()).searchParams.get('site')).toBe(siteId);
  await expect(popover).toBeVisible();

  /*
   * The measurement this case exists for. The selected site was outside the
   * map's bounds a moment ago — `panFleetOutOfView` asserted exactly that — so
   * the card is drawn at a coordinate off the edge of the screen unless
   * `SelectionCamera` eases the camera to it. Visibility is no help here: an
   * off-screen maplibre marker still has a box and still reports visible. Only
   * the box's position against the viewport can tell the two apart, and it is
   * polled because the camera arrives by animation.
   */
  await expect
    .poll(async () => isWithinViewport(page, popover), {
      message: 'The selected site’s card opened outside the viewport.',
    })
    .toBe(true);

  // And the reader is on it. A search hit is reader-initiated like a marker or a
  // row press, so the card takes the focus by the rule the dashboard already had
  // (`docs/standards/react.md`) — asserted here because a field that kept the
  // focus would leave a keyboard reader typing at their own answer.
  await expect(page.locator('.site-popover-title')).toBeFocused();
});
