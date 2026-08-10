import type { Locator, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { routeBasemap } from './hermetic-basemap';
import { revealSiteMarker } from './marker-reveal';

/*
 * The credits band's contested pixels, measured.
 *
 * `docs/design/map-treatment.md`'s Attribution section decides two things this
 * lane can check and no other can (#356). The band is **full width and paints
 * above the markers**, so a marker whose centre falls under it is not
 * pointer-reachable there — accepted, not worked around. And what makes that
 * acceptable is a **relief rule**: the map pans, markers keep their place in the
 * tab order and stay keyboard-operable, where Enter selects exactly as a click
 * would, and the site table and the header's search reach every site without
 * touching the map. This file is the executable form of two of those: the
 * occlusion is asserted as a fact rather than tolerated as a mystery, and the
 * keyboard relief beside it is what stops the fact being a defect. The site
 * table and the header's search are not reached from here.
 *
 * The licence assertion is the point of the whole file, not a coda. CLAUDE.md's
 * Open-Meteo constraint (CC BY 4.0) says the link is visibly present and
 * followable in *every* state — so the state where the band is winning pixels
 * off a marker is exactly the state that owes the loudest proof, and the state
 * where the band has wrapped to a phone's width is the other one. Wherever the
 * band takes something, it is because it is discharging that obligation.
 *
 * All of it is browser-only by construction. Occlusion is what a compositor does
 * with two overlapping boxes; reachability-without-a-pointer needs a real focus
 * ring and a real key event; and "the link can be followed" is a hit test, which
 * `toBeVisible` cannot make and jsdom cannot compute at all (`testing.md` rule
 * 10). `map-css-contract.test.ts` can only prove a declaration was written.
 *
 * Its own file rather than a seventh case in `map-regressions.spec.ts`: that
 * file sits near `max-lines`' 300-code-line ceiling with less headroom than this
 * addition, and the lane already splits one spec per surface —
 * `composition.spec.ts`, `chart-surfaces.spec.ts`, `info-tips.spec.ts`
 * (`structure.md` rule 4; `packages/storage/src/client-retry-classification.test.ts`
 * is the named precedent for splitting on the ceiling rather than growing past
 * it). The surface here is the credits band, which is not what that file is
 * about.
 */

/** Keeps a press point off the map's own edge furniture — the band, the controls. */
const EDGE_INSET_PX = 24;

/**
 * Intermediate mouse positions in a drag.
 *
 * maplibre's drag-pan handler works from `mousemove` deltas, so a single jump
 * from press to release is a gesture it can miss entirely. Nothing waits on this
 * number; it is a pan, not an animation budget.
 */
const DRAG_STEPS = 10;

/**
 * How many pans to allow before calling it a failure.
 *
 * A ceiling rather than a target: the distance is computed exactly, so one pan
 * is what this normally costs and a second is the rounding budget. Anything
 * approaching six means the drag is not moving the camera the way the arithmetic
 * assumes — which deserves a loud error naming that, rather than a loop that
 * spins until Playwright's timeout kills it with no explanation.
 */
const MAX_PAN_ATTEMPTS = 6;

/** Below this the pan is a no-op, so a loop of them would spin rather than converge. */
const MIN_PAN_PX = 1;

/**
 * How long the button is held still at the end of a drag, before it is released.
 *
 * This is part of the gesture rather than a wait for anything, and it is the
 * difference between a pan and a **fling**. maplibre keeps a buffer of the
 * pointer movements from the last fraction of a second and, if the pointer was
 * still moving when the button came up, eases the camera on past the release —
 * `HandlerInertia._onMoveEnd`, whose throw is speed-derived and capped at a
 * speed far above anything a synthetic drag produces. Playwright's `steps`
 * dispatch back to back with no delay, so every drag here is at that cap: the
 * first run of this spec panned a computed ~400px and the fleet left the map
 * entirely, ~1300px past where it was aimed.
 *
 * A pause before release empties that buffer, which is precisely what a reader
 * does when they place the map rather than throw it, and precisely what maplibre
 * distinguishes. maplibre owns the window this has to clear; 300ms is comfortably
 * past it and is not a restatement of it, so a future version tuning the window
 * downward cannot make this wrong. If one ever tunes it *upward* past this, the
 * marker-still-visible assertion after each pan is what says so, loudly.
 */
const DRAG_SETTLE_MS = 300;

const SITE_MARKER = '.map-site-marker';
const ATTRIBUTION = '.map-attribution';
const MAP_CANVAS = '.map-canvas';

/** The two links the band owes. Neither substitutes for the other. */
const WEATHER_CREDIT = 'Open-Meteo.com';
const TILE_CREDIT = '© OpenStreetMap contributors';

/**
 * A small phone, chosen for being one.
 *
 * 360x740 is a canonical small-phone size, and mobile is a first-class viewing
 * context rather than an afterthought (`design.md` rule 1). That is the whole
 * derivation, deliberately: this width is **not** picked relative to the compact
 * row's own floor, and nothing here computes with that measurement or restates
 * it. `map.css` owns the numbers behind the band's compaction and
 * `composition.spec.ts` is what measures against them; this case joins neither
 * ledger, because its claim is the one that holds at every width regardless —
 * no width loses a link.
 *
 * So the band is *expected* to have wrapped here, and nothing below asserts a
 * row count. Wrapping is the honest last resort the treatment sanctions; hiding
 * a credit is what is forbidden.
 */
const SMALL_PHONE_VIEWPORT = { width: 360, height: 740 };

/**
 * A laid-out box in client space — what `Locator.boundingBox` yields.
 *
 * Derived from the locator's own return type rather than hand-written, so it
 * cannot drift from what Playwright hands back (`typing.md` rule 3's principle
 * at a library boundary).
 */
type LayoutBox = NonNullable<Awaited<ReturnType<Locator['boundingBox']>>>;

interface ViewportPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * One element's box, or a loud failure naming the element that had none.
 *
 * Read once rather than polled, which is `map-regressions.spec.ts`'s idiom and
 * not `composition.spec.ts`'s `layoutBoxOf`. The difference is intent rather
 * than rigour: that helper polls because it measures immediately after
 * navigation or a resize, where "has a box yet" is genuinely in flight (#274).
 * Every read here happens after `revealSiteMarker` has zoomed the fleet apart —
 * several camera moves and marker remounts later — so layout is long settled,
 * and a `null` at that point means an element with no layout at all rather than
 * one that has not been given layout yet. That is a different failure, and it
 * says so (`error-handling.md` rule 1).
 */
const boxOf = async (locator: Locator, name: string): Promise<LayoutBox> => {
  const box = await locator.boundingBox();

  if (box === null) {
    throw new Error(`${name} is on the page but has no layout box.`);
  }

  return box;
};

const centreOf = (box: LayoutBox): ViewportPoint => ({
  x: box.x + box.width / 2,
  y: box.y + box.height / 2,
});

/**
 * Whether what the browser paints at a point belongs to `selector`.
 *
 * `closest` rather than identity, the `basemapPoint` idiom: whatever is topmost
 * at a marker's centre may be the tooltip span inside it, and at a point in the
 * band it may be the `<small>`, the `<a>` or the band itself.
 *
 * This is the question the occlusion claim is made of, asked in both directions
 * at one point — is the band there, and is the marker not — because either
 * answer alone has a way of being true for the wrong reason.
 */
const paintedAtBelongsTo = async (
  page: Page,
  point: ViewportPoint,
  selector: string,
): Promise<boolean> =>
  page.evaluate(
    (query) => {
      const element = document.elementFromPoint(query.x, query.y);

      return element !== null && element.closest(query.selector) !== null;
    },
    { x: point.x, y: point.y, selector },
  );

/**
 * Whether a press at this point would reach maplibre's own drag-pan handler.
 *
 * Deliberately a positive test rather than `basemapPoint`'s list of overlays to
 * reject. That helper is choosing between four candidate corners and has to name
 * what disqualifies each; here there is one candidate and one question — does
 * the press land on the GL surface — which the GL surface can answer itself. A
 * copy of the exclusion list would be a second place to update when an overlay
 * is added, and would silently stop protecting this file the day only one copy
 * was (`structure.md` rule 7).
 *
 * Both halves are needed: everything the band, the controls and the credits draw
 * sits outside `.maplibregl-canvas-container` entirely, so containment rejects
 * them; markers are *inside* it, so they need naming, and a press on one is
 * swallowed by the marker and never pans the map at all.
 */
const pressWouldPanTheMap = async (page: Page, point: ViewportPoint): Promise<boolean> =>
  page.evaluate((query) => {
    const element = document.elementFromPoint(query.x, query.y);

    return (
      element !== null &&
      element.closest('.maplibregl-canvas-container') !== null &&
      element.closest('.maplibregl-marker') === null
    );
  }, point);

/**
 * The accessible name of a site marker a pointer can actually reach.
 *
 * Markers overlap. Two sites a few pixels apart draw two buttons that intersect,
 * and the one mounted later wins the pixels they share — so `.first()` can hand
 * back a marker that is already buried under a sibling, which would make the
 * positive control below fail for a reason that has nothing to do with the
 * credits band. Any reachable one serves: the claim is about the band covering
 * *a* marker, not a particular site.
 *
 * The name rather than the locator, because the overlay remounts its markers on
 * every `moveend` and a name is what survives that. It is also unique here — the
 * demo fleet names every site `<place> rooftop <n>` (packages/shared/src/fleet.ts)
 * — so it identifies one marker rather than a set.
 */
const reachableSiteMarkerName = async (page: Page): Promise<string> => {
  const names = await page.locator(SITE_MARKER).evaluateAll((markers) =>
    markers
      .filter((marker) => {
        const box = marker.getBoundingClientRect();
        const topmost = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);

        return topmost !== null && marker.contains(topmost);
      })
      .map((marker) => marker.getAttribute('aria-label') ?? ''),
  );

  const name = names.find((candidate) => candidate !== '');

  if (name === undefined) {
    throw new Error('No site marker on the map is both named and reachable by a pointer.');
  }

  return name;
};

/**
 * The one site marker answering to this name — by role and accessible name, so
 * the locator says what a reader would say, and narrowed to the map's own
 * markers so a row elsewhere on the page carrying the same site cannot match it.
 */
const siteMarkerNamed = (page: Page, name: string): Locator =>
  page.getByRole('button', { name, exact: true }).and(page.locator(SITE_MARKER));

const markerCentreIsInBand = async (page: Page, marker: Locator): Promise<boolean> => {
  const band = await boxOf(page.locator(ATTRIBUTION), 'The credits band');
  const centre = centreOf(await boxOf(marker, 'The site marker'));

  return (
    centre.x >= band.x &&
    centre.x <= band.x + band.width &&
    centre.y >= band.y &&
    centre.y <= band.y + band.height
  );
};

/**
 * One pan, aimed: press the top-left of the map and drag straight down by
 * exactly the gap between the marker's centre and the band's.
 *
 * Every part of that is about determinism. The press is at a fixed inset from
 * the map's own top-left rather than at a searched-for corner, and it is checked
 * for reaching the GL surface first, because a press that lands on a marker
 * swallows the gesture and a press on the band or the controls never reaches the
 * map — either of which would leave the loop above spinning with nothing moving.
 * The direction is straight down and the origin is the top, so the path cannot
 * leave the map's box on the way; the distance is clamped to the box's own
 * bottom inset for the same reason. And a distance that clamps to nothing throws
 * rather than dragging zero pixels, so "the marker is already below where a pan
 * from here can reach" reports itself instead of exhausting the attempts.
 *
 * Panning does not change zoom, so the site marker stays a site marker
 * throughout: what moves is the camera, not what the overlay decides to draw.
 */
const panTowardsBand = async (page: Page, marker: Locator): Promise<void> => {
  const map = await boxOf(page.locator(MAP_CANVAS), 'The map canvas');
  const band = await boxOf(page.locator(ATTRIBUTION), 'The credits band');
  const centre = centreOf(await boxOf(marker, 'The site marker'));

  const start = { x: map.x + EDGE_INSET_PX, y: map.y + EDGE_INSET_PX };

  if (!(await pressWouldPanTheMap(page, start))) {
    throw new Error('The map’s top-left corner is covered, so there is nowhere to press to pan.');
  }

  const wanted = band.y + band.height / 2 - centre.y;
  const room = map.y + map.height - EDGE_INSET_PX - start.y;
  const distance = Math.min(wanted, room);

  if (distance < MIN_PAN_PX) {
    throw new Error(
      `A pan from the map’s top edge cannot move the marker any further towards the band (${String(Math.round(distance))}px).`,
    );
  }

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, start.y + distance, { steps: DRAG_STEPS });

  // Held still, then released: a pan rather than a fling (`DRAG_SETTLE_MS`).
  await page.waitForTimeout(DRAG_SETTLE_MS);

  await page.mouse.up();
};

