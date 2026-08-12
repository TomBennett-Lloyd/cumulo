import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { routeBasemap } from './hermetic-basemap';
import { settledBoxOf } from './layout-box';
import { revealSiteMarker } from './marker-reveal';
import { firstSiteIdentity } from './site-identity';

/*
 * Where the focus is when a site opens, driven by a real keyboard and a real
 * address bar.
 *
 * The dashboard's answer to a *reader-initiated* selection is now no focus move
 * at all: the reader is left standing on the control they pressed, and the page
 * answers by changing around them rather than by taking their place away
 * (#328, `design.md` rule 11 — the landing was the card's own heading under
 * #93, then the fleet panel's range picker under #284 D14, and is nowhere now).
 * Under jsdom that is provable only as far as `document.activeElement` — the
 * assertion `Dashboard.focus.test.tsx` already makes. What it cannot show is the
 * half a reader actually experiences: whether the ring `@cumulo/ui` paints on
 * `:focus-visible` is still on the marker they pressed. `:focus-visible` is a
 * browser heuristic over *how* focus arrived, jsdom implements no heuristic and
 * paints nothing, and no amount of unit testing can substitute for one.
 *
 * That ring is the half of WCAG 2.4.7 the rings-only-for-keyboards change (#339)
 * has to keep: rings came off *pointer* flows, and a keyboard reader who presses
 * Enter on a site must still be able to see where they are afterwards. So the
 * first case is one interaction performed the way a keyboard user performs it:
 * Tab until a site's marker holds the focus, press Enter, and measure what the
 * browser then decided to paint. Every step is a real key event —
 * `Locator.press` on the marker would reach the same handler while telling us
 * nothing about whether the marker is reachable by tabbing at all.
 *
 * The marker is where that claim lives since #451 took the fleet's table off the
 * page (the owner's round-3 decision; `docs/design/dashboard-composition.md`
 * records it). It used to be a table row, and the table was the *second* way to
 * select a site — so the row carrying the ring and the marker carrying it were
 * two routes to the same state and this case measured the easier one. Two routes
 * remain and they are not interchangeable: the header's search reaches a site
 * *by name* and keeps the focus in its own input, which is the combobox's own
 * discipline (`header.spec.ts` drives it that way), so the marker is the only
 * route that ever hands a keyboard reader the focus out onto the map. A marker
 * nothing can tab to would shut the map — the page's primary surface, and the
 * only way to reach a site spatially rather than by name — to a keyboard reader
 * entirely (WCAG 2.1.1), and a marker that takes focus without painting is that
 * reader standing somewhere they cannot see (WCAG 2.4.7). Both are what the
 * first case fails on, and no other spec in either lane can: jsdom paints no
 * ring, and `pointer-focus.spec.ts` is satisfied by a page with no rings
 * anywhere.
 *
 * What it leaves uncovered is worth naming here rather than leaving to be
 * inferred. The card's hand-back on the way out is owed only to a reader who has
 * come *into* the card, which since #328 no selection does for them — that path
 * is `document.activeElement` again, so `map/SitePopoverCard.test.tsx` and
 * `Dashboard.focus.test.tsx` keep it in the lane that can see it rather than
 * this one re-proving it slowly. But the *journey* into the card is exactly this
 * lane's kind of question and no case here asks it. The card is portaled into
 * maplibre's marker overlay, as the markers themselves are, so where it lands
 * relative to the marker that opened it is decided by the order maplibre
 * appended the two elements in rather than by anything this repo writes down.
 * Only a real tab order can say whether a reader arrives. `docs/tech-debt.md`
 * carries that gap; this comment is not a claim that it is covered.
 *
 * The second case measures the same ring on the fleet chart, and it exists
 * because #440 gave that chart the only pointer-ring suppression on this page
 * that the engine is not making for us. A tap on the chart leaves
 * `:focus-visible` measurably false while a ring is painted anyway — whatever
 * paints it, a rule carrying that conjunct is evaluated by the same engine that
 * answered false and so cannot match — which is why `charts.css` suppresses on an
 * attribute the component sets from the focus's *source* instead. An author rule
 * that can take a ring off can take it off too widely, and this case stands at
 * exactly that edge: tab to the chart, and the ring is still there.
 * `e2e/pointer-focus.spec.ts` holds the other side of that split, on a real
 * finger; neither half means anything alone.
 *
 * That edge has more sides than one case can stand on, which is what the touch
 * describe at the foot of this file is for. Tabbing in from a fresh page proves
 * the *selector* — a rule that dropped the attribute would fail it — and nothing
 * else, because a chart no finger has been near has no attribute to be left set
 * and no blur to fail to clear. The three cases there are the states in which it
 * could be: a chart that was tapped and then driven by keyboard, a chart that was
 * tapped and returned to by Tab, and a chart that was *scrubbed* — the gesture
 * that fires no `click` at all. The boundary takes that focus itself at the lift
 * (`endGestureAtLift`), for a scrub as for a tap wherever a reading stands,
 * because a reading with no focus behind it has no blur to be dismissed by and no
 * way at all to go away; what this lane can say about it that jsdom cannot is that the
 * focus so taken paints no ring, and that the ring is waiting when the reader
 * comes back to the chart by Tab.
 *
 * The last case is the other half of the same rule, and it is the reason #260
 * was routed to this lane at all. A `?site=` link is *not* a reader asking for
 * anything now, so the card must take no focus — and "no focus was taken" is a
 * claim about the whole assembled page arriving over HTTP, which is what this
 * lane is and jsdom's synchronous mount is not.
 */

