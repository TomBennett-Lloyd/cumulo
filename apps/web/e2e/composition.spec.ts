import type { Locator } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { routeBasemap } from './hermetic-basemap';

/*
 * The shipping composition, asserted once.
 *
 * Everything here is provable only when the real pieces are assembled: the
 * production bundle, the real `LazyMapRegion` resolving its real chunk over
 * HTTP, and a browser that can actually give maplibre a WebGL context. Under
 * jsdom each of those is substituted for a defensible reason, and the sum of
 * those defensible reasons is that the default configuration — the one every
 * visitor gets — is asserted by nobody.
 *
 * Kept small on purpose. This lane is slow (a cold production build per run)
 * and it is not where behaviour gets tested; `src/**` owns that. A case earns
 * its place here only if assembling the app is what makes it true.
 */

/**
 * How far a measured box may miss the edge it is meant to meet, in CSS pixels.
 *
 * Two pixels rather than zero because these are `getBoundingClientRect` reads
 * of a laid-out page: sub-pixel layout, a fractional device pixel ratio and the
 * browser's own rounding all land in the last pixel or so. Two is far below any
 * real failure — a map inset in a padded column misses the viewport edge by a
 * `--space-4` on each side, and a strip that fell back into flow would sit a
 * whole strip-height clear of the map's bottom.
 */
const EDGE_TOLERANCE_PX = 2;

/**
 * A laid-out box in client space — what `Locator.boundingBox` yields once it has
 * one.
 *
 * Derived from the locator's own return type rather than hand-written, so this
 * cannot drift from what Playwright actually hands back (`typing.md` rule 3's
 * principle, applied to a library boundary instead of a schema).
 */
type LayoutBox = NonNullable<Awaited<ReturnType<Locator['boundingBox']>>>;

/**
 * One element's box, once the browser has laid it out.
 *
 * Polled rather than read once, and that is a correctness fix rather than a
 * tolerance: this helper used to throw on the first `null`, which made every
 * caller a race against layout. It lost on CI while passing on every local run
 * (#274 — "The map canvas is on the page but has no layout box", 862ms, so it
 * raced rather than hung). The window is real and specific. `.map-canvas` is
 * worn by both the pending shell and the live map — that is `MapSurface`'s whole
 * point, the same box either side of the swap — so a `toBeVisible` before the
 * measurement can be satisfied by the *placeholder*, and the box read that
 * follows can land in the instant the placeholder has gone and maplibre's
 * container has not yet been laid out. A faster machine simply never loses that
 * instant.
 *
 * So the readiness handling is the poll and nothing else: no `waitForTimeout`,
 * no retry budget, no tolerance on the measurements the callers then make. The
 * state being waited on is "this element has a box", which is exactly the
 * precondition of measuring one.
 *
 * `boundingBox` returning `null` therefore stops meaning "not yet" and starts
 * meaning "never" — an element with no layout at all, which is a different
 * defect from a box in the wrong place and still deserves its own message
 * rather than a `NaN` comparison downstream (`error-handling.md` rule 1). The
 * poll's timeout is what reports it now, so an element that genuinely never
 * gets a box still fails, and fails naming itself.
 *
 * The second read is not redundant. `expect.poll` reports whether the condition
 * held, not the value it held — so the box is read again once the poll has
 * established there is one, and the guard after it covers the one case that
 * leaves: an element that had a box and lost it between the two reads. That is
 * a genuinely different failure from never having had one, and says so.
 *
 * The name is a parameter rather than something reached in from the enclosing
 * test (`structure.md` rule 1), and it is what makes both messages point at the
 * element that actually failed.
 */
const layoutBoxOf = async (locator: Locator, name: string): Promise<LayoutBox> => {
  await expect
    .poll(async () => locator.boundingBox(), {
      message: `${name} never acquired a layout box.`,
    })
    .not.toBeNull();

  const box = await locator.boundingBox();

  if (box === null) {
    throw new Error(`${name} had a layout box and then lost it.`);
  }

  return box;
};

/**
 * The size `generateFleet` (packages/shared/src/fleet.ts) produces for the demo
 * fleet, from its own location count and sites-per-location. The number is here
 * because this spec measures against it; the arithmetic that yields it is the
 * generator's and is not restated (`architecture.md` rule 9).
 */