/**
 * Pan until the marker's centre lies inside the band's box.
 *
 * The loop re-measures before every attempt rather than trusting the first
 * arithmetic, and re-asserts the marker between them: the overlay rebuilds on
 * `moveend`, so the locator is re-resolved by name each time, and a marker that
 * stopped answering to its name fails *here*, naming that, instead of silently
 * becoming an assertion about nothing further down. The polled reading at the
 * end is what reports the whole failure if the pans never converged, and it is
 * also what absorbs the last remount: the arrival of the marker under the band
 * is waited on as a state, never as a duration. (`DRAG_SETTLE_MS` is not an
 * exception to that — it is a duration *inside the gesture*, before the button
 * comes up, and nothing is being observed across it.)
 */
const panMarkerUnderBand = async (page: Page, marker: Locator): Promise<void> => {
  for (let attempt = 0; attempt < MAX_PAN_ATTEMPTS; attempt += 1) {
    if (await markerCentreIsInBand(page, marker)) {
      break;
    }

    await panTowardsBand(page, marker);

    await expect(marker, 'The panned marker stopped answering to its name.').toBeVisible();
  }

  await expect
    .poll(async () => markerCentreIsInBand(page, marker), {
      message: `The marker never came to rest under the credits band within ${String(MAX_PAN_ATTEMPTS)} pans.`,
    })
    .toBe(true);
};