/**
 * How many Tab presses to allow before calling the target unreachable.
 *
 * A ceiling, not a measurement of the tab order: the map's marker buttons come
 * before the content column in DOM order — the map is the first thing in the
 * dashboard and the column follows it down the page (#265) — and their number
 * moves with the clustering, so pinning an exact count would make a case fail on
 * a camera change rather than on a defect. Generous enough to cross every
 * marker, small enough that a control nothing can tab into fails loudly here
 * rather than as an unexplained Playwright timeout.
 */
const MAX_TAB_PRESSES = 100;

/** The fleet chart's canvas — since #421 the element a pointer lands on too. */
const CHART_SVG = 'svg.forecast-chart';

/** What the browser decided to paint around the focused element. */
interface FocusRing {
  /** CSS `outline-style`; `none` is the shape of a ring that never painted. */
  readonly style: string;
  readonly widthPx: number;
}

/** One site's mark on the map — a real `<button>` (`src/map/MarkerButton.tsx`). */
const SITE_MARKER = '.map-site-marker';

/**
 * The marker for one named site.
 *
 * By accessible name rather than by position, because "the marker I revealed" is
 * what every caller here means and the drawn set is reordered by the clustering.
 * The name is safe to interpolate: the demo fleet composes it from a place and
 * an index (`packages/shared/src/fleet.ts`), so it carries no quote to close the
 * attribute selector early.
 */
const markerByName = (name: string): string => `${SITE_MARKER}[aria-label="${name}"]`;

/**
 * The focused site marker's name, or `null` when focus is anywhere else.
 *
 * `matches` rather than `closest`: what the cases below are about is the reader
 * standing on the marker itself, and a focus that had landed on something
 * *inside* it would be a different state worth failing on rather than one to
 * report as the marker's.
 */
const focusedMarkerName = async (page: Page): Promise<string | null> =>
  page.evaluate((selector) => {
    const active = document.activeElement;

    return active?.matches(selector) === true ? active.getAttribute('aria-label') : null;
  }, SITE_MARKER);

/**
 * Tab from wherever the focus is until one named site's marker is holding it.
 *
 * This is the reachability half of the case that calls it, not scaffolding for
 * it: the map is the only way to select a site *spatially* since #451 — the
 * header's search reaches one by name — so a marker that never takes focus is a
 * map no keyboard reader can open a site from (WCAG 2.1.1) and the throw below
 * is what that reads as. Visibility first, because a marker still
 * inside its cluster is not in the tab order at all and the loop would report
 * the unreachability of something that was never drawn.
 *
 * Throws with the site named rather than letting the ring measurement report a
 * `none` on whatever else happened to hold the focus.
 */
