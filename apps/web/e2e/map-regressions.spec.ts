import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { routeBasemap } from './hermetic-basemap';
import { revealSiteMarker } from './marker-reveal';

/*
 * The three #17 defects, each pinned by the assertion that would have caught it.
 *
 * All three were browser-only by construction, which is why they shipped: a
 * marker press arriving as a map click needs maplibre's real event plumbing, a
 * doubled interactive role needs the real DOM maplibre wraps a marker in, and a
 * canvas that never tracks its container needs a real `ResizeObserver` over a
 * real layout. jsdom can express none of it, and `testing.md` rule 3 forbids the
 * only jsdom workaround (mocking maplibre) because a mock would assert the mock.
 * So this is the lane that owes them regression tests (`testing.md` rule 4).
 *
 * Each case has a demonstrated negative control: the pre-fix code was restored
 * as a transient mutant, the case was watched to fail, and the mutant reverted
 * (`testing.md` rules 4 and 8). The evidence lives on the ticket rather than
 * here, because a comment claiming a test bites is exactly the claim a comment
 * cannot support.
 */

/** How far the GL canvas may sit from its container before it is a defect. */
const CANVAS_SIZE_TOLERANCE_PX = 2;

/** Small enough that the canvas has to grow when the window does. */
const NARROW_VIEWPORT = { width: 900, height: 700 };

/** Wider *and* taller: a canvas that tracked one axis only would still fail. */
const WIDE_VIEWPORT = { width: 1280, height: 900 };

/** Keeps a candidate click point off the map's own edge furniture. */
const EDGE_INSET_PX = 24;

/** Far enough that no rounding could account for it, short enough to stay on the map. */
const DRAG_DISTANCE_PX = 300;

/**
 * Intermediate mouse positions in a drag.
 *
 * maplibre's drag-pan handler works from `mousemove` deltas, so a single jump
 * from press to release is a gesture it can miss entirely. Ten is a pan, not an
 * animation budget — nothing here waits on it.
 */
const DRAG_STEPS = 10;

/** How far a marker may miss its opening position after a reset, in CSS pixels. */
const RESET_TOLERANCE_PX = 2;

/** Both kinds of marker: which one is drawn is the camera's business, not this spec's. */
const ANY_MARKER = '.map-site-marker, .map-cluster-marker';

interface ViewportPoint {
  readonly x: number;
  readonly y: number;
}

interface ElementSize {
  readonly width: number;
  readonly height: number;
}

/** How every marker maplibre has mounted is shaped, in a11y terms. */
interface MarkerShape {
  readonly name: string | null;
  readonly role: string | null;
  readonly buttons: number;
}

/**
 * A point on the basemap that no overlay covers.
 *
 * Corners rather than the middle: the seed fleet sits over Great Britain and
 * Ireland, which the opening camera puts in the centre of the box, so the
 * corners are the part of the map that is reliably water. Which corner is not
 * something to hard-code though — the fleet's framing is free to change — so
 * each is asked what is actually under it.
 *
 * Two things are drawn over the basemap and take pointer events. Markers, which
 * is the question the production guard asks (`isMarkerClick`, src/map/map-click.ts).
 * And, since #265, the credits: the attribution band is overlaid on the map's
 * bottom edge rather than sitting in a strip beneath it, so both lower corners
 * are now under it at every viewport. A click landing there correctly opens no
 * draft — the band is content, not basemap — which arrived as this helper
 * silently returning a point the map never sees.
 *
 * Throwing when all four are covered is deliberate. A silent fallback would turn
 * "there is nowhere left to click the basemap" into a mysteriously failing
 * click, which is exactly the shape the overlay change surfaced.
 */
