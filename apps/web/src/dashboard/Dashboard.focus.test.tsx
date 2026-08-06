// @vitest-environment jsdom

import type { Site } from '@cumulo/shared';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DemoFleetDataSource } from '../data/demo-fleet-data-source';
import type { FleetDataSource } from '../data/fleet-data-source';
import {
  addSite,
  clickMap,
  CREATED_SITE_NAME,
  firstListedSite,
  fleetTable,
  renderDashboard,
  settle,
  visit,
} from './dashboard-test-fixture';

/*
 * Where focus goes when a selection arrives, and where it goes back to.
 *
 * The composition's own assertions are `Dashboard.test.tsx`'s and the `?site=`
 * link's are `Dashboard.deep-link.test.tsx`'s; this file is the third subject
 * split off the same mount (`structure.md` rule 4), through the same fixture.
 *
 * The rule it proves is #260's settlement, and it has two halves that only make
 * sense together. **A reader-initiated selection focuses the card's own
 * heading** — the page changed because they pressed something, and leaving focus
 * on the pressed control would make a keyboard or screen-reader user find the
 * new surface by tabbing. **A `?site=` selection moves focus nowhere at all** —
 * the card mounts when the fleet listing resolves, which on a deep link is not
 * page load and can be seconds later, so a focus move there takes focus from
 * somebody who did nothing to ask for it (WCAG 3.2.5). **Closing returns focus
 * to whatever held it when the card opened**, because the Close button the
 * reader is sitting on is about to be unmounted and focus would otherwise fall
 * to `body`.
 *
 * `document.activeElement` is the whole assertion, and jsdom does implement it.
 * What jsdom cannot show is the focus *ring* — no layout, no painting — so that
 * this landing is visible is a browser criterion (`testing.md` rule 10) and is
 * checked in `e2e/keyboard-focus.spec.ts`, which drives the keyboard-initiated
 * path in real Chromium, reads the computed outline off the focused heading, and
 * carries the deep-link case in the lane the #260 report was written about.
 */

/** A well-formed id no fleet contains: a link to a site deleted, or mistyped. */
const UNRESOLVED_SITE_ID = '11111111-2222-4333-8444-555555555555';

/**
 * Presses a control the way a pointer does: focus, then click.
 *
 * `fireEvent.click` dispatches the event and nothing else, but a real press on a
 * `<button>` also focuses it — and that focus is precisely what the card
 * captures as the element to hand back to. A test that only clicked would leave
 * `document.activeElement` on `body` and quietly prove that the card returns
 * focus to nothing.
 */
const press = (control: HTMLElement): void => {
  control.focus();
  fireEvent.click(control);
};

/**
 * The first two sites the fleet lists — a reader moving from one selection to
 * the next needs two of them.
 *
 * Asked of the source rather than regenerated from the seed, for the reason
 * `firstListedSite` gives: a test that derived the ids the way the demo fleet
 * does would still pass if both drifted together. Local to this suite because
 * only this suite needs a pair.
 */
const twoListedSites = async (dataSource: FleetDataSource): Promise<readonly [Site, Site]> => {
  const listed = await dataSource.listSites();

  if (listed.kind !== 'ok') {
    throw new Error('The fleet under test refused to list its sites.');
  }

  const [first, second] = listed.value;

  if (first === undefined || second === undefined) {
    throw new Error('The fleet under test has fewer than two sites to move between.');
  }

  return [first, second];
};

/**
 * A fleet whose listing never arrives, wrapping the demo fleet for everything else.
 *
 * The state it buys — a selection with no site to show for it — is only
 * reachable this way: a *successful* listing runs the dashboard's stale-id
 * guard, which clears a selection naming nobody, so a selection can only outlive
 * its site when the listing failed. Distinct from `Dashboard.test.tsx`'s
 * `FlakyFleetSource`, which is about a listing that recovers on retry — this one
 * never does, because the test never asks it to.
 */
const fleetWithFailedListing = (): FleetDataSource => {
  const dataSource = new DemoFleetDataSource();

  // Only the listing is replaced. Everything else stays the real demo fleet, so
  // the first-forecast poll still runs against the selected id exactly as it
  // does in production — which is half of the state under test.
  vi.spyOn(dataSource, 'listSites').mockResolvedValue({
    kind: 'error',
    error: { code: 'network', message: 'Fleet API unreachable' },
  });

  return dataSource;
};

beforeEach(() => {
  // The creation path runs through the throttle and the first-forecast poll, so
  // the clock is simulated here as it is in every dashboard suite. Nothing sleeps.
  vi.useFakeTimers();
  visit('/');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  // Selecting a site writes `?site=` into this environment's address bar, and the
  // dashboard reads that at mount — a test that left one there would hand the
  // next test a selection it never made.
  visit('/');
});

