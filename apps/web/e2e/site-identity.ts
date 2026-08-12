import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

import { revealSiteMarker } from './marker-reveal';

/*
 * Which site the running app is actually holding — its id and its name — read
 * off the map rather than predicted from the seed.
 *
 * A spec that wants to deep-link to a site, or to type a site's name into the
 * header's search, needs two facts about a real site: the identifier the address
 * bar will carry, and the name a reader would recognise. Neither may be
 * *derived*. The demo fleet composes both from the same generator
 * (`packages/shared/src/fleet.ts`), so a spec that rebuilt an id the way the app
 * builds it would still pass if the app and the spec drifted together — the two
 * would agree about a value that had stopped matching anything a reader sees.
 * Read off the running page they cannot: the id here is whatever the app just
 * put in the URL, and the name is whatever it just painted on a marker.
 *
 * The map is where those two facts now meet. The marker's `aria-label` *is* the
 * site's name (`src/map/MarkerButton.tsx`), and pressing the marker is what
 * writes the id into the address bar — so one gesture yields both, and the id is
 * observed as the app's own answer rather than asked of any element's attribute.
 * Until #451 this lived on a row of the fleet's table, which carried the id in a
 * data attribute and the name as its text; that table is gone and the argument
 * moved with it (`architecture.md` rule 11).
 *
 * The gesture is a pointer one and nothing is claimed about it. Callers wanting
 * a claim about the *keyboard* route to a marker have it in
 * `keyboard-focus.spec.ts`, which tabs there itself — a helper doing that for
 * them would be the assertion answering itself, which is the same line
 * `marker-reveal.ts` draws.
 */

/** One site, as the running app names and identifies it. */
export interface SiteIdentity {
  readonly id: string;
  readonly name: string;
}

/** The site the address bar is currently holding, or `null` when it holds none. */
const selectedSiteId = (page: Page): string | null => new URL(page.url()).searchParams.get('site');

/**
 * Reveal one site on the map, press it, and hand back what the app called it.
 *
 * Leaves the caller on a freshly loaded `/`. That matters more than it looks:
 * reaching a marker means zooming the camera in, and pressing it opens a card
 * and puts a `?site=` in the URL — three pieces of state a caller's own case
 * would then be starting from rather than from the page a reader loads. So this
 * navigates at both ends, and a caller's preconditions are its own again.
 *
 * Throws rather than returning a partial identity: a caller has nothing useful
 * to do with a site it can name but not link to, and the message says which half
 * was missing where a bare failure downstream would blame the caller's own
 * gesture.
 */
export const firstSiteIdentity = async (page: Page): Promise<SiteIdentity> => {
  await page.goto('/');

  const marker = await revealSiteMarker(page);
  const name = await marker.getAttribute('aria-label');

  if (name === null) {
    throw new Error('The revealed site marker carries no accessible name to search by.');
  }

  await marker.click();

  await expect
    .poll(() => selectedSiteId(page), {
      message: 'Pressing a site marker never put a ?site= in the address bar.',
    })
    .not.toBeNull();

  // Re-read rather than captured by the poll, which reports a match without
  // handing the value back. Safe because the URL only gains the parameter here:
  // nothing else on the page is being touched, so the value the poll saw is the
  // value still standing.
  const id = selectedSiteId(page);

  if (id === null) {
    throw new Error('The address bar dropped its ?site= between the poll and the read.');
  }

  await page.goto('/');

  return { id, name };
};