test.beforeEach(async ({ page }) => {
  await routeBasemap(page);
  await page.goto('/');
});

/*
 * `issue 356` rather than `#356` in both titles below, and it is a lint rule
 * rather than a preference: `no-restricted-syntax` in `eslint.config.mjs` reads
 * any string literal matching `#[0-9a-fA-F]{3,8}` as a hex colour, which a
 * three-digit issue number is. `map-regressions.spec.ts` writes `(issue 265)`
 * and `(issue 284)` in its titles for the same reason — its `(#17)` survives
 * only because two digits are below the pattern's floor — and comments, which
 * the rule does not read, carry the `#` form throughout both files.
 */
test('keeps the credits band on top of a marker it covers, and the site reachable without the pointer (issue 356)', async ({
  page,
}) => {
  await revealSiteMarker(page);

  const siteName = await reachableSiteMarkerName(page);
  const marker = siteMarkerNamed(page, siteName);

  /*
   * The positive control, and the reason the occlusion assertion below means
   * anything. `elementFromPoint` resolving to something that is *not* the marker
   * is the whole measurement, and it would read exactly the same on a page where
   * the predicate never matched a marker in the first place — a renamed class, a
   * marker with no box, a fleet that never separated. So the predicate is shown
   * biting on this marker, at this point, before the map moves.
   */
  expect(
    await paintedAtBelongsTo(page, centreOf(await boxOf(marker, 'The site marker')), SITE_MARKER),
    'The marker is not reachable at its own centre before the pan, so nothing below is measured.',
  ).toBe(true);

  await panMarkerUnderBand(page, marker);

  /*
   * The accepted composition, as a fact. The band paints above the markers, so
   * at the same kind of point that answered "the marker" a moment ago the
   * browser now answers "the credits" — asked in both directions, because "the
   * band is here" and "the marker is not" fail to different changes and one of
   * them alone would pass on a page where the two overlap harmlessly.
   */
  const occluded = centreOf(await boxOf(marker, 'The site marker'));

  expect(
    await paintedAtBelongsTo(page, occluded, ATTRIBUTION),
    'The credits band is not what the browser paints over the marker it covers.',
  ).toBe(true);
  expect(
    await paintedAtBelongsTo(page, occluded, SITE_MARKER),
    'The marker is still pointer-reachable under the band, so this case is measuring nothing.',
  ).toBe(false);

  /*
   * And the relief that makes the occlusion acceptable rather than a defect: the
   * site is still selectable without a pointer at all.
   *
   * `press` and emphatically not `click`. Playwright's actionability sequence
   * for a click includes the hit test that the assertion above just proved would
   * fail — a click here would either be refused or would land on the band — while
   * `press` focuses the element and delivers the key, which is exactly what a
   * reader on a keyboard does and exactly what the relief rule promises. Swapping
   * in a click would turn this into a second occlusion test wearing the relief
   * rule's name.
   */
  await marker.press('Enter');

  await expect(page.locator('.site-popover-title')).toHaveText(siteName);

  /*
   * The licence obligation, in the state that contests it hardest. The marker is
   * still under the band, and this is what the band took those pixels *for*: a
   * CC BY 4.0 credit that cannot be followed is not a credit (CLAUDE.md).
   *
   * `toBeVisible` alone would pass on a link with something painted over it and
   * `toBeEnabled` is vacuous on an anchor, so the trial click is the assertion
   * with the hit test in it — Playwright's full actionability sequence, stopping
   * short of navigating.
   *
   * Both links, and not because symmetry is tidy. A hit test is a question about
   * a point rather than about a row: the site popover is open over the map by
   * now, and the two credits sit at different x-positions in the band, so one
   * being reachable does not imply the other. `map.css` says the OSM credit
   * carries the same licence obligation on the same surface and is never a reason
   * to hold it to a lower bar — which is a claim about this state too, not only
   * about the narrow one below.
   */
  const weatherCredit = page.locator(ATTRIBUTION).getByRole('link', { name: WEATHER_CREDIT });
  const tileCredit = page.locator(ATTRIBUTION).getByRole('link', { name: TILE_CREDIT });

  await expect(weatherCredit).toBeVisible();
  await weatherCredit.click({ trial: true });

  await expect(tileCredit).toBeVisible();
  await tileCredit.click({ trial: true });
});