const tabToMarker = async (page: Page, name: string): Promise<void> => {
  await expect(page.locator(markerByName(name))).toBeVisible();

  for (let press = 0; press < MAX_TAB_PRESSES; press += 1) {
    if ((await focusedMarkerName(page)) === name) {
      return;
    }

    await page.keyboard.press('Tab');
  }

  throw new Error(
    `The marker for ${name} took no focus within ${String(MAX_TAB_PRESSES)} Tab presses.`,
  );
};

/**
 * Tab from wherever the focus is until the fleet chart is holding it.
 *
 * The same ceiling idiom as `tabToMarker`, for the same reason: the map precedes
 * the content column in DOM order, so the route to the chart crosses every
 * marker button and that count moves with the clustering. Throws with the
 * element named rather than letting the measurement below report a `none` on
 * whatever else happened to hold the focus — a chart nothing can tab into is a
 * WCAG 2.1.1 failure and should read as one, not as a puzzling ring result.
 */
const tabToChart = async (page: Page): Promise<void> => {
  const chart = page.locator(CHART_SVG);

  await expect(chart).toBeVisible();

  for (let press = 0; press < MAX_TAB_PRESSES; press += 1) {
    if (await chart.evaluate((element) => element === document.activeElement)) {
      return;
    }

    await page.keyboard.press('Tab');
  }

  throw new Error(
    `The forecast chart took no focus within ${String(MAX_TAB_PRESSES)} Tab presses.`,
  );
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

test('leaves a keyboard selection standing on the marker it was made from, ring and all', async ({
  page,
}) => {
  /*
   * The map first: it is both what this tabs to and what it tabs *through*, and
   * starting before its markers have mounted would mean tabbing through a
   * document that is still growing in front of the cursor.
   */
  await expect(page.locator('.maplibregl-canvas')).toBeVisible();

  /*
   * One site drawn on its own, which the demo fleet's camera does not start
   * with: at `INITIAL_CAMERA` the seeded sites read as clusters, and a cluster
   * is not a site (`marker-reveal.ts` argues the zoom and owns the gesture).
   * That gesture is a pointer one and nothing whatever is claimed about it — the
   * keyboard route is what this case then performs, from a fresh focus, and it
   * is asserted from the Tab below onwards. The deep-link case at the foot of
   * this file reads its id the same way and for the same reason.
   */
  const marker = await revealSiteMarker(page);
  const siteName = await marker.getAttribute('aria-label');

  if (siteName === null) {
    throw new Error('The revealed site marker carries no accessible name to tab to.');
  }

  await tabToMarker(page, siteName);

  await page.keyboard.press('Enter');

  /*
   * The marker answered. `?site=` is how a selection states itself — the URL is
   * the selection's owner (`dashboard/selection-origin.ts`), so a press that
   * lit a marker up without selecting anything fails here rather than surviving
   * to the focus assertions, which a merely-focused marker would satisfy.
   */
  await expect.poll(() => new URL(page.url()).searchParams.get('site')).not.toBeNull();

  /*
   * And answered for the site whose marker it was. Without this the case would
   * still pass if Enter had opened a neighbour — the marker keeps the focus
   * whichever site was chosen, so everything below would be green while the
   * reader looked at a site they never asked for. Checked on the card's title
   * rather than on the id, because the name is what the marker and the card have
   * in common; the marker carries no identifier for a reader or for this case to
   * compare (`site-identity.ts` is where a spec needing the id goes).
   */
  await expect(page.locator('.site-popover')).toBeVisible();
  await expect(page.locator('.site-popover-title')).toHaveText(siteName);

  /*
   * And the reader is exactly where they left themselves. Nothing on this page
   * moves the focus on a selection any more (#328, `design.md` rule 11), so the
   * marker that was pressed is still the active element — compared by name
   * rather than by locator, because "the marker I pressed" is what the rule is
   * about and a locator would let a different marker of the same shape satisfy
   * it.
   */
  await expect.poll(() => focusedMarkerName(page)).toBe(siteName);

  /*
   * And the ring is still on it, which is the half of WCAG 2.4.7 that survived
   * #339: rings were taken off *pointer* interaction only, and this focus was
   * arrived at by Tab and held through a keystroke, so the browser's
   * `:focus-visible` heuristic must still be painting one. If this ever reads
   * `none`, a keyboard reader is pressing Enter on the map's only route into a
   * site, and getting no visible sign of where they are standing.
   */
  const ring = await focusRing(page, markerByName(siteName));

  expect(ring.style).toBe('solid');
  expect(ring.widthPx).toBeGreaterThan(0);
});

test('paints the ring on the forecast chart when a keyboard reader tabs to it', async ({
  page,
}) => {
  /*
   * The guarded edge of #440's suppression, and the reason that suppression is
   * allowed to exist. The chart is the one control on this page whose pointer
   * ring is taken off by an author rule rather than by the engine's
   * `:focus-visible` heuristic — `charts.css` keys `outline-style: none` on the
   * `data-focus-via-pointer` attribute the boundary sets only when a press
   * brought the focus in. What this case holds is the *selector*: a rule that
   * dropped the attribute would suppress on the element itself and take the ring
   * off a reader who tabbed here from a fresh page — a chart they can reach and
   * then cannot see themselves standing on, which is a WCAG 2.4.7 failure and is
   * what this case fails on. What it cannot hold is the attribute's *lifetime*,
   * since nothing here ever sets it: no finger has been near this chart, so
   * there is no attribute to be left behind and no blur to fail to clear. Those
   * states are the touch describe's at the foot of this file, and the claim is
   * split that way rather than made here on their behalf.
   *
   * `solid` specifically, and not merely "a ring". That is the style
   * `@cumulo/ui` writes (`packages/ui/src/styles.css`,
   * `:where(…, [tabindex]):focus-visible`), and it is the only outline any author
   * rule in this repo paints — `charts.css`'s guarded rule writes `none`, and no
   * other stylesheet here declares an `outline` at all. So demanding `solid` is
   * demanding that the keyboard path is served by *our* ring rather than by
   * anything else that might put an outline on this element; a ring of some other
   * style would satisfy "visible" while saying nothing about which rule is still
   * reaching it.
   *
   * The map first, as above: it is what this tabs through, and a document still
   * growing in front of the cursor is not a tab order.
   */
  await expect(page.locator('.maplibregl-canvas')).toBeVisible();

  await tabToChart(page);

  const ring = await focusRing(page, CHART_SVG);

  expect(ring.style).toBe('solid');
  expect(ring.widthPx).toBeGreaterThan(0);
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
   * 3.2.5). Since #328 neither arm moves focus on the way in, so what the
   * address bar's arm still refuses *alone* is the **capture**: whatever held
   * the focus at that arbitrary instant is not an opener anybody chose to be
   * returned to, which is the asymmetry `dashboard/selection-origin.ts` carries.
   * This is the case that would fail if a mount-time focus move ever came back,
   * and it is the arm that can see it — on a fresh load there is a `body` to
   * read the absence against, where a reader's own press leaves focus on the
   * control they pressed.
   *
   * An id read off the running page rather than a constant, for the reason
   * `dashboard-test-fixture.ts` gives about the same thing: a link's id comes
   * from a real fleet, and one derived the way the demo fleet derives its own
   * would still pass if both drifted together. Reading it is a pointer gesture
   * on the map and nothing is being claimed about it — the keyboard route to a
   * marker is the case above — and `site-identity.ts` hands back a freshly
   * loaded page, which is what the `body` reading below needs.
   */
  const { id } = await firstSiteIdentity(page);

  await page.goto(`/?site=${id}`);

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

/*
 * The states a finger leaves behind, and whether the ring comes back in them.
 *
 * `hasTouch` is a browser-context option rather than a per-action one, so it has
 * to be scoped by a describe — and scoped rather than set file-wide, because
 * everything above must keep arriving as a plain keyboard on a plain desktop
 * context. Every case here is still a *keyboard* assertion: what changes is the
 * state the keyboard arrives into, which is the half the case above cannot reach.
 */
test.describe('after a finger has been on the chart', () => {
  test.use({ hasTouch: true });

  /** Where a reading stands, and so whether a gesture reached the chart at all. */
  const CROSSHAIR = '.forecast-chart-crosshair';

  /**
   * Where the scrub starts and the three positions it drags through, as shares
   * of the chart's width.
   *
   * Inside the chart at every step, and far enough apart that the gesture is
   * unambiguously a drag rather than a jittery tap — what Chromium does with it
   * is the whole point, and a movement inside the tap slop would be a tap.
   */
  const SCRUB_SHARES = [0.25, 0.4, 0.55, 0.7];

  /** Whether the canvas is what the document would send a key to. */
  const chartHasFocus = async (page: Page): Promise<boolean> =>
    page.evaluate(
      (selector) => document.activeElement === document.querySelector(selector),
      CHART_SVG,
    );

  /** A finger tapping the chart, with the focus it must take asserted. */
  const tapChart = async (page: Page): Promise<void> => {
    const chart = page.locator(CHART_SVG);

    await expect(chart).toBeVisible();
    await chart.scrollIntoViewIfNeeded();
    await chart.tap();
    await expect(chart).toBeFocused();
  };

  /**
   * A finger dragged across the chart — a scrub, which is a tap that never
   * completes.
   *
   * Driven through a raw CDP touch sequence, because Playwright's touchscreen API
   * offers `tap` and nothing else: there is no primitive that holds a finger down
   * and moves it, which is the same gap `chart-tap.spec.ts`'s header states. This
   * is one level below `Locator.tap`, which dispatches through the same channel,
   * and it is Chromium-only — which this lane already is, by the single project
   * in `playwright.config.ts`.
   *
   * The y never changes, deliberately. `touch-action: pan-y pinch-zoom` leaves
   * vertical movement to the browser, so a drag with any vertical component
   * risks becoming a page scroll — which would be a `pointercancel`, a different
   * gesture with a different clearing path (`clearAtCancel`), and not the one
   * the case below is about.
   *
   * The box is read through `settledBoxOf` because these are coordinates a
   * gesture is aimed by: the map above pushes the chart down the page after first
   * paint, and a finger placed from a mid-reflow reading lands where the chart no
   * longer is (`layout-box.ts`).
   */
  const scrubChart = async (page: Page): Promise<void> => {
    const chart = page.locator(CHART_SVG);

    await expect(chart).toBeVisible();
    await chart.scrollIntoViewIfNeeded();

    const box = await settledBoxOf(chart, 'The forecast chart');
    const y = box.y + box.height / 2;
    const session = await page.context().newCDPSession(page);

    try {
      for (const [step, share] of SCRUB_SHARES.entries()) {
        await session.send('Input.dispatchTouchEvent', {
          type: step === 0 ? 'touchStart' : 'touchMove',
          touchPoints: [{ x: box.x + box.width * share, y }],
        });
      }

      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally {
      await session.detach();
    }
  };

  test('paints the ring again when a reader who tapped starts driving by keyboard', async ({
    page,
  }) => {
    await expect(page.locator('.maplibregl-canvas')).toBeVisible();
    await tapChart(page);

    /*
     * The state being left, asserted rather than assumed. Without it the case is
     * satisfied by a suppression that never happened — a chart that painted a
     * ring under the finger too would sail through everything below while being
     * exactly the defect #440 was opened for.
     */
    expect((await focusRing(page, CHART_SVG)).style).toBe('none');

    // A reader who starts driving by keyboard earns the ring back, whatever
    // brought them here. `readAtKey` drops the attribute ahead of its own action
    // lookup, so this holds for a key the chart acts on and one it ignores alike.
    await page.keyboard.press('ArrowRight');

    /*
     * A ring, rather than `solid` specifically. What this case is about is our
     * attribute no longer suppressing; which stylesheet then paints is the
     * engine's business, since whether its own heuristic flips on a keypress that
     * moves no focus is exactly the judgement #440 stopped relying on. Either
     * outcome is a reader who can see where they are standing, which is the
     * WCAG 2.4.7 claim; neither is `none`.
     */
    const ring = await focusRing(page, CHART_SVG);

    expect(ring.style).not.toBe('none');
    expect(ring.widthPx).toBeGreaterThan(0);
  });

  test('paints the ring when a reader tabs back to a chart they had tapped', async ({ page }) => {
    await expect(page.locator('.maplibregl-canvas')).toBeVisible();
    await tapChart(page);

    expect((await focusRing(page, CHART_SVG)).style).toBe('none');

    // Out and back by keyboard. The leaving half is asserted because it is what
    // makes the return a *fresh* focus: a Tab that never left would make the
    // assertion below a re-read of the state above.
    await page.keyboard.press('Tab');
    expect(await chartHasFocus(page)).toBe(false);

    await page.keyboard.press('Shift+Tab');
    expect(await chartHasFocus(page)).toBe(true);

    // `solid` here, unlike the case above: this focus arrived by Tab, so it is
    // the same keyboard arrival the file's second case pins, reached through a
    // state where the attribute had been set and had to be cleared on the way out.
    const ring = await focusRing(page, CHART_SVG);

    expect(ring.style).toBe('solid');
    expect(ring.widthPx).toBeGreaterThan(0);
  });

  test('leaves a scrubbed chart focused without a ring, and rings when the reader tabs back', async ({
    page,
  }) => {
    await expect(page.locator('.maplibregl-canvas')).toBeVisible();

    await scrubChart(page);

    /*
     * Both premises, and the case is hollow without either.
     *
     * The scrub reached the chart: a crosshair is what a reading looks like, and
     * a gesture that missed would leave the press flag unset and every ring
     * reading below decided for the wrong reason entirely.
     *
     * And the chart is holding the focus, which is the half only a real browser
     * can settle. A drag past the tap slop fires no `click` here — that is
     * Chromium's decision, not ours — so this focus is the boundary's own, taken
     * at the lift because a reading behind no focus has no blur to be dismissed
     * by. It is also this file's replacement for the premise this case used to
     * carry: it once asserted *no* focus and reached the chart by tabbing, and
     * what proved the press flag had been spent was the Tab that spent it. A
     * scrub no longer leaves a flag pending for anything to consume, so that
     * proof moved to jsdom, where the press-with-no-lift it needs can be
     * dispatched (`src/charts/forecast-chart-focus-source.test.tsx`).
     */
    await expect(page.locator(CROSSHAIR)).toHaveCount(1);
    expect(await chartHasFocus(page)).toBe(true);

    /*
     * And it carries no ring. This is the assertion that keeps the fix honest:
     * the cheapest way to give a scrub a dismissal route would be a focus taken
     * without the press stamp behind it, and that focus would paint the very ring
     * under a finger #440 removed — green on dismissal, red on the reason #440
     * exists. `pointer-focus.spec.ts` holds the same claim for a tap.
     */
    expect((await focusRing(page, CHART_SVG)).style).toBe('none');

    /*
     * Out by keyboard, which is the dismissal that focus bought: the blur takes
     * the reading with it, and a crosshair still standing here means the reader
     * is left with a reading they cannot get rid of — #421's contract broken on
     * the one gesture that cannot inherit it.
     */
    await page.keyboard.press('Tab');
    expect(await chartHasFocus(page)).toBe(false);
    await expect(page.locator(CROSSHAIR)).toHaveCount(0);

    /*
     * And back in, which is the WCAG 2.4.7 half: a keyboard reader arriving at a
     * chart a finger has been on must see where they are standing, so the
     * attribute the scrub set has to have been cleared on the way out. `solid`
     * rather than merely "a ring", for the reason the file's second case gives —
     * it is the style `@cumulo/ui` writes, so demanding it demands that the
     * keyboard path is served by our ring rather than by anything else.
     */
    await page.keyboard.press('Shift+Tab');
    expect(await chartHasFocus(page)).toBe(true);

    const ring = await focusRing(page, CHART_SVG);

    expect(ring.style).toBe('solid');
    expect(ring.widthPx).toBeGreaterThan(0);
  });
});
