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
 * Five cases, one per thing only this lane can see.
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
 *
 * The third is where the bar's things sit relative to each other, which is a
 * claim about a flex line's cross-axis and so exists only once a browser has
 * laid the row out and resolved every font in it. jsdom computes no such
 * geometry: under it `align-items: baseline` and `align-items: center` are the
 * same string in a stylesheet nobody measured (`testing.md` rule 10).
 *
 * The fourth is that the menu's popover is painted *over* the map rather than
 * under it, which is the claim this file inherited when #284 D13 removed the
 * header's (i) and with it `info-tips.spec.ts`'s stacking case. It belongs to
 * whatever on-bar overlay exists rather than to that one, and the popover is the
 * app's only one whose stacking any spec measures — `.site-search-listbox` is
 * the other, equally stacked over the same canvas and untested. The popover
 * carries the same stacking value (`header/header.css` argues both of the bar's
 * at once), hangs off the same bar, and has the same maplibre canvas beneath it. Playwright's `toBeVisible` cannot make the claim —
 * it is a box and a computed style, not an occlusion test, so a popover painted
 * under the canvas passes it while being unreadable in fact.
 *
 * The fifth is the search folding behind an icon on a bar too narrow to hold it
 * (#284 D17), which is a media query and therefore invisible to jsdom in the
 * most literal way available: `AppHeader` renders the field and the icon at
 * every width, and which of them a reader is looking at is a computed `display`
 * nothing under `src/` can read. The case drives the whole transition rather
 * than the two ends of it, because what is worth catching is a search that
 * survives the fold — the combobox still selecting, and the field coming back
 * when the width does.
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
 * How far apart two boxes' vertical centres may sit and still count as aligned,
 * in CSS pixels.
 *
 * The same two pixels, for the same reason, that `composition.spec.ts`'s
 * `EDGE_TOLERANCE_PX` allows: these are `getBoundingClientRect` reads of a
 * laid-out page, and sub-pixel layout plus the browser's own rounding land in
 * the last pixel or so. A separate constant rather than a shared one because the
 * two specs measure different things and are free to diverge (`structure.md`
 * rule 7) — that one is a box meeting an edge, this one is a row of boxes
 * agreeing on a centreline.
 *
 * Two is far below the misalignment this case exists to catch: the bar's
 * controls are `--text-sm` and the wordmark beside the mark is `--text-xl`, so
 * hanging them off a shared text baseline puts the mark several pixels above the
 * centreline of everything else — which is what the owner saw (#284 D1).
 */
const CENTRE_TOLERANCE_PX = 2;

/**
 * The widest gap between any two of these elements' vertical centres, in CSS
 * pixels — `Infinity` while any one of them is still without a layout box.
 *
 * Infinity rather than a throw for the reason {@link isWithinViewport} returns
 * `false`: every caller polls this, an element with no box yet is a "not yet",
 * and the poll's own timeout is what turns a permanent one into a failure. It
 * also fails the comparison every caller makes, so a box that never arrives can
 * never be mistaken for an aligned one.
 *
 * The locators are a parameter rather than reached in from the case
 * (`structure.md` rule 1), and pairwise-max rather than a comparison against one
 * chosen reference: no element on the bar is the authority the others answer to,
 * and picking one would hide a pair that agrees with it while disagreeing with
 * each other.
 */
const maxCentreMisalignment = async (elements: readonly Locator[]): Promise<number> => {
  const boxes = await Promise.all(elements.map(async (element) => element.boundingBox()));
  const centres: number[] = [];

  for (const box of boxes) {
    if (box === null) {
      return Number.POSITIVE_INFINITY;
    }

    centres.push(box.y + box.height / 2);
  }

  return Math.max(...centres) - Math.min(...centres);
};

/**
 * Whether the overlay is the thing a reader's pointer would actually land on at
 * its own centre.
 *
 * `document.elementFromPoint` resolves the topmost painted element at a point,
 * which is exactly the question a stacking value answers and exactly the one
 * `toBeVisible` does not ask. `contains` rather than identity, because the
 * topmost thing at the centre of an overlay is whatever child sits there — a
 * button, a label — rather than the overlay's own box.
 *
 * Moved here from `info-tips.spec.ts` rather than copied: the on-bar tip it used
 * to measure is gone (#284 D13) and this file's popover is the overlay that
 * inherited the claim, so there is one copy of the idiom now as there was
 * before.
 */
const panelIsOnTop = async (panel: Locator): Promise<boolean> =>
  panel.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const topmost = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);

    return topmost !== null && element.contains(topmost);
  });

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
  // reach the menu, and the first lands on the control named here. That both are
  // ahead of everything else is the design (`App.test.tsx` pins the bar's
  // contents); this is the half that needs a real focus order to be true at all
  // — and the count is hard-coded precisely because a control joining or leaving
  // the bar shifts it silently, which is what #265 did by adding the product's
  // (i) here and #284 D13 undid by taking it away again.
  //
  // The search toggle #284 D17 added is a third control on this bar and is
  // deliberately not in this count: it is `display: none` above
  // `header/header.css`'s breakpoint, which this file's default viewport is well
  // clear of, and a hidden control is not focusable. So the order here is
  // unchanged at this width and different at a phone's — which is the last case
  // in this file, at 390px, rather than an assumption made in this one.
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

