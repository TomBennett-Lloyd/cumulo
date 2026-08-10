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
 * its place here only if assembling the app is what makes it true — with one
 * documented exception, at the foot of this file.
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
 * The one capability `layoutBoxOf` needs of the thing it measures.
 *
 * Derived from `Locator` rather than restated, on the same principle as
 * `LayoutBox` above: the helper cannot drift from Playwright's signature
 * because it does not own it. Narrowing to the single method is also the seam
 * the regression case below needs — a real `Locator` cannot be asked to flicker
 * on demand, and what the helper does when its source flickers is the whole
 * behaviour under test.
 */
type BoxSource = Pick<Locator, 'boundingBox'>;

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
 * The sample the poll settles on is the sample returned. `expect.poll` reports
 * whether the condition held rather than the value it held, and this helper
 * used to answer that by reading the box a second time — which re-opened at the
 * other end the race #274 closed at this one. A box read is a state, and a
 * state worth observing is a state worth keeping: between the two reads the
 * element was free to lose its layout again, and it was the second read that
 * owned the assertion. Three consecutive CI failures over one byte-identical
 * tree measured the window a contended runner opens — rotating victims across
 * two tests and two elements, with this helper and its message constant in all
 * three, against 30/30 green locally (#367). That invariance is what convicted
 * the shared helper rather than either test: what the three failures had in
 * common was the code below, not the case that happened to run it. Capturing
 * what the poll saw closes the window by construction: there is no second read
 * left to disagree with the first.
 *
 * Captured, but deliberately not *settled* — no second matching reading, no
 * stability window. The callers compare geometry rather than aiming pointer
 * events at the box — mostly under `EDGE_TOLERANCE_PX`, and where not, across
 * gaps far larger than any jitter: the chart-under-map case below compares raw
 * edges precisely because a whole panel gap separates the two boxes. So "a box
 * existed, and this is it" is the entire precondition being established here.
 * Waiting for a box to stop moving would be scope bought against no measurement
 * flake anyone has seen.
 *
 * The sample lands in a one-property holder rather than a plain `let`, and that
 * is the compiler's requirement rather than a preference. TS never follows an
 * assignment made inside the poll's closure, so a `let` initialised to `null`
 * is still narrowed to `null` at the guard below, which reduces the guard to a
 * comparison the checker can discharge — `no-unnecessary-condition` is right to
 * call that decoration. A property of an object whose type is not a union is
 * not narrowed by its initialiser, so `latest.box` keeps its honest
 * `LayoutBox | null` and the guard stays a check the compiler admits.
 *
 * What that guard reports is an invariant, not a race: it can fire only if
 * `expect.poll` resolved on a `null` sample, which its contract rules out. So
 * it names a violated invariant rather than a failed measurement
 * (`error-handling.md` rule 1).
 *
 * The name is a parameter rather than something reached in from the enclosing
 * test (`structure.md` rule 1), and it is what makes both messages point at the
 * element that actually failed.
 */
const layoutBoxOf = async (source: BoxSource, name: string): Promise<LayoutBox> => {
  const latest: { box: LayoutBox | null } = { box: null };

  await expect
    .poll(
      async () => {
        latest.box = await source.boundingBox();
        return latest.box;
      },
      { message: `${name} never acquired a layout box.` },
    )
    .not.toBeNull();

  if (latest.box === null) {
    throw new Error(`${name}'s layout-box poll resolved without a non-null sample to return.`);
  }

  return latest.box;
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

/**
 * A phone, and the width the never-wrap rule is claimed at.
 *
 * 390x844 is a real device size rather than a number chosen just under a fold,
 * and it is the same one `header.spec.ts` measures the bar's own fold at —
 * shared on purpose, so a platform whose fonts run a few pixels wide shows up in
 * both places at once rather than only in whichever picked the tighter width.
 */
const PHONE_VIEWPORT = { width: 390, height: 844 };

/*
 * The window selectors never wrap (#344, `design.md` rule 7).
 *
 * Its own `describe` because the claim is about a viewport, and `test.use` is
 * how this lane opens a case at one (`chart-surfaces.spec.ts` and
 * `header.spec.ts` both do it that way) — a `setViewportSize` inside the test
 * would measure a page that had already been laid out at the default width and
 * then reflowed, which is a different thing from the page a phone visitor gets.
 *
 * It belongs in this lane rather than beside the component for the reason
 * `testing.md` rule 10 gives: wrapping is layout, and jsdom applies no
 * stylesheet, so a jsdom twin of this case would assert nothing at all. It
 * belongs in *this file* because it is a claim about the assembled header — the
 * heading, the numbers, the (i) and the picker sharing one flex line, at a width
 * where the page is also carrying a real map.
 *
 * Honest scope, because the routing above would otherwise imply more coverage
 * than the case carries (`testing.md` rule 10's closing rule: where the lane owns
 * a criterion no spec in it yet asserts, say so beside the code). What is
 * asserted below is that the *picker group* does not wrap internally, and that
 * is all. The fix #344 shipped has two halves — the summary yielding
 * (`.fleet-panel-stats`' `flex: 1 1 0%` and its truncation set) and the picker
 * refusing to shrink or break (`.range-picker`'s `flex-shrink: 0`,
 * `.range-picker-button`'s `white-space: nowrap`) — and reverting *either* of
 * them leaves this case, and the whole suite in both lanes, green. What actually
 * killed the gate while it was being written was a seeded `flex-direction:
 * column`, which none of those declarations control.
 *
 * The assertion that would close the gap is the one this file does not make: that
 * the picker still shares `.fleet-panel-title`'s line rather than being pushed to
 * a second row. It is deliberately not added here rather than forgotten — it is
 * filed on issue 346 (the P7 gate candidates) because it needs a measured
 * pre/post reading first. The pre-fix measurement taken while planning this batch
 * had the tip and the picker together at 242px inside a 326px row, which is close
 * enough that the picker may legitimately sit on a second line at 390px even with
 * the fix in, and a case asserting otherwise on an assumption would be a gate
 * asserting the wrong thing rather than a gate with a gap.
 */
test.describe('the fleet panel’s header at phone width', () => {
  test.use({ viewport: PHONE_VIEWPORT });

  test('keeps the range picker one button tall at phone width (issue 344, P7)', async ({
    page,
  }) => {
    /*
     * The map first, as every case here does. Nothing about the picker depends
     * on the canvas, but the panel's position on the page does: the map is the
     * tallest thing above it and acquires its height late, so a box read before
     * that settles is a read of a page still about to move.
     */
    await expect(page.locator('.maplibregl-canvas')).toBeVisible();

    const panel = page.locator('.fleet-panel');
    const picker = panel.locator('.range-picker');

    await picker.scrollIntoViewIfNeeded();

    const groupBox = await layoutBoxOf(picker, 'The range picker');
    const buttonBox = await layoutBoxOf(
      picker.locator('.range-picker-button').first(),
      'The first range button',
    );

    /*
     * One button tall is the whole claim: three chips on one line make the group
     * exactly as tall as one of them, and a group that wrapped would come to
     * two or three times this plus its own gaps — far outside any tolerance.
     * Measured against a button rather than against a written-down height, so
     * the case survives a change to the chips' padding or type scale; what it
     * pins is the ratio, not the pixels.
     */
    expect(groupBox.height).toBeLessThanOrEqual(buttonBox.height + EDGE_TOLERANCE_PX);

    /*
     * And it fits, rather than merely staying short. A group kept on one line by
     * running off the side of its card would satisfy the height above with the
     * `7 d` chip unreachable, so the right edges are compared too — the panel is
     * the container the fit is proven from inward (`design.md` rule 7).
     */
    const panelBox = await layoutBoxOf(panel, 'The fleet panel');

    expect(groupBox.x + groupBox.width).toBeLessThanOrEqual(
      panelBox.x + panelBox.width + EDGE_TOLERANCE_PX,
    );
  });
});

/*
 * The lane's own measuring instrument, asserted deterministically.
 *
 * The charter above would exclude this on its face — nothing here assembles the
 * app — and it is here anyway because `layoutBoxOf` is here, and because the
 * unit lane's include boundary deliberately stops at this directory
 * (`apps/web/vite.config.ts` — "Vitest owns `src/` and nothing else"). Any other
 * home for the case would mean moving the helper out of the file whose specs
 * are its only callers.
 *
 * A source that has a box exactly once is #367's race made repeatable: the poll
 * settles on reading one, and the pre-fix helper then re-read, got `null`, and
 * threw. Three CI runs produced that by luck; this produces it by construction,
 * which is what `testing.md` rule 4 asks of a regression test. The `beforeEach`
 * still boots the page for it — the cost of living in this file, and it buys
 * this case nothing.
 */
test('layoutBoxOf returns the box its poll observed rather than re-reading it', async () => {
  const settled: LayoutBox = { x: 0, y: 0, width: 640, height: 480 };
  let readings = 0;
  const flickering: BoxSource = {
    /* Not `async`: there is nothing to await, and `require-await` is right to say so. */
    boundingBox: () => {
      readings += 1;
      return Promise.resolve(readings === 1 ? settled : null);
    },
  };

  expect(await layoutBoxOf(flickering, 'The flickering element')).toEqual(settled);
});