const basemapPoint = async (page: Page): Promise<ViewportPoint> => {
  const box = await page.locator('.map-canvas').boundingBox();

  if (box === null) {
    throw new Error('The map container is on the page but has no layout box.');
  }

  const left = box.x + EDGE_INSET_PX;
  const right = box.x + box.width - EDGE_INSET_PX;
  const top = box.y + EDGE_INSET_PX;
  const bottom = box.y + box.height - EDGE_INSET_PX;

  const corners: readonly ViewportPoint[] = [
    { x: left, y: bottom },
    { x: right, y: bottom },
    { x: left, y: top },
    { x: right, y: top },
  ];

  for (const corner of corners) {
    const covered = await page.evaluate((point) => {
      const element = document.elementFromPoint(point.x, point.y);

      return element !== null && element.closest('.maplibregl-marker, .map-attribution') !== null;
    }, corner);

    if (!covered) {
      return corner;
    }
  }

  throw new Error('Every corner of the map is covered by a marker or by the credits.');
};

/**
 * Every marker's top-left corner, in screen space, ordered so two readings can
 * be compared without knowing which marker is which.
 *
 * Identity is the thing this deliberately avoids needing. Panning changes the
 * bounds, so markers leave and enter the overlay and DOM order shuffles; the
 * seed fleet's clusters mostly share the name "Cluster of N sites", so names do
 * not single one out either. What a camera reset actually claims is stronger
 * than "that marker came back" anyway: *every* marker is where it was, because
 * the camera is what puts them there. So the whole set is the measurement.
 */
const markerOrigins = async (page: Page): Promise<readonly ViewportPoint[]> =>
  page.locator(ANY_MARKER).evaluateAll((markers) =>
    markers
      .map((marker) => {
        const box = marker.getBoundingClientRect();

        return { x: box.x, y: box.y };
      })
      .sort((left, right) => left.x - right.x || left.y - right.y),
  );

/**
 * The worst distance between two marker readings, so one number can carry the
 * whole question — and `Infinity` when the sets are not even the same size,
 * which is a camera in a different place rather than a near miss.
 */
const originDrift = (before: readonly ViewportPoint[], after: readonly ViewportPoint[]): number => {
  if (before.length !== after.length) {
    return Number.POSITIVE_INFINITY;
  }

  return before.reduce((worst, origin, index) => {
    const moved = after[index];

    if (moved === undefined) {
      return Number.POSITIVE_INFINITY;
    }

    return Math.max(worst, Math.abs(origin.x - moved.x), Math.abs(origin.y - moved.y));
  }, 0);
};

/**
 * Presses the basemap and drags horizontally, away from whichever edge the
 * press landed near.
 *
 * The press has to land on basemap rather than on a marker — a marker swallows
 * the `mousedown` and the map never pans — so it reuses the same covered-corner
 * search a click does. Horizontal only, and away from the nearer side, so the
 * path cannot leave the map's box whatever the viewport is.
 */
const dragMap = async (page: Page): Promise<void> => {
  const start = await basemapPoint(page);
  const layoutWidth = await page.evaluate(() => document.documentElement.clientWidth);
  const direction = start.x < layoutWidth / 2 ? 1 : -1;

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + direction * DRAG_DISTANCE_PX, start.y, { steps: DRAG_STEPS });
  await page.mouse.up();
};

/**
 * The cursor the GL container is actually painting, as the browser computes it.
 *
 * Read off `.maplibregl-canvas-container` rather than off `.map-canvas` because
 * that is the element maplibre sets `cursor: grab` on directly, and a
 * declaration on an element beats one inherited from its ancestor whatever the
 * specificity — which is exactly the trap the armed rule in `map.css` is written
 * to avoid, and therefore the thing worth measuring.
 */
const canvasCursor = async (page: Page): Promise<string> =>
  page
    .locator('.maplibregl-canvas-container')
    .evaluate((element) => window.getComputedStyle(element).cursor);

const markerShapes = async (page: Page): Promise<readonly MarkerShape[]> =>
  page.locator('.maplibregl-marker').evaluateAll((wrappers) =>
    wrappers.map((wrapper) => ({
      name: wrapper.querySelector('button')?.getAttribute('aria-label') ?? null,
      role: wrapper.getAttribute('role'),
      buttons: wrapper.querySelectorAll('button').length,
    })),
  );

