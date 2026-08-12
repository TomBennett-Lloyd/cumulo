import { expect, test } from '@playwright/test';

import { routeBasemap } from './hermetic-basemap';
import { layoutBoxOf, maybeBoxOf } from './layout-box';
import { PRESSED_RANGE_BUTTON, RANGE_TRIGGER } from './range-picker';
import { PHONE_VIEWPORT } from './viewports';

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
 * documented exception, which is `layout-box.spec.ts` rather than anything in
 * this file: it asserts the lane's own measuring instruments, assembles nothing,
 * and says why it lives in this directory anyway (#404).
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
 * The size `generateFleet` (packages/shared/src/fleet.ts) produces for the demo
 * fleet, from its own location count and sites-per-location. The number is here
 * because this spec measures against it; the arithmetic that yields it is the
 * generator's and is not restated (`architecture.md` rule 9).
 */
const DEMO_FLEET_SIZE = 60;

/**
 * How much map has to show to the left of the credits strip before the strip
 * counts as having shrunk to its corner (#428).
 *
 * A floor rather than a width, and chosen to be uninformative about the row: it
 * has to be far enough past `EDGE_TOLERANCE_PX` that no rounding argument
 * reaches it, and far enough below the real gap that a re-measured row cannot
 * drift into it. At this lane's default viewport the shrink exposes something
 * like 684px of map beside the strip, so a hundred leaves most of an order of
 * magnitude either way. It computes with nothing `map.css` owns and therefore
 * joins no restatement ledger — which is the point of not writing the row's
 * actual width here.
 */
const SHRUNK_STRIP_CLEARANCE_PX = 100;

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
   * "Laid out" in this case's name is granted by the line above rather than by
   * any measurement under it. A canvas collapsed to nothing — a map that never
   * got its GL context or its container size — is already excluded by that
   * `toBeVisible`, on this same element: Playwright grants visibility only to a
   * non-empty box. So the `width > 0` and `height > 0` pair that used to sit here
   * restated the gate that let it run, and the bare box read that briefly stood
   * in for them asserted less still — a read whose value nothing looked at (#404).
   *
   * Nor is that visibility check standing in for the placeholder-swap poll #274
   * bought. That window belongs to `.map-canvas`, worn by both the pending shell
   * and the live map, and the reads later in this file are where it is waited
   * out. `.maplibregl-canvas` exists only on the far side of the swap, so its
   * being visible is the swap having happened.
   */

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
   * and this count is what proves the empty value actually reached
   * `selectFleetDataSource` through the bundle. An HTTP source pointed at
   * nothing fails the listing, and the stats line then reads `0 sites` — so the
   * number still says which source the bundle resolved, and says it in the one
   * place on the page that states the fleet's size in words.
   *
   * Read off the stats line since #451 took the fleet's table away, which is
   * where this was counted before: sixty rows in the document were a count
   * without a gesture, and the line the panel already renders is the same count
   * from the same listing. The regex shape is this file's own, matched by the
   * stats case further down — anchored at both ends so a line that merely
   * *contained* the number could not satisfy it.
   */
  await expect(page.locator('.fleet-chart-stats')).toHaveText(
    new RegExp(String.raw`^${String(DEMO_FLEET_SIZE)} sites · [\d.]+ kW$`, 'u'),
  );
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

test('keeps the footer’s Open-Meteo credit followable where the page ends', async ({ page }) => {
  /*
   * The other half of the licence obligation, held to the same bar as the map
   * band's. CC BY 4.0 asks for a credit that can be *followed*, and the count
   * above cannot tell a link from a link with something painted over it — nor
   * can the `toBeVisible` on the prefix span that the compact-form case below
   * makes, which is a claim about a `<span>` beside the link rather than about
   * the link. `toBeEnabled` would be vacuous here too: an anchor has no disabled
   * state to report. The trial click is the assertion with the hit test in it —
   * Playwright's full actionability sequence, including `elementFromPoint` at
   * the link's centre resolving to the link, stopping short of navigating. The
   * band's credit has had that hit test since #265; the footer's has not, and
   * `pointer-events: none` or a neighbour overlapping this row would read as
   * compliant from every other assertion in this file.
   *
   * Scrolled to first, and that is the page's shape rather than a defect: the
   * map band takes the top of the viewport and the reading runs under it, so the
   * footer is below the fold at this lane's viewport. `scrollIntoViewIfNeeded`
   * is how this file reaches something down the page already (the range picker
   * at phone width). The trial click would scroll on its own; doing it
   * explicitly keeps a failure to *reach* the footer separate from a failure to
   * hit the link once it is on screen.
   */
  const credit = page.locator('.dashboard-footer').getByRole('link', { name: 'Open-Meteo.com' });

  await credit.scrollIntoViewIfNeeded();

  await expect(credit).toBeVisible();
  await credit.click({ trial: true });
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
   * And in the corner rather than across the whole edge (#428). The strip
   * shrink-fits its content now, so two things are true at once and neither
   * implies the other: its right edge *meets* the map's, which is what pins it
   * to the corner, and its left edge is a long way in from the map's, which is
   * what says it stopped being a full-width band.
   *
   * The right edge is an equality rather than the containment above it — that
   * one passes on a strip anywhere inside the map — and it is what a lost
   * `right: 0` would break.
   *
   * The left edge is deliberately a floor, not a measurement of the strip's
   * width. `map.css` owns the width the row comes to and the breakpoint derived
   * from it; restating either here would put this file in that ledger for a
   * claim it does not need (`architecture.md` rule 9). What it needs is that the
   * strip is not full width at a width where it has no reason to be, and this
   * lane's viewport is far wider than the row: a hundred pixels is clear of any
   * sub-pixel argument and nowhere near the ~684px of map the shrink actually
   * exposes here, so a re-measured row moves the real gap without touching this.
   */
  expect(Math.abs(stripBox.x + stripBox.width - (mapBox.x + mapBox.width))).toBeLessThanOrEqual(
    EDGE_TOLERANCE_PX,
  );
  expect(stripBox.x).toBeGreaterThan(mapBox.x + SHRUNK_STRIP_CLEARANCE_PX);

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
    .poll(async () => (await maybeBoxOf(attribution))?.height ?? Number.POSITIVE_INFINITY, {
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
   * itself, so that row is composed of this phrase and nothing else and holds its
   * full form here — never meeting the condition CLAUDE.md attaches to the
   * compact form. Which rows meet that condition is
   * `docs/design/map-treatment.md`'s Attribution section's to say: it measures
   * the row **as composed**, and a row composed of one credit's full form and
   * nothing else can always hold it (#356, #415). That is why the media query
   * lives in `map.css` rather than beside the component in `@cumulo/ui`, and a
   * rule that leaked to every surface would fail right here.
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
   * different, non-overlapping parts of the flow, separated by the chart
   * section's top padding, the whole of its controls row and the step under it
   * (#449), so there is nothing here for sub-pixel rounding to decide. The `--space-4` gap that used to sit
   * between them is gone with #323 — the map band and this section are one
   * continuous surface now — and the claim is unaffected, because what it forbids
   * is the chart being *beside* the map rather than a particular distance under
   * it. A tolerance would only be admitting an overlap.
   *
   * Which means this case says nothing about how far under the map the chart
   * sits, and a reintroduced gutter would pass it untouched. That distance is
   * #323's own claim and it is the next case's, not this one's.
   */
  const chart = page.locator('.fleet-chart-section .forecast-chart-figure');

  await expect(chart).toBeVisible();

  const mapBox = await layoutBoxOf(page.locator('.map-canvas'), 'The map canvas');
  const chartBox = await layoutBoxOf(chart, 'The fleet chart figure');

  expect(chartBox.y).toBeGreaterThanOrEqual(mapBox.y + mapBox.height);
});

test('meets the map band with the chart band, no page showing between them', async ({ page }) => {
  /*
   * #323's whole point, as a measurement: the map and the fleet's chart are one
   * reading unit — the same fleet in space, then in time — so they touch, and a
   * band of page between them would say they were unrelated (`design.md` rule 4,
   * and `.dashboard`'s own rule in dashboard.css). Nothing else asserts it. The
   * case above forbids a side-by-side arrangement and permits any distance; the
   * jsdom lane applies no stylesheet, so it cannot see a `gap` at all
   * (`testing.md` rule 10).
   *
   * The two boxes are the flex children the gutter would open between: the map's
   * own painted bottom edge and the chart section's top. `.fleet-chart-section`
   * rather than the figure inside it, because the section's top padding stands
   * between the figure and the seam and would absorb exactly what is being
   * measured. `.map-canvas` rather than `.dashboard-map`, which is this file's
   * idiom and is also the stronger reading of the claim — the canvas fills the
   * band (map.css), so a band grown taller than the map it holds would show page
   * under the tiles and fail here, which is the same defect by another route.
   *
   * `EDGE_TOLERANCE_PX` for the reason that constant documents — two
   * `getBoundingClientRect` reads of a laid-out page — and it cannot hide the
   * regression this guards. No step on the spacing scale is as small as this
   * tolerance (`tokens.css` owns those values), so no gutter written in tokens
   * fits inside it; the one #323 removed was a `--space-4`.
   *
   * One viewport, honestly: there is no breakpoint in this layout — the same
   * flow at every width, which is the claim `.dashboard` is written to make — so
   * a second width would re-measure the same declaration rather than a second
   * arrangement. A gutter reintroduced inside a media query is the case this
   * does not cover.
   */
  const section = page.locator('.fleet-chart-section');

  await expect(section).toBeVisible();

  const mapBox = await layoutBoxOf(page.locator('.map-canvas'), 'The map canvas');
  const sectionBox = await layoutBoxOf(section, 'The fleet chart section');

  expect(Math.abs(sectionBox.y - (mapBox.y + mapBox.height))).toBeLessThanOrEqual(
    EDGE_TOLERANCE_PX,
  );
});

/*
 * The window selectors never wrap, and are reachable where they now live (#344,
 * `design.md` rule 7).
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
 * belongs in *this file* because it is a claim about the assembled controls row,
 * at a width where the page is also carrying a real map. #344 wrote that row as
 * four items; #323 left two; the owner's 2026-08-11 reversal put the heading and
 * the fleet's numbers back, and the same day's fold turned the picker into a
 * calendar trigger — which is what made all four fit here. `fleet-panel.css`
 * hides the stats line below a container width it measures and owns, and this
 * case opens at 390px of window, which is 358px of row, so the numbers are on
 * screen at this viewport. They were not before the fold: the old threshold was
 * wider, and the same three items shared this line with the numbers hidden.
 *
 * That last clause used to be prose alone and is now a case — the second one in
 * this describe — with the hiding half in the describe below it. Both arms were
 * unasserted in either lane until then, so the rule the owner asked for (the
 * numbers wherever there is room, and only then) rested on a stylesheet nothing
 * would have noticed the deletion of.
 *
 * What the fold changes about the *claim* is where the three chips are. They are
 * in a popover now, out of the flow of the row entirely, so "the picker does not
 * wrap the row" and "the chips do not wrap each other" have come apart into two
 * measurements — and a third arrives with them, because a control folded behind
 * a trigger is only as good as what opening it puts on screen.
 *
 * Honest scope, because the routing above would otherwise imply more coverage
 * than the case carries (`testing.md` rule 10's closing rule: where the lane owns
 * a criterion no spec in it yet asserts, say so beside the code). What is
 * asserted below is the trigger's own box, the chips' one line, and the sheet
 * fitting the viewport. Of the two declarations #344 shipped, only
 * `.range-picker-button`'s `white-space: nowrap` is still load-bearing for the
 * chips' line — `.range-picker`'s `flex-shrink: 0` now protects a 24px trigger,
 * and reverting either leaves this case, and the whole suite in both lanes,
 * green. What actually killed the gate while it was first written was a seeded
 * `flex-direction: column`, which neither declaration controls.
 *
 * The assertion that would close the gap is the one this file still does not
 * make: that the row's four items share one line rather than one being pushed to
 * a second row. It is deliberately not added here rather than forgotten — it is
 * filed on issue 346 (the P7 gate candidates) because it needs a measured
 * pre/post reading first, and the row it would be measured in has now changed
 * three times: the pre-fix reading taken while planning that batch had the tip
 * and the picker together at 242px inside a 326px row, #323 left a two-item row,
 * the reversal made it four, and the fold took ~144px out of it. So the old
 * reading says nothing about it, and the new one has not been taken. A case
 * asserting one on an assumption would be a gate asserting the wrong thing
 * rather than a gate with a gap.
 */
test.describe('the fleet chart’s controls row at phone width', () => {
  test.use({ viewport: PHONE_VIEWPORT });

  test('folds the window picker into a trigger whose windows all fit when opened (issue 344, P7)', async ({
    page,
  }) => {
    /*
     * The map first, as every case here does. Nothing about the picker depends
     * on the canvas, but the section's position on the page does: the map is the
     * tallest thing above it and acquires its height late, so a box read before
     * that settles is a read of a page still about to move.
     */
    await expect(page.locator('.maplibregl-canvas')).toBeVisible();

    const section = page.locator('.fleet-chart-section');
    const trigger = section.locator(RANGE_TRIGGER);

    await trigger.scrollIntoViewIfNeeded();

    const triggerBox = await layoutBoxOf(trigger, 'The range picker’s trigger');
    const sectionBox = await layoutBoxOf(section, 'The fleet chart section');

    /*
     * The trigger is square and inside the band. Square rather than a
     * written-down size, so the case survives a change to the icon's step of the
     * spacing scale; what it pins is that the control is an icon box rather than
     * a label that grew back. The right edges are compared for the reason the
     * chips' were — the chart section is the container the fit is proven from
     * inward (`design.md` rule 7) — and it is the full width of the page since
     * #323, which makes the claim weaker than it was against a card and still
     * the right one: the container a control must fit is whichever one it is in.
     */
    expect(Math.abs(triggerBox.width - triggerBox.height)).toBeLessThanOrEqual(EDGE_TOLERANCE_PX);
    expect(triggerBox.x + triggerBox.width).toBeLessThanOrEqual(
      sectionBox.x + sectionBox.width + EDGE_TOLERANCE_PX,
    );

    await trigger.click();

    const popover = page.locator('.range-picker-popover');

    await expect(popover).toBeVisible();

    const chips = popover.locator('.range-picker-button');

    await expect(chips).toHaveCount(3);

    /*
     * #344's claim, moved to where the chips moved. "One button tall" was the
     * pre-fold spelling of "the three share a line"; against a sheet with its own
     * padding, comparing tops says the same thing without this file having to
     * restate what `--space-2` resolves to (`architecture.md` rule 9). A sheet
     * that wrapped puts a chip a whole chip-height below the first, far outside
     * any tolerance.
     *
     * And the fold has to be worth taking, which is the claim the pre-fold case
     * could not make: a control behind a trigger is only as good as what opening
     * it puts on screen. So each chip is also required inside the viewport on
     * both horizontal edges — the sheet hangs from the row's right-hand end and
     * grows leftwards, so the failure to catch is one running off either side
     * rather than only off the right, which is why this one is measured against
     * the viewport where the trigger above was measured against the band.
     */
    const viewportWidth = page.viewportSize()?.width ?? 0;

    expect(viewportWidth).toBeGreaterThan(0);

    const firstChipBox = await layoutBoxOf(chips.first(), 'The first range button');

    for (let index = 0; index < 3; index += 1) {
      const box = await layoutBoxOf(chips.nth(index), `Range chip ${String(index)}`);

      expect(Math.abs(box.y - firstChipBox.y)).toBeLessThanOrEqual(EDGE_TOLERANCE_PX);
      expect(box.x).toBeGreaterThanOrEqual(-EDGE_TOLERANCE_PX);
      expect(box.x + box.width).toBeLessThanOrEqual(viewportWidth + EDGE_TOLERANCE_PX);
    }

    /*
     * And which window is current is readable once the sheet is up — precisely
     * what the fold took off the row, so opening the picker has to give it back.
     */
    await expect(popover.locator(PRESSED_RANGE_BUTTON)).toBeVisible();
  });

  test('shows the fleet’s own numbers, because this width has room for them', async ({ page }) => {
    /*
     * The visible arm of the stats line's rule, and the assertion this describe's
     * docblock has been claiming in prose without making: at 390px of window the
     * row has room for all four items, so the numbers are on screen.
     *
     * Rendered visibility rather than the stylesheet, which is the whole point of
     * the case being in this lane: a test that read the `@container` rule back
     * would pass against a rule that had stopped matching anything. jsdom cannot
     * host it either — it applies no stylesheet and lays nothing out, so a jsdom
     * twin would assert nothing whatever it claimed (`testing.md` rule 10, which
     * `FleetPanel.structure.test.tsx` says out loud at its own stats case).
     *
     * The text's *shape* is asserted beside its visibility, and the pair is what
     * makes it a case about the numbers rather than about an element: a line that
     * survived as an empty box would satisfy `toBeVisible` on its own. The count
     * is tied to `DEMO_FLEET_SIZE` rather than to a spelled number, so this reads
     * the fleet the built app actually assembled; the capacity is matched by
     * shape, because what it sums is the generator's business and not this file's.
     */
    await expect(page.locator('.maplibregl-canvas')).toBeVisible();

    const stats = page.locator('.fleet-chart-stats');

    await expect(stats).toBeVisible();
    await expect(stats).toHaveText(
      new RegExp(String.raw`^${String(DEMO_FLEET_SIZE)} sites · [\d.]+ kW$`, 'u'),
    );
  });
});

/*
 * The other arm of the same rule: below the width the row can hold four items,
 * the numbers go — whole, rather than shrinking to an ellipsis.
 *
 * **Both arms or neither.** Each is satisfiable by a bug the other catches: a
 * stats line deleted outright passes the hiding case, and one that never hides
 * passes the showing case above. They are two describes rather than two cases in
 * one because the claim is about a viewport and `test.use` is how this lane opens
 * a case at one — the reason the sibling describe above states at greater length.
 *
 * **Why a third viewport, and not `SMALL_PHONE_VIEWPORT`.** The threshold is
 * `fleet-panel.css`'s and is deliberately not restated here (`architecture.md`
 * rule 9), but where the two named phone widths fall relative to it is a fact
 * about *this case's* choice of viewport and has to be recorded somewhere: both
 * of them are on the *showing* side. Measured against the built app, the numbers
 * are still on screen at 390px and at 360px — the latter clearing the fold by
 * about two pixels of row — and go at 358px and below. So neither constant can
 * open this arm, and reaching for the nearer one would have produced a case that
 * passed for two pixels' worth of reason and turned red on any platform whose
 * fonts ran a hair wide.
 *
 * 320px is chosen for being a real device width rather than for its distance
 * from the fold — it is the narrowest viewport in common use, and the same kind
 * of choice `viewports.ts` makes for its own two. That it clears the fold with
 * room to spare is what makes the case stable, and it is a consequence of the
 * choice rather than the reason for it. Declared here rather than added to
 * `viewports.ts`, which says in its own header that it is not a registry of
 * every size the lane uses and that specs still declare their own.
 */
const NARROW_PHONE_VIEWPORT = { width: 320, height: 568 } as const;

test.describe('the fleet chart’s controls row below that width', () => {
  test.use({ viewport: NARROW_PHONE_VIEWPORT });

  test('drops the fleet’s numbers whole rather than crushing the row', async ({ page }) => {
    await expect(page.locator('.maplibregl-canvas')).toBeVisible();

    /*
     * Hidden, and hidden by *layout* rather than by being unrendered: the element
     * is still in the document — `FleetPanel` renders it in every state — and what
     * the container query takes away is its box. `toBeHidden` is the right
     * instrument for exactly that, where `toHaveCount(0)` would pass on a panel
     * that had stopped rendering the line at all, which is a different product.
     */
    const stats = page.locator('.fleet-chart-stats');

    await expect(stats).toHaveCount(1);
    await expect(stats).toBeHidden();

    /*
     * And the point of the hiding, which is the half that says why the rule
     * exists: the row stays one line. The numbers are the item with wrap
     * priority against them (`design.md` rule 7 — controls outrank auxiliary
     * text), so a rule that stopped firing here would not merely show a long
     * line, it would push the picker onto a second row. Measured as the row
     * being no taller than the tallest control in it, which is the trigger.
     */
    const rowBox = await layoutBoxOf(
      page.locator('.fleet-chart-controls'),
      'The fleet chart’s controls row',
    );
    const triggerBox = await layoutBoxOf(
      page.locator('.fleet-chart-section').locator(RANGE_TRIGGER),
      'The range picker’s trigger',
    );

    expect(rowBox.height).toBeLessThanOrEqual(triggerBox.height + EDGE_TOLERANCE_PX);
  });
});
