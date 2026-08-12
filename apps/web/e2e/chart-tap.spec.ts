import type { Locator, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { routeBasemap } from './hermetic-basemap';
import type { LayoutBox } from './layout-box';
import { settledBoxOf } from './layout-box';
import { PHONE_VIEWPORT } from './viewports';

/*
 * The tap contract (#421) under a real finger, which is the half jsdom cannot be
 * asked about.
 *
 * `src/charts/forecast-chart-tap.test.tsx` owns everything about a tap that is
 * arithmetic — which sample a press selects, that an x outside the plot clamps to
 * the range it is nearest, that a lifted finger keeps what it revealed — and it
 * owns it by dispatching events at an element it names. Two things are therefore
 * unproven until a browser runs it (`testing.md` rule 10). The first is
 * hit-testing: whether the outermost `<svg>` really receives a press over an
 * *unpainted* axis gutter, which is the whole premise of moving the handlers up
 * off the plot rect, and which jsdom answers by never asking. The second is the
 * conversion from a screen coordinate to a view-box one, which needs a plot with
 * a real rendered width.
 *
 * **Everything here is geometry on purpose, and that is the lesson of the #404
 * attempt.** Tooltip-presence and readout-text assertions written for this
 * contract passed with `onPointerDown` *deleted*: a finger landing on a
 * `tabIndex={0}` element focuses it, `readAtFocus` opens the readout at sample 0
 * when nothing is selected, and so something appears either way. Presence is
 * satisfied by the wrong route. Where the reading *is* — at the finger, or back
 * at the start of the range — is the only surface that can tell the two apart, so
 * that is what the cases below measure.
 *
 * Drag-scrub is deliberately not here, and the reason is what the scrub is about
 * rather than what the lane can reach. Playwright's touchscreen API offers a tap
 * and nothing else — there is no touch drag primitive to hold a finger down and
 * move it with — but a scrub *is* expressible one level below it, through the CDP
 * touch sequence `Locator.tap` itself dispatches through, and
 * `keyboard-focus.spec.ts` drives exactly that where the gesture's effect is a
 * browser question (what Chromium does with a cancelled tap, and what it then
 * paints). What this file adds over jsdom is hit-testing and rendered geometry,
 * and the scrub is about neither, so `ForecastChart touch scrub` in
 * `src/charts/forecast-chart-tap.test.tsx` stays where that behaviour is proven.
 */

/**
 * A phone, with a touchscreen — both halves load-bearing.
 *
 * `hasTouch` is what makes `page.touchscreen.tap` dispatch a `pointerdown`
 * carrying `pointerType: 'touch'`, which is the pointer type the boundary tells
 * apart from a mouse; without it the lane would be re-asserting the hover path
 * these cases exist to be different from. The width is the lane's phone size
 * (`viewports.ts`) because a tap contract is a phone contract.
 */
test.use({ viewport: PHONE_VIEWPORT, hasTouch: true });

const CHART_SECTION = '.fleet-chart-section';
const CHART_FIGURE = `${CHART_SECTION} .forecast-chart-figure`;

/** The canvas: since #421 the element that hears the pointer, gutters included. */
const PLOT_SVG = 'svg.forecast-chart';

/**
 * The *drawn* plot inside that canvas, which is what a share of "the plot's
 * width" is a share of.
 *
 * The same element `chart-surfaces.spec.ts` measures, and named here for the same
 * reason: it is sized from `scale.plot`, so its box is where the marks may go.
 * What it is no longer is the listener — the difference between this rect and the
 * canvas around it is exactly the gutter the second case taps.
 */
const PLOT_RECT = '.forecast-chart-pointer-target';

const CROSSHAIR = '.forecast-chart-crosshair';
const TOOLTIP = '.forecast-chart-tooltip';

/** The section's `h2` — non-focusable, and outside the figure. */
const CHART_TITLE = `${CHART_SECTION} .fleet-chart-title`;

/**
 * Where in the plot the first case puts its finger, as a share of the plot's
 * width.
 *
 * Well inside the plot, so the case is about reading at the finger rather than
 * about the clamp the second case owns, and far enough from the left edge that
 * the reading it forbids — the start of the range — is unmistakably elsewhere.
 */
const TAP_SHARE = 0.6;

/**
 * How far the crosshair may sit from the finger before it is not reading there.
 *
 * The reading snaps to a sample, so the honest budget is half a sample step plus
 * the sub-pixel arithmetic of a client-to-view-box conversion. A step is the
 * plot's width over the samples standing on it, so what 30 has to clear is half
 * of the *widest* step this chart can draw — the sparsest window's, and the
 * sparsest window is the default one: `range-picker.tsx`'s `RANGE_OPTIONS` offers
 * 24 h, 48 h and 7 d over one hourly series, so `FleetPanel.tsx`'s `DEFAULT_RANGE`
 * is the arm that puts the fewest samples up. That step is `~284 / 24` view-box
 * units — the plot `PHONE_VIEWPORT` leaves once `chart-geometry.ts` has taken
 * `PLOT_LEFT_NARROW` and `PLOT_RIGHT_MARGIN` off the column, over the default
 * range's samples — and half of it is what has to fit inside 30, which it does
 * several times over. Written as the division rather than as its answer because
 * both operands move with code elsewhere (`architecture.md` rule 12). 30 is also
 * an order below the failure it has to catch, which is a reading pinned at the
 * start of the range ~170px away.
 */
const TAP_ACCURACY = 30;

/**
 * How far from the plot's left edge the first case's reading must be, and the
 * assertion that actually kills the mutant.
 *
 * `TAP_ACCURACY` above is a claim about accuracy; this is a claim about *route*.
 * A tap that never reaches `onPointerDown` still opens a readout — the press
 * focuses the canvas and the focus route opens at sample 0, on the plot's left
 * edge — so a case that only checked closeness could in principle be satisfied by
 * a plot narrow enough for the two to coincide. 100px is comfortably beyond
 * anything sample 0 can be from a finger at `TAP_SHARE`, and comfortably under the
 * ~170px that share actually leaves at a phone width.
 */
const CLEAR_OF_SAMPLE_ZERO = 100;

/**
 * Sub-pixel slack on the two edge comparisons in the clamp case.
 *
 * A client x becomes a view-box x by dividing by a width the chart measured
 * through a `Math.round` (`use-chart-width.ts`), and the box being compared
 * against comes back from `boundingBox` as a fractional rectangle. Both readings
 * are therefore right to within arithmetic rather than exactly, and 2px is that
 * order — orders below the failure either comparison exists to catch, which is a
 * panel or a crosshair out in the axis gutter by tens of pixels.
 */
const EDGE_TOLERANCE = 2;

/**
 * Where the crosshair is standing, in page pixels.
 *
 * Its `x1` is a view-box coordinate and the chart is drawn 1:1 since #284 D15, so
 * the canvas's own left edge plus that number is where the line is on screen —
 * which is the space a tap coordinate is in, and the whole reason no view-box
 * arithmetic is restated here. `Number.NaN` where no crosshair is drawn: every
 * comparison below is an inequality and a `NaN` fails all of them, so a missing
 * crosshair surfaces as a failing assertion rather than as a passing zero.
 */
const crosshairPageX = async (figure: Locator, svgLeft: number): Promise<number> => {
  const viewBoxX = await figure.evaluate((element, selector) => {
    const x1 = element.querySelector(selector)?.getAttribute('x1');

    return x1 === null || x1 === undefined ? Number.NaN : Number(x1);
  }, CROSSHAIR);

  return svgLeft + viewBoxX;
};

/**
 * The panel's left edge in view-box units, out of the tooltip group's
 * `transform`; `Number.NaN` where no tooltip is drawn.
 *
 * A lane-local twin of the reader at `chart-surfaces.spec.ts` ~line 844, which is
 * itself a twin of `src/charts/forecast-chart-test-fixture.tsx`'s
 * (`structure.md` rule 7). The three run in three runtimes with no module in
 * common; what they share is one attribute's shape, which each fails loudly on
 * rather than silently.
 */
const tooltipAnchor = async (figure: Locator): Promise<number> =>
  figure.evaluate((element, selector) => {
    const transform = element.querySelector(selector)?.getAttribute('transform');
    const anchor = /translate\((?<x>[-\d.]+)/u.exec(transform ?? '')?.groups?.x;

    return anchor === undefined ? Number.NaN : Number(anchor);
  }, TOOLTIP);

/** Whether the canvas is what the document would send a key to. */
const chartHasFocus = async (page: Page): Promise<boolean> =>
  page.evaluate(
    (selector) => document.activeElement === document.querySelector(selector),
    `${CHART_FIGURE} ${PLOT_SVG}`,
  );

/** The chart, on screen and holding still, with the two boxes a tap is aimed by. */
interface TappableChart {
  readonly figure: Locator;
  /** The canvas's box — the origin every crosshair reading above is measured from. */
  readonly svgBox: LayoutBox;
  /** The drawn plot's box, which is where a share of the plot's width lands. */
  readonly plotBox: LayoutBox;
}

/**
 * Both boxes settled before a single coordinate is computed.
 *
 * The map above is what pushes the chart down the page after first paint, so it
 * is waited on first, and both reads are `settledBoxOf` rather than
 * `layoutBoxOf`: a tap is an *event*, and a coordinate computed from a box read
 * mid-reflow puts the finger where the chart no longer is — a failure that looks
 * exactly like a tap the chart ignored (`layout-box.ts`).
 */
const openChart = async (page: Page): Promise<TappableChart> => {
  const figure = page.locator(CHART_FIGURE);
  const canvas = figure.locator(PLOT_SVG);

  await expect(page.locator('.maplibregl-canvas')).toBeVisible();
  await expect(canvas).toBeVisible();
  await canvas.scrollIntoViewIfNeeded();

  const svgBox = await settledBoxOf(canvas, 'The chart canvas');
  const plotBox = await settledBoxOf(figure.locator(PLOT_RECT), 'The drawn plot');

  return { figure, svgBox, plotBox };
};

/** The middle of the plot's height: selection is by x alone, so any y in it does. */
const midHeight = (plotBox: LayoutBox): number => plotBox.y + plotBox.height / 2;

test.beforeEach(async ({ page }) => {
  await routeBasemap(page);
  await page.goto('/');
});

test('reads at the tapped x rather than at the start of the range', async ({ page }) => {
  const { figure, svgBox, plotBox } = await openChart(page);
  const tapX = plotBox.x + plotBox.width * TAP_SHARE;

  await page.touchscreen.tap(tapX, midHeight(plotBox));

  await expect(figure.locator(CROSSHAIR)).toHaveCount(1);

  const readingX = await crosshairPageX(figure, svgBox.x);

  // Where the reading is, twice over. The first is the contract — the reader put
  // a finger on an hour and that hour is what the chart answered. The second is
  // what makes the first mean something: it forbids the one wrong answer that
  // looks right from a distance, the readout the focus route opens at sample 0.
  expect(Math.abs(readingX - tapX)).toBeLessThanOrEqual(TAP_ACCURACY);
  expect(readingX - plotBox.x).toBeGreaterThanOrEqual(CLEAR_OF_SAMPLE_ZERO);
});

test('clamps a tap in the y-axis gutter to the start of the range', async ({ page }) => {
  const { figure, svgBox, plotBox } = await openChart(page);
  // The gutter's width is the plot's left edge in view-box units, derived rather
  // than restated: `chart-geometry.ts` owns that length and varies it by chart
  // width (`architecture.md` rule 9).
  const gutter = plotBox.x - svgBox.x;

  await page.touchscreen.tap(svgBox.x + gutter / 2, midHeight(plotBox));

  /*
   * That a crosshair exists at all is this case's first claim and the one the
   * plan came here to settle: the finger landed on unpainted canvas, left of
   * every drawn element, and the figure answered. That is the whole assumption
   * behind moving the handlers off the plot rect and onto the `<svg>` — a
   * hit-testing fact no jsdom suite can be asked about, because jsdom dispatches
   * at whatever element a test names.
   */
  await expect(figure.locator(CROSSHAIR)).toHaveCount(1);

  const readingX = await crosshairPageX(figure, svgBox.x);

  expect(Math.abs(readingX - plotBox.x)).toBeLessThanOrEqual(EDGE_TOLERANCE);
  /*
   * And the clamp's own observable, which the snap alone would not give: the
   * panel follows the *continuous* position, so an unclamped gutter x anchors it
   * out over the axis, reading a sample it is not beside.
   *
   * Worth stating plainly, because it bounds what this case proves: neither
   * assertion here distinguishes the clamp from the focus route, which also
   * opens at sample 0 on the plot's left edge. Both routes run through the
   * `<svg>`, which is why the case settles hit-testing; the case above is the
   * one that settles which of them read the finger.
   */
  expect(await tooltipAnchor(figure)).toBeGreaterThanOrEqual(gutter - EDGE_TOLERANCE);
});

test('dismisses when the next tap lands outside the figure', async ({ page }) => {
  const { figure, plotBox } = await openChart(page);

  await page.touchscreen.tap(plotBox.x + plotBox.width * TAP_SHARE, midHeight(plotBox));

  await expect(figure.locator(TOOLTIP)).toHaveCount(1);
  /*
   * The premise of the dismissal, asserted rather than assumed: a tap on a
   * `tabIndex={0}` element focuses it, and it is that focus the tap below has to
   * take away. Without this line the last assertion in the file would pass
   * vacuously on a browser that never focused the canvas in the first place.
   */
  expect(await chartHasFocus(page)).toBe(true);

  // The section's heading: inside the page, outside the figure, and focusable by
  // nothing — so the only thing this tap can do to the chart is blur it. #421
  // gives a tap no leave event to dismiss it, because a finger lifting is the end
  // of the tap rather than a reader moving on; dismissal is the blur path the
  // keyboard reader already had, and this is a reader using it.
  await page.locator(CHART_TITLE).tap();

  await expect(figure.locator(TOOLTIP)).toHaveCount(0);
  expect(await chartHasFocus(page)).toBe(false);
});