describe('Dashboard focus on a reader-initiated selection', () => {
  it('focuses the site card’s own heading when a marker opens it', async () => {
    const dataSource = new DemoFleetDataSource();
    const site = await firstListedSite(dataSource);
    renderDashboard(dataSource);
    await settle();

    press(screen.getByRole('button', { name: `Marker: ${site.name}` }));

    expect(document.activeElement).toBe(screen.getByRole('heading', { name: site.name }));
  });

  it('hands focus back to the marker that opened the card', async () => {
    const dataSource = new DemoFleetDataSource();
    const site = await firstListedSite(dataSource);
    renderDashboard(dataSource);
    await settle();

    const marker = screen.getByRole('button', { name: `Marker: ${site.name}` });
    press(marker);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    // The opener, not a row: the card remembers the element that actually held
    // focus when it opened, so it lands a marker press back on the marker. The
    // panel this replaced searched the site list instead, which was the right
    // answer only for the one opener it knew about.
    expect(document.activeElement).toBe(marker);
  });

  it('follows the reader from one site to the next, and lands on the marker they last pressed', async () => {
    const dataSource = new DemoFleetDataSource();
    const [siteA, siteB] = await twoListedSites(dataSource);
    renderDashboard(dataSource);
    await settle();

    const markerA = screen.getByRole('button', { name: `Marker: ${siteA.name}` });
    const markerB = screen.getByRole('button', { name: `Marker: ${siteB.name}` });

    press(markerA);
    press(markerB);

    // B's card announces itself, exactly as A's did.
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: siteB.name }));

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    /*
     * Marker **B**, and the distinction is the whole case. The two cards live in
     * one commit — A unmounts as B mounts — and React flushes A's cleanup before
     * B's mount effect. A cleanup that restored unconditionally would therefore
     * put focus on marker A, B would capture *that* as its opener, and closing B
     * would strand the reader on the marker of a site they had already left. The
     * guard is what makes A stand aside: the reader's press moved focus to
     * marker B before the commit, so A no longer holds the focus it would be
     * giving back.
     */
    expect(document.activeElement).toBe(markerB);
  });

  it('leaves focus alone when the reader moved it out of the card before closing', async () => {
    const dataSource = new DemoFleetDataSource();
    const site = await firstListedSite(dataSource);
    renderDashboard(dataSource);
    await settle();

    press(screen.getByRole('button', { name: `Marker: ${site.name}` }));

    const row = within(fleetTable()).getByRole('button', {
      name: (name) => name.startsWith(site.name),
    });
    // The reader tabs away and dismisses from somewhere else. Escape is fired on
    // the card because that is what still owns the handler; where the *focus* is
    // is the point.
    row.focus();
    fireEvent.keyDown(screen.getByRole('heading', { name: site.name }), { key: 'Escape' });

    // Not the marker. A card that has already lost the focus is not entitled to
    // move it, and yanking a reader back to a control they deliberately left is
    // the same defect as never landing them anywhere.
    expect(document.activeElement).toBe(row);
  });

  it('hands focus back to the list row that opened the card', async () => {
    const dataSource = new DemoFleetDataSource();
    const site = await firstListedSite(dataSource);
    renderDashboard(dataSource);
    await settle();

    const row = within(fleetTable()).getByRole('button', {
      name: (name) => name.startsWith(site.name),
    });
    press(row);

    expect(document.activeElement).toBe(screen.getByRole('heading', { name: site.name }));

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    // The same mechanism reaching a different opener, which is what makes the
    // pair above and here one rule rather than two special cases.
    expect(document.activeElement).toBe(row);
  });

  it('closes on Escape from inside the card, and lands the same way', async () => {
    const dataSource = new DemoFleetDataSource();
    const site = await firstListedSite(dataSource);
    renderDashboard(dataSource);
    await settle();

    const marker = screen.getByRole('button', { name: `Marker: ${site.name}` });
    press(marker);

    // Fired on the heading, which is where the reader's focus actually is the
    // moment the card opens — a dismissal that only worked from the Close button
    // would be one most readers never reach.
    fireEvent.keyDown(screen.getByRole('heading', { name: site.name }), { key: 'Escape' });

    expect(screen.queryByRole('heading', { name: site.name })).toBeNull();
    expect(document.activeElement).toBe(marker);
  });

  it('focuses the card heading when the header’s search picks a site', async () => {
    const dataSource = new DemoFleetDataSource();
    const site = await firstListedSite(dataSource);
    renderDashboard(dataSource);
    await settle();

    const search = screen.getByRole('combobox', { name: 'Search sites by name' });
    fireEvent.change(search, { target: { value: site.name } });
    fireEvent.keyDown(search, { key: 'Enter' });

    /*
     * The fourth opener, and the reason it needed no new focus code: the search
     * selects through `selectSiteForReader` like a marker and a row do, so the
     * card is reader-initiated and takes the focus by the rule already in place.
     * What this case rules out is the version where the bar wires itself
     * straight to `setSelectedSiteId` — every assertion about the selection
     * would still pass, and the reader would be left in a text field with their
     * answer somewhere below.
     */
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: site.name }));
  });

  it('focuses the new site’s card heading when a creation succeeds', async () => {
    renderDashboard(new DemoFleetDataSource());
    await settle();

    await addSite();

    // A creation selects a site without anybody clicking into it, which is
    // exactly the case a focus move written into a click handler would miss.
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: CREATED_SITE_NAME }));
  });

  it('returns a created site’s card to the control the draft was opened with', async () => {
    const container = renderDashboard(new DemoFleetDataSource());
    await settle();

    await addSite();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    /*
     * The ordering this depends on, stated because it is easy to break and
     * invisible when it is: React flushes a commit's unmount cleanups before its
     * mount effects, so the dismissed dialog has already put focus on the map's
     * add-site control by the time the new card captures its opener. Capture the
     * opener a moment earlier — in the dashboard's creation handler, say — and it
     * would be the dialog's submit button, which is no longer in the document,
     * and this close would strand the reader on `body`.
     */
    expect(document.activeElement).toBe(container.querySelector('.map-control-add'));
  });
});