const DEMO_FLEET_SIZE = 60;

/** The map overlay and the page footer each owe one. More surfaces may owe more. */
const MINIMUM_WEATHER_CREDITS = 2;

/**
 * A viewport inside the range where the credits band compacts, with margin at
 * both ends of it.
 *
 * `map.css` drops the two prefixes at 37.25rem and below, because 596px is where
 * the full row stops fitting on one line; the compact row needs 402px of its
 * own. 480 sits clear of both bounds, so the full form provably would have
 * wrapped at this width and the compact form provably does not — with room to
 * spare for a classic scrollbar taking its share out of the layout viewport
 * first.
 *
 * A phone-width viewport would not do, and that is a fact about the strings
 * rather than about the rule: `© OpenStreetMap contributors`, the separator and
 * `Open-Meteo.com` come to 402px of licence-mandated text at this type size, so
 * at 390px the band wraps whatever any stylesheet does. Compaction buys the
 * single row from 402px upward, not all the way down.
 */
const COMPACT_VIEWPORT = { width: 480, height: 900 };

test.beforeEach(async ({ page }) => {
  await routeBasemap(page);
  await page.goto('/');
});

test('swaps the loading placeholder for a laid-out WebGL canvas', async ({ page }) => {
  const canvas = page.locator('.maplibregl-canvas');
  await expect(canvas).toBeVisible();

  /*
   * Visibility alone would pass on a canvas collapsed to nothing, which is what
   * a map that never got its GL context or its container size looks like from
   * the DOM. The box is the difference between "maplibre mounted" and "maplibre
   * is drawing".
   */
  const box = await canvas.boundingBox();
  if (box === null) {
    throw new Error('The maplibre canvas is visible but has no layout box.');
  }
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);

  /*
   * And the pending shell is gone rather than stacked behind it. `MapSurface`
   * gives the placeholder and the real canvas the same box, so a swap that
   * failed to unmount would be invisible to a screenshot.
   */
  await expect(page.locator('.map-placeholder')).toHaveCount(0);
});

test('lists the whole demo fleet, so the built app resolved the demo data source', async ({
  page,
}) => {
  /*
   * `VITE_API_BASE_URL` is empty in the lane's build (see playwright.config.ts),
   * and this row count is what proves the empty value actually reached
   * `selectFleetDataSource` through the bundle. An HTTP source pointed at
   * nothing would render an error state with no rows at all.
   *
   * Counted through the fleet table's closed disclosure, deliberately and
   * without opening it (#265): a closed `<details>` hides its children from
   * layout but keeps them in the document, so `toHaveCount` — which matches
   * elements rather than visible ones — reads the whole fleet either way. What
   * is under test here is which data source the bundle resolved, and a gesture
   * to reveal the rows would add a way for this case to fail that has nothing to
   * do with that.
   */
  await expect(page.locator('[data-site-id]')).toHaveCount(DEMO_FLEET_SIZE);
});

test('credits Open-Meteo visibly, as CC BY 4.0 requires', async ({ page }) => {
  /*
   * The licence obligation, measured on the assembled page rather than
   * component by component. Both credits ride on surfaces that mount
   * conditionally — the map strip arrives with the lazy chunk, the footer with
   * the fleet column — so only the whole app can show they both survive.
   *
   * At least two rather than exactly two: a third weather-derived surface
   * adding its own credit is compliance, not a regression.
   */
  const credits = page.getByRole('link', { name: 'Open-Meteo.com' }).filter({ visible: true });

  await expect.poll(async () => credits.count()).toBeGreaterThanOrEqual(MINIMUM_WEATHER_CREDITS);
});