test('centres the brand mark on the same line as the search and the menu', async ({ page }) => {
  /*
   * The live map, not merely a map-shaped box. `.map-canvas` is worn by the
   * pending shell as well as the running map (`MapSurface`), and the swap
   * between them is a layout change directly above nothing and directly below
   * the header — so measuring the bar while it is still in flight would be
   * measuring a page mid-assembly. `.maplibregl-canvas` exists only on the far
   * side of that swap.
   */
  await expect(page.locator('.maplibregl-canvas')).toBeVisible();

  /*
   * The three things a reader sees on the bar, and the whole of the claim: they
   * share a centreline. Written as the three elements rather than as a rule in a
   * stylesheet because the defect this catches is not a wrong declaration — it
   * is a right-sounding one (`align-items: baseline`) meeting a mark that has no
   * text baseline to hang from, so the mark rides above controls set two type
   * sizes smaller. Only the resolved geometry can tell those apart.
   *
   * Polled, because these are geometry reads on a page that has just finished
   * assembling itself and fonts settle after first paint.
   */
  const misalignment = async (): Promise<number> =>
    maxCentreMisalignment([
      page.locator('.brand-mark'),
      page.locator('.site-search-input'),
      page.locator('.header-menu-button'),
    ]);

  await expect
    .poll(misalignment, {
      message: 'The brand mark, the search and the menu do not share a centreline.',
    })
    .toBeLessThanOrEqual(CENTRE_TOLERANCE_PX);
});

test('hangs the menu over the map rather than under it', async ({ page }) => {
  const popover = page.locator('.header-menu-popover');

  /*
   * The map first, and not as politeness: maplibre's canvas is the positioned
   * element this popover has to out-rank, and it does not exist until the lazy
   * chunk has resolved and mounted. Opening the menu over an empty box would
   * measure a page where nothing could have occluded anything.
   */
  await expect(page.locator('.maplibregl-canvas')).toBeVisible();

  await page.locator('.header-menu-button').click();

  await expect(popover).toBeVisible();

  /*
   * A box worth hit-testing, before the hit test. `elementFromPoint` at the
   * centre of a zero-sized box is a question about a point that is not inside
   * anything, so the measurement below would be reporting on a popover no reader
   * could press either way — and a collapsed popover is exactly the failure a
   * stacking regression could arrive alongside.
   */
  const box = await popover.boundingBox();

  if (box === null) {
    throw new Error('The header menu popover is visible but has no layout box.');
  }

  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);

  /*
   * The assertion this case exists for. The header sits above the dashboard in
   * DOM order but is not a positioned ancestor of it, so an overlay with no
   * stacking value of its own paints *under* every positioned thing the
   * dashboard puts below — maplibre's canvas among them — while remaining
   * visible, boxed and correctly sized to every other measure available here.
   */
  expect(await panelIsOnTop(popover)).toBe(true);
});

/**
 * A phone, and specifically one below `header/header.css`'s 27.4375rem — the
 * width that file measured as the point where the brand, the field and the menu
 * stop fitting on one line.
 *
 * 390x844 rather than a width picked just under the breakpoint: it is a real
 * device size, it is 49px clear of the fold, and the clearance is what keeps
 * this case from turning red over a platform whose fonts lay the bar out a few
 * pixels wider than the measurement.
 */
const PHONE_VIEWPORT = { width: 390, height: 844 };