describe('Dashboard focus on a deep link', () => {
  it('leaves focus where the reader left it when ?site= opens a card', async () => {
    const dataSource = new DemoFleetDataSource();
    const site = await firstListedSite(dataSource);

    visit(`/?site=${site.id}`);
    const container = renderDashboard(dataSource);
    await settle();

    /*
     * The regression #260 is about. The card really did open — asserted first,
     * so a card that failed to mount at all could not pass this by leaving focus
     * untouched — and focus is still on `body`, where a fresh document starts.
     * In a real browser this mount lands whenever the listing resolves, so the
     * focus this refuses to take is whatever the reader had reached meanwhile.
     */
    expect(container.querySelector('.site-popover')).not.toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it('leaves focus alone when a deep-linked card closes, too', async () => {
    const dataSource = new DemoFleetDataSource();
    const site = await firstListedSite(dataSource);

    visit(`/?site=${site.id}`);
    renderDashboard(dataSource);
    await settle();

    const row = within(fleetTable()).getByRole('button', {
      name: (name) => name.startsWith(site.name),
    });
    row.focus();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    // A card that never took the focus has none to give back, so it does not
    // move any: the reader keeps whatever they had reached under their own
    // steam. Without the guard, the close would send them to the element that
    // happened to be focused when the listing resolved.
    expect(document.activeElement).toBe(row);
  });
});

describe('Dashboard focus around the add-site draft', () => {
  it('announces the draft by focusing the dialog’s own heading', async () => {
    const dataSource = new DemoFleetDataSource();
    const site = await firstListedSite(dataSource);
    renderDashboard(dataSource);
    await settle();

    press(screen.getByRole('button', { name: `Marker: ${site.name}` }));
    clickMap();

    // A modal announces itself with its own heading. What changed underneath is
    // that the site's card it opened over is still on the map behind it rather
    // than displaced.
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Add a site' }));
  });

  it('returns focus to the map’s add-site control when a draft over a site is cancelled', async () => {
    const dataSource = new DemoFleetDataSource();
    const site = await firstListedSite(dataSource);
    const container = renderDashboard(dataSource);
    await settle();

    press(screen.getByRole('button', { name: `Marker: ${site.name}` }));
    clickMap();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    /*
     * Not the site's card heading. The card was never displaced — it is on the
     * map, and the modal opened over the whole page — so it has no reason to
     * re-announce, and the control the reader opened the draft with is the
     * honest place to put them back.
     */
    expect(document.activeElement).toBe(container.querySelector('.map-control-add'));
    // And the card really is still there — otherwise the assertion above would
    // be about a page with nothing on it.
    expect(screen.getByRole('heading', { name: site.name })).toBeDefined();
  });

  it('returns focus to the map’s add-site control when a draft with nothing behind it is cancelled', async () => {
    const container = renderDashboard(new DemoFleetDataSource());
    await settle();

    clickMap();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    // Without the hand-off, focus falls to `body` as the dialog leaves the
    // document — a keyboard reader starting the page again.
    expect(document.activeElement).toBe(container.querySelector('.map-control-add'));
  });

  /*
   * The case where the selection and the selectable site disagree.
   *
   * A `?site=` link whose listing failed leaves `selectedSiteId` set and
   * `selectedSite` null: the id is real to the URL and to the forecast poll, but
   * no site answers to it, so no card is drawn. It is kept because it is the
   * state in which *nothing at all* is on screen to take the focus, so a return
   * that was quietly conditional on something else claiming it would strand a
   * reader here.
   */
  it('returns focus to the control when a cancelled draft’s selection names no site', async () => {
    visit(`/?site=${UNRESOLVED_SITE_ID}`);
    const container = renderDashboard(fleetWithFailedListing());
    await settle();

    // The precondition, pinned so this cannot quietly decay into the test above:
    // the selection survived the failed listing — the URL still carries it — and
    // no card is on screen to take the focus.
    expect(window.location.search).toBe(`?site=${UNRESOLVED_SITE_ID}`);
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();

    clickMap();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(document.activeElement).toBe(container.querySelector('.map-control-add'));
  });
});
