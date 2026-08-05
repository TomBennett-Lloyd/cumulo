import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

/*
 * Getting one site marker on screen, without pinning how many zooms that takes.
 *
 * The lane boots the demo fleet at `INITIAL_ZOOM` (src/map/framing.ts), and at
 * that camera the seeded sites read as a handful of knots: what is drawn is
 * `.map-cluster-marker` bubbles, not `.map-site-marker` buttons. Any assertion
 * about a *site* marker therefore has to zoom in first, and how far in is a
 * function of the seed data's spacing and the window size — two things a spec
 * should not be restating. So this drives the app's own affordance instead: a
 * cluster is a button that `easeTo`s to its expansion zoom, and clicking it
 * repeatedly is exactly what a reader does to reach a site.
 *
 * Nothing here waits on a duration. Reclustering happens on maplibre's `moveend`
 * (see `FleetMarkers` in src/map/SiteMarkers.tsx), so the overlay being replaced
 * is itself the signal that the camera has arrived — a `waitForTimeout` would be
 * a guess at that, and the kind of guess a no-retries lane pays for in flakes.
 */

/**
 * How many expansions to allow before calling it a failure.
 *
 * A ceiling rather than a target: one or two is what the seed fleet needs, and
 * anything approaching six means the clusters have stopped separating — a defect
 * worth a loud error, not a loop that spins until Playwright's timeout kills it
 * with no explanation.
 */
const MAX_CLUSTER_EXPANSIONS = 6;

const SITE_MARKER = '.map-site-marker';
const CLUSTER_MARKER = '.map-cluster-marker';

/**
 * What the overlay is currently showing, as one string: every marker's
 * accessible name, in DOM order.
 *
 * Site names and "Cluster of N sites" both land here, which is the point — the
 * value changes whenever the drawn set changes, whichever direction it changed
 * in, so it can be waited on without knowing what the next camera will produce.
 */
const overlayNames = async (page: Page): Promise<string> =>
  page
    .locator(`${SITE_MARKER}, ${CLUSTER_MARKER}`)
    .evaluateAll((markers) => markers.map((marker) => marker.getAttribute('aria-label')).join('|'));

/**
 * Which cluster a pointer can actually reach — its index, or -1 if none can.
 *
 * Bubbles overlap. Two knots a few pixels apart draw two circles that intersect,
 * and the one mounted later wins the pixels they share; Playwright refuses to
 * click through that, correctly, because a reader could not either. Since any
 * cluster serves — every one of them zooms in — the fix is to pick one whose
 * middle belongs to itself rather than to insist on the first in DOM order.
 *
 * `contains` rather than identity: the point lands on whatever is topmost there,
 * which for a cluster is the button, and for a site marker could be the tooltip
 * span inside it.
 */
const reachableClusterIndex = async (page: Page): Promise<number> =>
  page.locator(CLUSTER_MARKER).evaluateAll((clusters) =>
    clusters.findIndex((cluster) => {
      const box = cluster.getBoundingClientRect();
      const topmost = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);

      return topmost !== null && cluster.contains(topmost);
    }),
  );

/**
 * Zoom in until one site is drawn on its own, and hand back its locator.
 *
 * Call it after the page has loaded; it waits for the overlay itself. Throws
 * rather than returning null when the fleet never separates — a caller has
 * nothing useful to do with "no marker", and the message names the reason.
 */
export const revealSiteMarker = async (page: Page): Promise<Locator> => {
  const siteMarker = page.locator(SITE_MARKER).first();

  // The fleet draws as one kind or the other but never as neither, so this is
  // the moment the overlay exists and the question below can be asked at all.
  await expect(page.locator(`${SITE_MARKER}, ${CLUSTER_MARKER}`).first()).toBeVisible();

  for (let expansion = 0; expansion < MAX_CLUSTER_EXPANSIONS; expansion += 1) {
    if (await siteMarker.isVisible()) {
      return siteMarker;
    }

    const index = await reachableClusterIndex(page);

    if (index < 0) {
      throw new Error('Every cluster on the map is buried under another one.');
    }

    const before = await overlayNames(page);

    await page.locator(CLUSTER_MARKER).nth(index).click();

    await expect
      .poll(async () => overlayNames(page), {
        message: 'The cluster was pressed but the overlay never reclustered.',
      })
      .not.toBe(before);
  }

  throw new Error(
    `No site separated out of its cluster within ${String(MAX_CLUSTER_EXPANSIONS)} expansions.`,
  );
};
