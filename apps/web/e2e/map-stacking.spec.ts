import type { Locator, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { routeBasemap } from './hermetic-basemap';
import type { LayoutBox } from './layout-box';
import { boxOf } from './layout-box';
import { revealSiteMarker } from './marker-reveal';

/*
 * The map's own chrome stays reachable when the selected site's card lands on it.
 *
 * The defect this pins (#450): `.site-popover-anchor` gives the card's maplibre
 * marker a `z-index` so it outranks the fleet's markers, and nothing between
 * either element and the document root opens a stacking context — so the value
 * was never confined to maplibre's pane. The card competed with `.map-controls`
 * in the *root* stacking context, where any positive value beats `auto` whatever
 * the document order, and a reader who panned the card under the top-right
 * corner lost the reset button underneath it. `map/map.css` carries the argument
 * and the fix; `header/header.css` carries the census of these values.
 *
 * Browser-only by construction (`testing.md` rule 10). What paints over what is
 * what a compositor does with two overlapping boxes, and the question asked here
 * is a hit test — which `toBeVisible` cannot make, jsdom cannot compute, and
 * `map/map-css-contract.test.ts` can only answer as far as "a declaration was
 * written", never "it wins".
 *
 * Its own file rather than a seventh case in `map-regressions.spec.ts`: that file
 * measures close to `max-lines`' 300-code-line ceiling with less headroom than
 * this would take, and the lane already splits one spec per surface —
 * `attribution-band.spec.ts` is the nearest precedent and states the argument at
 * length (`structure.md` rule 4).
 */

/** Keeps a press point off the map's own edge furniture — the chip, the controls. */
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
 * How long the button is held still before it comes up.
 *
 * Part of the gesture, not a wait for anything: it is what makes this a pan
 * rather than a **fling**. `attribution-band.spec.ts`'s own constant carries the
 * argument, the measurement behind it and what maplibre does with a pointer that
 * was still moving on release — this is the same 300ms for the same reason and
 * points there rather than restating it.
 */
const DRAG_SETTLE_MS = 300;

/**
 * How many pans to allow before calling it a failure.
 *
 * A ceiling rather than a target: the distance is computed exactly, so one pan is
 * what this normally costs and a second is the rounding budget. Anything
 * approaching six means the drag is not moving the camera the way the arithmetic
 * assumes, which deserves a loud error naming that rather than a loop spinning
 * until Playwright's timeout kills it with no explanation.
 */
const MAX_PAN_ATTEMPTS = 6;

/** Below this the pan is a no-op, so a loop of them would spin rather than converge. */
const MIN_PAN_PX = 1;

const MAP_CANVAS = '.map-canvas';
const CONTROLS = '.map-controls';
const RESET_CONTROL = '.map-control-reset';
const CARD = '.site-popover';

interface ViewportPoint {
  readonly x: number;
  readonly y: number;
}

const centreOf = (box: LayoutBox): ViewportPoint => ({
  x: box.x + box.width / 2,
  y: box.y + box.height / 2,
});

const contains = (box: LayoutBox, point: ViewportPoint): boolean =>
  point.x >= box.x &&
  point.x <= box.x + box.width &&
  point.y >= box.y &&
  point.y <= box.y + box.height;

/**
 * Whether what the browser paints at a point belongs to `selector`.
 *
 * `closest` rather than identity: whatever is topmost at a control's centre may
 * be the button, its `<svg>` or a path inside it, and at a point on the card it
 * may be any of the elements the card is built from.
 *
 * A fourth copy of this idiom in the lane — `attribution-band.spec.ts`,
 * `map-regressions.spec.ts` and `marker-reveal.ts` each carry their own — and
 * restated rather than lifted into a shared module on `structure.md` rule 7's
 * test: each asks a different surface's question, and none of them would be wrong
 * until the others changed the same way. The three-line body is the whole of what
 * would be shared.
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
 * A positive test rather than a list of overlays to reject, for the reason
 * `attribution-band.spec.ts` gives its own copy: a copied exclusion list is a
 * second place to update when an overlay is added, and silently stops protecting
 * whichever copy was not.
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
 * Where to press for a drag that has to carry the card by `wanted`.
 *
 * The corner opposite the direction of travel, so the whole width and height are
 * ahead of the press. The card has to reach the *top-right* corner, so the travel
 * is up and to the right and the press lands bottom-left — which is the one
 * corner of this map nothing is pinned to: the controls hold the top-right and
 * the credits chip the bottom-right (`map.css`), and a press on either never
 * reaches maplibre at all. The other quadrants are computed rather than excluded,
 * and `pressWouldPanTheMap` is what reports it if a framing ever lands the card
 * somewhere that needs one of them.
 */
const pressPointFor = (map: LayoutBox, wanted: ViewportPoint): ViewportPoint => ({
  x: wanted.x >= 0 ? map.x + EDGE_INSET_PX : map.x + map.width - EDGE_INSET_PX,
  y: wanted.y >= 0 ? map.y + EDGE_INSET_PX : map.y + map.height - EDGE_INSET_PX,
});

/**
 * One pan, aimed at putting the card's centre on the reset control's.
 *
 * Aiming the centre overshoots what the assertion needs — the card is far wider
 * than the control, so its box swallows that point long before the two centres
 * meet — and that is deliberate: the loop re-measures and stops as soon as the
 * point is covered, so the aim only has to point the right way.
 *
 * Each component is clamped to the room the press point has in that direction, so
 * the path cannot leave the map's box on the way, and a pan that clamps to
 * nothing on both axes throws rather than dragging zero pixels — "the card is
 * already as close as a pan from here can put it" reports itself instead of
 * quietly exhausting the attempts.
 */
const panCardTowardsControls = async (page: Page, card: Locator, reset: Locator): Promise<void> => {
  const map = await boxOf(page.locator(MAP_CANVAS), 'The map canvas');
  const from = centreOf(await boxOf(card, "The selected site's card"));
  const target = centreOf(await boxOf(reset, 'The reset control'));

  const wanted = { x: target.x - from.x, y: target.y - from.y };
  const start = pressPointFor(map, wanted);

  if (!(await pressWouldPanTheMap(page, start))) {
    throw new Error(
      `The map is covered at (${String(Math.round(start.x))}, ${String(Math.round(start.y))}), so there is nowhere to press to pan.`,
    );
  }

  const roomX =
    wanted.x >= 0 ? map.x + map.width - EDGE_INSET_PX - start.x : start.x - (map.x + EDGE_INSET_PX);
  const roomY =
    wanted.y >= 0
      ? map.y + map.height - EDGE_INSET_PX - start.y
      : start.y - (map.y + EDGE_INSET_PX);

  const dx = Math.sign(wanted.x) * Math.min(Math.abs(wanted.x), roomX);
  const dy = Math.sign(wanted.y) * Math.min(Math.abs(wanted.y), roomY);

  if (Math.hypot(dx, dy) < MIN_PAN_PX) {
    throw new Error(
      `A pan from (${String(Math.round(start.x))}, ${String(Math.round(start.y))}) cannot carry the card any closer to the controls (${String(Math.round(dx))}, ${String(Math.round(dy))}).`,
    );
  }

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + dx, start.y + dy, { steps: DRAG_STEPS });

  // Held still, then released: a pan rather than a fling (`DRAG_SETTLE_MS`).
  await page.waitForTimeout(DRAG_SETTLE_MS);

  await page.mouse.up();
};