test('runs the map edge to edge, with its credits overlaid on its own bottom edge', async ({
  page,
}) => {
  /*
   * Two halves of one decision (#265), and neither is checkable anywhere else.
   * Full bleed is a claim about what every ancestor of the map contributes —
   * the shell, `.app-main`, `.dashboard` — so it is false the moment any one of
   * them grows a padding, and no test of a single component can see that. The
   * overlay is a claim about `position: absolute` resolving against
   * `.map-view`, which jsdom applies no stylesheet to compute at all.
   */
  const canvas = page.locator('.map-canvas');
  const attribution = page.locator('.map-attribution');

  await expect(canvas).toBeVisible();
  await expect(attribution).toBeVisible();

  /*
   * `clientWidth` rather than the configured viewport width: the page scrolls
   * now, so a classic scrollbar takes real width out of the layout viewport,
   * and a full-bleed map is as wide as the space there is rather than as wide
   * as the window. Comparing against the window would make this fail by exactly
   * a scrollbar on any engine that draws one.
   */
  const layoutWidth = await page.evaluate(() => document.documentElement.clientWidth);
  const mapBox = await layoutBoxOf(canvas, 'The map canvas');

  expect(Math.abs(mapBox.width - layoutWidth)).toBeLessThanOrEqual(EDGE_TOLERANCE_PX);
  expect(Math.abs(mapBox.x)).toBeLessThanOrEqual(EDGE_TOLERANCE_PX);

  /*
   * Inside the map's box and sitting on its bottom edge — which together are
   * what "overlaid on the tiles" means as a measurement. A strip that fell back
   * into the flow below the map would clear this bottom by its own height, and
   * one that escaped the map's width would fail the horizontal bounds.
   */
  const stripBox = await layoutBoxOf(attribution, 'The map attribution');

  expect(stripBox.x).toBeGreaterThanOrEqual(mapBox.x - EDGE_TOLERANCE_PX);
  expect(stripBox.x + stripBox.width).toBeLessThanOrEqual(
    mapBox.x + mapBox.width + EDGE_TOLERANCE_PX,
  );
  expect(Math.abs(stripBox.y + stripBox.height - (mapBox.y + mapBox.height))).toBeLessThanOrEqual(
    EDGE_TOLERANCE_PX,
  );

  /*
   * And the credit inside it is still a credit. Moving a CC BY 4.0 link onto
   * imagery is exactly the change that could leave it painted-over, covered by
   * the map's own event surface, or disabled by a `pointer-events` rule reached
   * for to keep the map draggable — so the licence obligation is re-measured
   * here, in the band's new position, rather than assumed from the count above.
   *
   * `click({ trial: true })` is what actually measures that, and the reason the
   * two assertions beside it are not enough: `toBeVisible` passes on a link
   * with another element painted over it, and `toBeEnabled` is vacuous on an
   * anchor, which has no disabled state to report. A trial click runs
   * Playwright's full actionability sequence — including the hit test that
   * `elementFromPoint` at the link's centre resolves to the link — and then
   * stops without navigating. That is precisely the failure mode the move
   * introduced, so it is the one the case has to name.
   */
  const credit = attribution.getByRole('link', { name: 'Open-Meteo.com' });

  await expect(credit).toBeVisible();
  await credit.click({ trial: true });
});