const clientSize = async (page: Page, selector: string): Promise<ElementSize> =>
  page
    .locator(selector)
    .evaluate((element) => ({ width: element.clientWidth, height: element.clientHeight }));

/** The worse of the two axes, so one number can carry the whole question. */
const canvasSizeGap = async (page: Page): Promise<number> => {
  const canvas = await clientSize(page, '.maplibregl-canvas');
  const container = await clientSize(page, '.map-canvas');

  return Math.max(
    Math.abs(canvas.width - container.width),
    Math.abs(canvas.height - container.height),
  );
};

test.beforeEach(async ({ page }) => {
  await routeBasemap(page);
  await page.goto('/');
});

test('opens the draft form when an armed basemap click lands (issue 265)', async ({ page }) => {
  /*
   * The positive control for the two cases below, and a case in its own right:
   * the map-click subscription has to keep answering the clicks it *is* for.
   * Without this, deleting the handler outright would leave both the
   * marker-propagation assertion and the disarmed case perfectly green.
   *
   * Arming first is the gesture now (#265). A bare click used to open a draft,
   * which made panning past a marker a way to be handed a form nobody asked for.
   */
  await expect(page.locator('.maplibregl-canvas')).toBeVisible();

  const toggle = page.locator('.map-control-add');

  /*
   * The armed cursor, measured either side of the press — and the resting read
   * is the negative control that makes the second one mean something. maplibre
   * sets `cursor: grab` on its own container, so the crosshair is a rule that
   * has to *win* rather than merely exist; a `map.css` selector that lost would
   * report `grab` here and be invisible to every other gate, since jsdom
   * computes no styles and the css contract test only proves text was written.
   */
  expect(await canvasCursor(page)).toBe('grab');

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => canvasCursor(page)).toBe('crosshair');

  const point = await basemapPoint(page);
  await page.mouse.click(point.x, point.y);

  await expect(page.locator('form.add-site-form')).toBeVisible();
});

test('ignores a basemap click while add-site mode is disarmed (issue 265)', async ({ page }) => {
  /*
   * The other half of the mode, and the reason it exists: the map reports every
   * basemap click, and the dashboard answers only the armed ones.
   *
   * `toHaveCount(0)` is satisfied by a page where nothing ever happens, so it
   * carries no proof on its own — the armed case above is what supplies it, by
   * showing that this same helper's point and this same click do open a form
   * once the toggle has been pressed. The `aria-pressed` read below is the
   * other guard: it fails loudly if the control ever ships already armed, which
   * would make this case pass for the wrong reason.
   */
  await expect(page.locator('.maplibregl-canvas')).toBeVisible();
  await expect(page.locator('.map-control-add')).toHaveAttribute('aria-pressed', 'false');

  const point = await basemapPoint(page);
  await page.mouse.click(point.x, point.y);

  await expect(page.locator('form.add-site-form')).toHaveCount(0);
});

test('puts the camera back where it opened when the view is reset (issue 265)', async ({
  page,
}) => {
  /*
   * `MapControls` reads its target from `framing.ts` — the module that also
   * supplies `MapView`'s opening camera — so what this proves is that the two
   * are the same framing rather than two constants that happen to agree. It is
   * a browser criterion in the strict sense: it needs a real camera, a real
   * drag, and marker geometry read off a laid-out page, none of which jsdom has.
   *
   * Markers are the instrument rather than the subject. Their screen positions
   * are a function of the camera, so "every marker is back within two pixels" is
   * the observable form of "the camera went back" — and unlike reading the map's
   * own centre, it goes through the same rendering path a reader looks at.
   */
  await expect(page.locator(ANY_MARKER).first()).toBeVisible();

  const opening = await markerOrigins(page);

  expect(opening.length).toBeGreaterThan(0);

  await dragMap(page);

  // The overlay reclusters on `moveend`, so the drag's effect arrives as a
  // state rather than after a duration — polled, never slept on.
  await expect
    .poll(async () => originDrift(opening, await markerOrigins(page)), {
      message: 'The map never moved, so the reset below would prove nothing.',
    })
    .toBeGreaterThan(RESET_TOLERANCE_PX);

  await page.locator('.map-control-reset').click();

  await expect
    .poll(async () => originDrift(opening, await markerOrigins(page)), {
      message: 'Reset did not return the camera to the framing the map opened on.',
    })
    .toBeLessThanOrEqual(RESET_TOLERANCE_PX);
});