const cardCoversResetCentre = async (page: Page, card: Locator, reset: Locator): Promise<boolean> =>
  contains(
    await boxOf(card, "The selected site's card"),
    centreOf(await boxOf(reset, 'The reset control')),
  );

/**
 * Pan until the card's box holds the reset control's centre.
 *
 * The loop re-measures before every attempt rather than trusting the first
 * arithmetic, and re-asserts the card between them so a card that left the map
 * fails *here*, naming that, instead of becoming an assertion about nothing
 * further down. The polled reading at the end reports the whole failure if the
 * pans never converged, and absorbs the last camera settle with it: the arrival
 * is waited on as a state, never as a duration.
 */
const panCardOverControls = async (page: Page, card: Locator, reset: Locator): Promise<void> => {
  for (let attempt = 0; attempt < MAX_PAN_ATTEMPTS; attempt += 1) {
    if (await cardCoversResetCentre(page, card, reset)) {
      break;
    }

    await panCardTowardsControls(page, card, reset);

    await expect(card, 'The panned card stopped being drawn.').toBeVisible();
  }

  await expect
    .poll(async () => cardCoversResetCentre(page, card, reset), {
      message: `The card never came to rest over the reset control within ${String(MAX_PAN_ATTEMPTS)} pans.`,
    })
    .toBe(true);
};

test.beforeEach(async ({ page }) => {
  await routeBasemap(page);
  await page.goto('/');
});

/*
 * `issue 450` rather than `#450` in the title: `no-restricted-syntax` in
 * `eslint.config.mjs` reads any string literal matching `#[0-9a-fA-F]{3,8}` as a
 * hex colour, which a three-digit issue number is. `attribution-band.spec.ts`
 * carries the same note over its own titles; comments, which the rule does not
 * read, keep the `#` form.
 */
test('keeps the map controls on top of a selected site card panned under them (issue 450)', async ({
  page,
}) => {
  const marker = await revealSiteMarker(page);

  await marker.click();

  const card = page.locator(CARD);

  await expect(card).toBeVisible();

  /*
   * The positive control, and the reason the occlusion assertions below mean
   * anything. Both of them turn on `elementFromPoint` finding, or failing to
   * find, this card — which would read exactly the same on a page where the card
   * was never hit-testable at all: a renamed class, a card with no box, a card
   * the pointer falls straight through. So the predicate is shown biting on the
   * card, at its own centre, before the map moves.
   */
  expect(
    await paintedAtBelongsTo(page, centreOf(await boxOf(card, "The selected site's card")), CARD),
    'The card is not reachable at its own centre before the pan, so nothing below is measured.',
  ).toBe(true);

  const reset = page.locator(RESET_CONTROL);

  await panCardOverControls(page, card, reset);

  /*
   * The fix, as a fact, asked in both directions at the one point that matters —
   * the control's own centre, which the loop above has just put inside the card's
   * box. "The controls are here" and "the card is not" fail to different changes,
   * and either alone would pass on a page where the two overlap harmlessly.
   */
  const contested = centreOf(await boxOf(reset, 'The reset control'));

  expect(
    await paintedAtBelongsTo(page, contested, CONTROLS),
    'The map controls are not what the browser paints at the reset control, under a card covering it.',
  ).toBe(true);
  expect(
    await paintedAtBelongsTo(page, contested, CARD),
    'The card is painting over the reset control, so a reader who panned it there cannot press it.',
  ).toBe(false);
});