test('drops the credits’ prose to keep the band one row when the window narrows', async ({
  page,
}) => {
  /*
   * The compact attribution form, which only a real browser can see: it is
   * produced entirely by a media query and computed visibility, so jsdom — which
   * applies no stylesheet — reads the identical DOM in both states and could
   * assert nothing about either.
   *
   * The case runs at two widths on purpose. The default one is the vacuity
   * guard: it proves the prefix locators match something and carry the full
   * phrase, so the `toBeHidden` assertions after the resize are measuring a
   * change rather than a selector that never matched. Without it, a typo in
   * either class name would produce exactly the same green.
   */
  const attribution = page.locator('.map-attribution');
  const tilePrefix = attribution.locator('.map-attribution-prefix');
  const weatherPrefix = attribution.locator('.cumulo-attribution-prefix');

  await expect(attribution).toBeVisible();
  await expect(weatherPrefix).toBeVisible();
  await expect(weatherPrefix).toHaveText('Weather data by');
  await expect(tilePrefix).toBeVisible();
  await expect(tilePrefix).toHaveText('basemap tiles by');

  /*
   * The band's height with everything on screen, which is one row at this width.
   * Measured rather than written down: it is the reference the narrow reading is
   * compared against, and taking it from the page keeps this free of the band's
   * padding and line-height tokens, either of which could change without the
   * single-row claim becoming false.
   */
  const oneRow = await layoutBoxOf(attribution, 'The map attribution');

  await page.setViewportSize(COMPACT_VIEWPORT);

  await expect(weatherPrefix).toBeHidden();
  await expect(tilePrefix).toBeHidden();

  /*
   * Polled, because the reading has to wait for layout after the resize rather
   * than for an element to appear, and a box read straight after
   * `setViewportSize` can still be the pre-reflow one. No box at all answers
   * `Infinity` so that the absence fails loudly here instead of comparing
   * `undefined` and passing.
   */
  await expect
    .poll(async () => (await attribution.boundingBox())?.height ?? Number.POSITIVE_INFINITY, {
      message: 'The credits band never settled to a single row after the window narrowed.',
    })
    .toBeLessThanOrEqual(oneRow.height + EDGE_TOLERANCE_PX);

  /*
   * Height alone would still pass if one credit had wrapped inside itself while
   * the band happened to stay short, so the two credits are also asserted onto
   * the same row. The two catch different wraps: this one fails when the weather
   * credit is pushed onto a second line, the height fails when either credit
   * folds internally.
   */
  const tileCredit = await layoutBoxOf(
    attribution.locator('.map-attribution-tiles'),
    'The tile credit',
  );
  const weatherCredit = await layoutBoxOf(
    attribution.locator('.cumulo-attribution'),
    'The weather credit',
  );

  expect(Math.abs(tileCredit.y - weatherCredit.y)).toBeLessThanOrEqual(EDGE_TOLERANCE_PX);

  /* Still the map's own bottom edge, not a band that escaped it as it shrank. */
  const mapBox = await layoutBoxOf(page.locator('.map-canvas'), 'The map canvas');
  const stripBox = await layoutBoxOf(attribution, 'The map attribution');

  expect(stripBox.x).toBeGreaterThanOrEqual(mapBox.x - EDGE_TOLERANCE_PX);
  expect(stripBox.x + stripBox.width).toBeLessThanOrEqual(
    mapBox.x + mapBox.width + EDGE_TOLERANCE_PX,
  );

  /*
   * And the licence hit-test again, in the compact state. `toBeVisible` passes
   * on a link with something painted over it, so the trial click is what
   * actually proves the credit is still followable — the same check this spec
   * makes at the default width, repeated here because hiding a sibling element
   * re-flows the row the link sits in and is exactly the kind of change that
   * could leave it overlapped.
   */
  const credit = attribution.getByRole('link', { name: 'Open-Meteo.com' });

  await expect(credit).toBeVisible();
  await credit.click({ trial: true });

  /*
   * The rule is the map band's alone. The footer gives the credit a row to
   * itself and can hold the full phrase at this width, so it keeps it — which is
   * the condition CLAUDE.md attaches to the compact form, and the reason the
   * media query lives in `map.css` rather than beside the component in
   * `@cumulo/ui`. A rule that leaked to every surface would fail right here.
   */
  await expect(page.locator('.dashboard-footer .cumulo-attribution-prefix')).toBeVisible();
});

test('stacks the fleet chart under the map rather than beside it', async ({ page }) => {
  /*
   * The layout decision itself, at the default viewport — the width at which
   * the old arrangement put this chart in a column *next to* the map, so it is
   * the width where a regression to it would be invisible to a narrow-viewport
   * check. There is no breakpoint any more, which is the claim: the same flow
   * at every width.
   *
   * `>=` on the raw edges rather than a tolerance: these two boxes are in
   * different, non-overlapping parts of the flow, separated by a `--space-4`
   * gap and the panel's own padding, so there is nothing here for sub-pixel
   * rounding to decide. A tolerance would only be admitting an overlap.
   */
  const chart = page.locator('.fleet-panel .forecast-chart-figure');

  await expect(chart).toBeVisible();

  const mapBox = await layoutBoxOf(page.locator('.map-canvas'), 'The map canvas');
  const chartBox = await layoutBoxOf(chart, 'The fleet chart figure');

  expect(chartBox.y).toBeGreaterThanOrEqual(mapBox.y + mapBox.height);
});
