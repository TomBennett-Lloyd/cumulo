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
 * The rule it proves is `design.md` rule 11 as #328 settled it, and it has
 * three clauses that only make sense together. **A
 * selection moves focus nowhere**: whoever pressed a marker is still on that
 * marker, whoever pressed a row is still on that row, and whoever picked a site
 * out of the header's search is still in the search input, which is the
 * combobox discipline that pattern owes anyway. What answers the selection is
 * structure the reader can already reach — the card's own accessible name, the
 * chart legend's row for the site — rather than a page that takes their place
 * away to tell them something. **A `?site=` selection additionally captures no
 * opener**: the card mounts when the fleet listing resolves, which on a deep
 * link is not page load and can be seconds later, so nothing about that instant
 * identifies a control anybody chose (WCAG 3.2.5, #260). **Closing returns
 * focus to whatever held it when the card opened, if the card is holding it by
 * then** — which, with nothing landing anybody inside the card, means exactly
 * the reader who came *into* it, pressing or tabbing to Close.
 *
 * That third clause is why several cases below press Close through {@link press}
 * rather than clicking it: a real pointer press focuses the button it presses,
 * which is how a reader ends up inside the card a moment before it unmounts. A
 * dismissal that never moves focus into the card leaves the reader where they
 * were, and the cases that say so are here too.
 *
 * The one focus move left on this page is the add-site *dialog*'s, which is a
 * modal — the surface whose own controls are the answer — and it is the last
 * describe below.
 *
 * `document.activeElement` is the whole assertion, and jsdom does implement it.
 * What jsdom cannot show is the focus *ring* — no layout, no painting — so every
 * question about one is a browser criterion (`testing.md` rule 10), and the
 * browser lane splits it across two specs holding a clause each. Whether a ring
 * appears where the reader did *not* ask for one — the pointer flows, meaning
 * *mouse and touch*, which that file carries as two named arms since #440 found
 * a tapped chart taking a ring the mouse path never took — is
 * `e2e/pointer-focus.spec.ts`'s. Whether a keyboard reader still gets one is
 * `e2e/keyboard-focus.spec.ts`'s, which drives the keyboard path in real
 * Chromium and carries the deep-link case in the lane the #260 report was
 * written about. Neither spec means anything without the other, so a change
 * deleting one is deleting half of rule 11.
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
 *
 * It carries the same weight on the way out. Pressing the card's Close puts the
 * focus inside the card first, which is what a pointer really does and what
 * makes the hand-back the card's to owe; the cases that dismiss with a bare
 * `fireEvent.click` are deliberately the other gesture, and say so.
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
  it('leaves focus on the marker that opened the card', async () => {
    const dataSource = new DemoFleetDataSource();
    const site = await firstListedSite(dataSource);
    renderDashboard(dataSource);
    await settle();

    const marker = screen.getByRole('button', { name: `Marker: ${site.name}` });
    press(marker);

    // The marker, because that is where the reader put themselves. The card is
    // on screen and named — the assertion below is what keeps this from passing
    // over a selection that never opened one — and being named is how the card
    // answers, rather than by taking the reader off the control they pressed
    // (#328, `design.md` rule 11).
    expect(document.activeElement).toBe(marker);
    expect(screen.getByRole('heading', { name: site.name })).toBeDefined();
  });

  it('leaves focus on the marker when the card is dismissed from outside it', async () => {
    const dataSource = new DemoFleetDataSource();
    const site = await firstListedSite(dataSource);
    renderDashboard(dataSource);
    await settle();

    const marker = screen.getByRole('button', { name: `Marker: ${site.name}` });
    press(marker);
    // A bare click, which — unlike {@link press} — moves no focus: the reader
    // never comes into the card, so the card never holds the focus it would be
    // handing back and its guarded restore stands aside. Here the marker is both
    // where the reader is and the opener the restore would name, so what this
    // case pins is that the round trip is a no-op; the case that separates the
    // two is `leaves focus where the reader themselves moved it` below.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(document.activeElement).toBe(marker);
  });

  it('hands focus back to the marker when the reader closes the card from inside it', async () => {
    const dataSource = new DemoFleetDataSource();
    const site = await firstListedSite(dataSource);
    renderDashboard(dataSource);
    await settle();

    const marker = screen.getByRole('button', { name: `Marker: ${site.name}` });
    press(marker);
    // Pressed rather than clicked, which is what a pointer really does: the
    // reader comes into the card, so the control they are standing on is about
    // to unmount under them and the landing is owed again.
    press(screen.getByRole('button', { name: 'Close' }));

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

    // B's selection moves the reader no more than A's did, and B's card is the
    // one on screen.
    expect(document.activeElement).toBe(markerB);
    expect(screen.getByRole('heading', { name: siteB.name })).toBeDefined();

    press(screen.getByRole('button', { name: 'Close' }));

    /*
     * Marker **B**, and the distinction is the whole case. The two cards live in
     * one commit — A unmounts as B mounts — and React flushes A's cleanup before
     * B's mount effect. A cleanup that restored unconditionally would therefore
     * put focus on marker A, B would capture *that* as its opener, and closing B
     * would strand the reader on the marker of a site they had already left. The
     * guard is what makes A stand aside: the reader's press moved focus to
     * marker B before the commit, so A no longer holds the focus it would be
     * giving back — and since #328 A was never holding it in the first place,
     * because A's opening moved nobody into it. Either way B is the opener the
     * reader is owed, which is what the press on Close above collects.
     */
    expect(document.activeElement).toBe(markerB);
  });

  it('leaves focus where the reader themselves moved it, rather than on the opener', async () => {
    const dataSource = new DemoFleetDataSource();
    const site = await firstListedSite(dataSource);
    renderDashboard(dataSource);
    await settle();

    press(screen.getByRole('button', { name: `Marker: ${site.name}` }));

    const row = within(fleetTable()).getByRole('button', {
      name: (name) => name.startsWith(site.name),
    });
    // The reader leaves the marker for a row of their own accord and dismisses
    // from there. Escape is fired on the card because that is what still owns
    // the handler; where the *focus* is is the point.
    row.focus();
    fireEvent.keyDown(screen.getByRole('heading', { name: site.name }), { key: 'Escape' });

    // Not the marker. A card that does not hold the focus is not entitled to
    // move it, and yanking a reader back to a control they deliberately left is
    // the same defect as taking their place away in the first place. This is
    // also the case that separates "focus did not move" from "focus was moved
    // back to where it started", which the marker cases cannot: the reader is
    // demonstrably somewhere the opener is not.
    expect(document.activeElement).toBe(row);
  });

  it('leaves focus on the row that opened the card, and returns to it from inside', async () => {
    const dataSource = new DemoFleetDataSource();
    const site = await firstListedSite(dataSource);
    renderDashboard(dataSource);
    await settle();

    const row = within(fleetTable()).getByRole('button', {
      name: (name) => name.startsWith(site.name),
    });
    press(row);

    expect(document.activeElement).toBe(row);

    press(screen.getByRole('button', { name: 'Close' }));

    // The hand-back reaching a different opener, which is what makes the marker
    // cases above and this one one rule rather than special cases per opener:
    // the card does not need to be told who opened it, and nothing had to be
    // told where a row press should have landed.
    expect(document.activeElement).toBe(row);
  });

  it('closes on Escape from inside the card, and lands the same way', async () => {
    const dataSource = new DemoFleetDataSource();
    const site = await firstListedSite(dataSource);
    renderDashboard(dataSource);
    await settle();

    const marker = screen.getByRole('button', { name: `Marker: ${site.name}` });
    press(marker);

    /*
     * Fired from the Close button with the focus on it, which is a reader who
     * has come into the card: Escape is handled on the card's container, so it
     * works from every control inside the card and from none outside it. That
     * last half is the accepted cost of adding no document-level key handler
     * (`map/SitePopoverCard.tsx` states it beside the handler), and this case
     * puts the focus inside directly. What the *route* into the card costs a
     * keyboard reader needs a real tab order and a real key modality, which is
     * the browser lane's (`testing.md` rule 10) and is owned by no spec today —
     * `docs/tech-debt.md` carries that gap.
     */
    const close = screen.getByRole('button', { name: 'Close' });
    close.focus();
    fireEvent.keyDown(close, { key: 'Escape' });

    expect(screen.queryByRole('heading', { name: site.name })).toBeNull();
    expect(document.activeElement).toBe(marker);
  });

  it('keeps focus in the search input when the header’s search picks a site', async () => {
    const dataSource = new DemoFleetDataSource();
    const site = await firstListedSite(dataSource);
    renderDashboard(dataSource);
    await settle();

    const search = screen.getByRole('combobox', { name: 'Search sites by name' });
    // Focused first, because that is what typing into a field means and it is
    // the state the assertion is about: the reader is *in* the combobox.
    search.focus();
    fireEvent.change(search, { target: { value: site.name } });
    fireEvent.keyDown(search, { key: 'Enter' });

    /*
     * The opener this member is named for (#328). A combobox keeps focus in its
     * input when a value is chosen — that is the pattern's own discipline
     * (`design.md` rule 11) — so a selection that moved focus to a control
     * elsewhere on the page was taking a reader out of the field they were still
     * typing in, mid-search, on every hit. Nothing here is a special case for
     * the search: it selects through `selectSiteForReader` like a marker and a
     * row do, and no selection moves anybody now.
     *
     * The heading assertion is what stops this from passing over a search that
     * selected nothing at all, which would leave focus in the input too.
     */
    expect(document.activeElement).toBe(search);
    expect(screen.getByRole('heading', { name: site.name })).toBeDefined();
  });

  it('leaves a creation’s focus on the map control the dialog returned it to', async () => {
    const container = renderDashboard(new DemoFleetDataSource());
    await settle();

    await addSite();

    /*
     * The dismissed dialog's landing, and — since the new site's card takes no
     * focus behind it (#328) — the last focus move a creation makes. React
     * flushes a commit's unmount cleanups before its mount effects, so a card
     * that still grabbed focus here would win this assertion; that ordering is
     * the reason this case is the one that would notice.
     */
    expect(document.activeElement).toBe(container.querySelector('.map-control-add'));
    expect(screen.getByRole('heading', { name: CREATED_SITE_NAME })).toBeDefined();
  });

  it('returns a created site’s card to the control the draft was opened with', async () => {
    const container = renderDashboard(new DemoFleetDataSource());
    await settle();

    await addSite();
    press(screen.getByRole('button', { name: 'Close' }));

    /*
     * The ordering this depends on, stated because it is easy to break and
     * invisible when it is: React flushes a commit's unmount cleanups before its
     * mount effects, so the dismissed dialog has already put focus on the map's
     * add-site control by the time the new card captures its opener. Capture the
     * opener a moment earlier — in the dashboard's creation handler, say — and it
     * would be the dialog's submit button, which is no longer in the document,
     * and this close would strand the reader on `body`.
     *
     * Reached by pressing Close rather than clicking it, for the reason the
     * marker pair above gives: nothing puts a reader inside the card (#328), so
     * the hand-back is owed only once they have come into it themselves — and
     * this is the case that keeps the capture *ordering* observable at all.
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