test.describe('the band at a phone’s width', () => {
  test.use({ viewport: SMALL_PHONE_VIEWPORT });

  test('keeps both credit links clickable however far the band wraps (issue 356)', async ({
    page,
  }) => {
    /*
     * Two independent licence conditions on one row — the tile provider's and
     * Open-Meteo's, neither absorbing the other — at a width where the row has
     * run out of space and is allowed to wrap. What narrowing may drop is prose;
     * what it may never drop is either link, and "drop" includes leaving one
     * present but unfollowable, which is what a wrapped row overlapping its own
     * neighbours would do.
     *
     * So this asserts reachability and nothing about shape: no row count, no
     * height, no ordering. Those are `composition.spec.ts`'s claims, measured
     * against the width the compaction rule is written at; this one holds at
     * every width, which is why it can be made at a width picked for being a
     * phone.
     */
    const attribution = page.locator(ATTRIBUTION);

    await expect(attribution).toBeVisible();

    const tileCredit = attribution.getByRole('link', { name: TILE_CREDIT });
    const weatherCredit = attribution.getByRole('link', { name: WEATHER_CREDIT });

    await expect(tileCredit).toBeVisible();
    await tileCredit.click({ trial: true });

    await expect(weatherCredit).toBeVisible();
    await weatherCredit.click({ trial: true });
  });
});