test('answers a marker press with the site panel and nothing else (#17)', async ({ page }) => {
  /*
   * Defect 1. maplibre mounts markers *inside* the container its own click
   * handler is bound to, so before `isMarkerClick` a press on a site was
   * answered twice — selecting it, then opening "add a site here" on top of the
   * selection. `Dashboard` ranks a draft above a selection, so the second answer
   * is the one the reader was left looking at: the site panel they asked for
   * never appeared at all.
   */
  const marker = await revealSiteMarker(page);
  const siteName = await marker.getAttribute('aria-label');

  if (siteName === null) {
    throw new Error('A site marker is on the map without an accessible name.');
  }

  await marker.click();

  await expect(page.locator('.site-panel-title')).toHaveText(siteName);
  await expect(page.locator('form.add-site-form')).toHaveCount(0);
});

test('wraps each marker in one interactive element, not two (#17)', async ({ page }) => {
  /*
   * Defect 2. The wrapper maplibre puts around a marker used to carry
   * `role="button"` while the app's own `<button>` sat inside it, which is a
   * button inside a button as far as assistive technology is concerned: two
   * things to move through, one of them announcing a name and doing nothing.
   *
   * The fix is now the library version — maplibre 6.1.0's
   * `Marker._updateAccessibilityRole` returns early for caller-supplied elements
   * ("Custom marker elements are left alone so applications own their a11y
   * tree"), and `SiteMarkers` supplies its own. That makes this a ratchet on a
   * dependency's behaviour rather than on ours, which is precisely the kind of
   * thing that regresses on an upgrade with nothing else to catch it.
   */
  await revealSiteMarker(page);

  const shapes = await markerShapes(page);

  // Vacuity guard: the filter below passes trivially on an empty overlay.
  expect(shapes.length).toBeGreaterThan(0);

  const doubled = shapes
    .filter((shape) => shape.role !== null || shape.buttons !== 1)
    .map(
      (shape) =>
        `${shape.name ?? '(unnamed)'}: role=${String(shape.role)}, buttons=${String(shape.buttons)}`,
    );

  expect(doubled).toEqual([]);
});

test.describe('canvas sizing', () => {
  test.use({ viewport: NARROW_VIEWPORT });

  test('keeps the GL canvas the size of its container (#17)', async ({ page }) => {
    /*
     * Defect 3. maplibre watches the container itself and throws away the first
     * delivery it gets, on the reasoning that it merely restates the size
     * measured at construction — which stops holding the moment layout settles a
     * frame later. The measured symptom was a 400x183 canvas inside an 816x469
     * container, every marker crowded into the top-left eighth of the map.
     *
     * Two measurements, because they fail to different bugs. The first is the
     * shipped defect: the size the canvas opens at, before anything has moved.
     * The second is the guarantee that survives it — a canvas that agreed once
     * and then stopped tracking would pass the first and fail the second.
     */
    await expect(page.locator('.maplibregl-canvas')).toBeVisible();

    await expect
      .poll(async () => canvasSizeGap(page), { message: 'The canvas opened at the wrong size.' })
      .toBeLessThanOrEqual(CANVAS_SIZE_TOLERANCE_PX);

    await page.setViewportSize(WIDE_VIEWPORT);

    await expect
      .poll(async () => canvasSizeGap(page), {
        message: 'The canvas did not follow its container through a viewport change.',
      })
      .toBeLessThanOrEqual(CANVAS_SIZE_TOLERANCE_PX);
  });
});