/** A desktop window, well above the fold — where the field is the bar's own. */
const WIDE_VIEWPORT = { width: 1280, height: 800 };

test.describe('the search on a bar too narrow to hold it', () => {
  test.use({ viewport: PHONE_VIEWPORT });

  test('folds the field behind an icon, opens it focused, and hands it back when the width returns', async ({
    page,
  }) => {
    const inlineSearch = page.locator('.app-header > .site-search');
    const toggle = page.locator('.header-search-toggle');
    const bar = page.locator('.header-search-bar');
    const barInput = bar.locator('.site-search-input');

    /*
     * The listing first, for the reason the menu case waits on it: the fleet
     * resolves after first paint and everything read below comes off a row.
     */
    await expect(page.locator('.site-table-summary')).toBeVisible();

    /*
     * The fold itself. `toBeHidden` on the field is a computed-style read, which
     * is the whole reason this case is in this lane — the element is in the
     * document at every width and jsdom would find it either way.
     */
    await expect(inlineSearch).toBeHidden();
    await expect(toggle).toBeVisible();
    // Closed is absent rather than merely hidden, so the bar's own field is not
    // a second combobox sitting in the accessibility tree behind the icon.
    await expect(bar).toHaveCount(0);

    /*
     * The site to look for, read off the page before anything is pressed and
     * through the closed disclosure, exactly as the search case above reads it
     * and for the same two reasons: a name regenerated from the seed would still
     * pass if the app and the test drifted together, and opening the table would
     * scroll the surface this case is about out from under itself.
     */
    const row = page.locator('[data-site-id]').first();
    await expect(row).toBeAttached();

    const siteId = await row.getAttribute('data-site-id');
    const siteName = await row.textContent();

    if (siteId === null || siteName === null) {
      throw new Error('The first site row names neither a site nor an id to search for.');
    }

    await toggle.click();

    await expect(bar).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    /*
     * The caret is in the field the press opened. On a phone this is the whole
     * difference between a search bar and a search bar with a keyboard under it,
     * because a mobile browser raises its keyboard only for a focus made inside
     * the gesture that asked for one — which is what `AppHeader`'s `flushSync`
     * buys, and what `AppHeader.test.tsx` pins in the lane that can see
     * `document.activeElement` at all.
     */
    await expect(barInput).toBeFocused();

    /*
     * And it opened *under* the row rather than inside it. A bar that squeezed
     * onto the header's own line would satisfy every assertion above while
     * leaving a field narrower than the icon that opened it, so the claim is
     * made against the brand's box: the bar starts below where the brand ends.
     */
    const brandBox = await page.locator('.brand').boundingBox();
    const barBox = await bar.boundingBox();

    if (brandBox === null || barBox === null) {
      throw new Error('The header bar is visible but something on it has no layout box.');
    }

    expect(barBox.y).toBeGreaterThanOrEqual(brandBox.y + brandBox.height);

    await barInput.fill(siteName);

    // The popup answered before the keys that act on it, for the reason the
    // search case above waits: otherwise Enter is pressed against whatever the
    // list happens to hold.
    await expect(bar.locator('.site-search-option').first()).toHaveText(new RegExp(siteName));

    /*
     * The combobox's own keys, driven inside the bar. A full site name matches
     * exactly one site in the demo fleet — the names run `<place> rooftop 1..5`
     * — so ArrowDown here is the clamp rather than a step, and what Enter proves
     * is that the highlight, the selection and the URL still work from a control
     * that has moved to a different parent.
     */
    await barInput.press('ArrowDown');
    await barInput.press('Enter');

    // The right site, not merely a site: an off-by-one in the highlight would
    // open a neighbour's card with every other assertion here still green.
    // Polled because the selection reaches the URL through the dashboard.
    await expect.poll(() => new URL(page.url()).searchParams.get('site')).toBe(siteId);

    await page.setViewportSize(WIDE_VIEWPORT);

    /*
     * The far end of the transition, and the guard that keeps the two ends from
     * both being vacuous: the icon is *not* visible at a desktop width, so the
     * `toBeVisible` at the top of this case is a fact about 390px rather than
     * about an icon that is simply always there. It sits here rather than before
     * the resize because `test.use` opens this case at the phone width; it is
     * the same claim either way round.
     */
    await expect(inlineSearch).toBeVisible();
    await expect(toggle).toBeHidden();
  });
});
