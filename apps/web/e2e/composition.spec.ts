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
 * Kept to three cases on purpose. This lane is slow (a cold production build
 * per run) and it is not where behaviour gets tested; `src/**` owns that.
 * A case earns its place here only if assembling the app is what makes it true.
 */

/** 12 cluster locations x 5 sites — `generateFleet` in packages/shared/src/fleet.ts. */
const DEMO_FLEET_SIZE = 60;

/** The map strip and the aside footer each owe one. More surfaces may owe more. */
const MINIMUM_WEATHER_CREDITS = 2;

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
