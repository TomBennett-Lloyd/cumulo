// @vitest-environment jsdom

import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DemoFleetDataSource } from '../data/demo-fleet-data-source';
import type { FleetDataSource } from '../data/fleet-data-source';
import {
  addSite,
  clickMap,
  CREATED_SITE_NAME,
  firstListedSite,
  fleetList,
  renderDashboard,
  settle,
  visit,
} from './dashboard-test-fixture';

/*
 * Where focus goes when the column swaps one context for another.
 *
 * The composition's own assertions are `Dashboard.test.tsx`'s and the `?site=`
 * link's are `Dashboard.deep-link.test.tsx`'s; this file is the third subject
 * split off the same mount (`structure.md` rule 4), through the same fixture.
 *
 * What it proves is one rule in two halves. An occupant taking the region
 * focuses its own heading — the region changes above the reader's focus point,
 * and a swap nobody is told about is one a keyboard or screen-reader user finds
 * only by tabbing. A panel *leaving* the region hands focus to the list row that
 * names its site, because the Close button they were sitting on is about to be
 * unmounted and focus would otherwise fall to `body`.
 *
 * `document.activeElement` is the whole assertion, and jsdom does implement it.
 * What jsdom cannot show is the focus *ring* — no layout, no painting — so that
 * this landing is visible remains a browser criterion, checked in a browser.
 */

/** A well-formed id no fleet contains: a link to a site deleted, or mistyped. */
const UNRESOLVED_SITE_ID = '11111111-2222-4333-8444-555555555555';

/**
 * A fleet whose listing never arrives, wrapping the demo fleet for everything else.
 *
 * The state it buys is the one the guard in `closeDraft` turns on, and it is
 * only reachable this way: a *successful* listing runs the dashboard's stale-id
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

describe('Dashboard focus', () => {
  it('focuses the site panel’s own heading when a marker opens it', async () => {
    const dataSource = new DemoFleetDataSource();
    const site = await firstListedSite(dataSource);
    renderDashboard(dataSource);
    await settle();

    fireEvent.click(screen.getByRole('button', { name: `Marker: ${site.name}` }));

    expect(document.activeElement).toBe(screen.getByRole('heading', { name: site.name }));
  });

  it('hands focus to the site’s own list row when the panel closes', async () => {
    const dataSource = new DemoFleetDataSource();
    const site = await firstListedSite(dataSource);
    renderDashboard(dataSource);
    await settle();

    fireEvent.click(screen.getByRole('button', { name: `Marker: ${site.name}` }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    const row = within(fleetList()).getByRole('button', {
      name: (name) => name.startsWith(site.name),
    });

    // The attribute the dashboard matches on, pinned here: the row is found by
    // its site id, not by its position in the list or by its label.
    expect(row.dataset.siteId).toBe(site.id);
    // Without the hand-off, focus falls to `body` the moment Close unmounts.
    expect(document.activeElement).toBe(row);
  });

  it('gives the heading back to the site panel when a draft over it is cancelled', async () => {
    const dataSource = new DemoFleetDataSource();
    const site = await firstListedSite(dataSource);
    renderDashboard(dataSource);
    await settle();

    fireEvent.click(screen.getByRole('button', { name: `Marker: ${site.name}` }));
    clickMap();

    // The draft is an occupant like any other, and announces itself the same way.
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Add a site' }));

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    // The panel remounts and claims the heading itself, so the dashboard must not
    // compete for the focus here.
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: site.name }));
  });

  it('lands on the context region when a draft with nothing behind it is cancelled', async () => {
    const container = renderDashboard(new DemoFleetDataSource());
    await settle();

    clickMap();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    // Nothing remounts on this path — the fleet panel was hidden, not gone — so
    // the region itself is the only honest target left.
    expect(document.activeElement).toBe(container.querySelector('.dashboard-context'));
  });

  /*
   * The case where the selection and the selectable site disagree.
   *
   * A `?site=` link whose listing failed leaves `selectedSiteId` set and
   * `selectedSite` null: the id is real to the URL and to the forecast poll, but
   * no site answers to it, so no `SitePanel` is mounted. Cancelling a draft here
   * is the one path where guarding the region focus on the *id* would skip it
   * while nothing remounted to claim it — focus to body, the exact defect this
   * mechanism removes. The guard therefore asks `selectedSite`, which is what
   * the panel's own render condition asks.
   */
  it('lands on the context region when a cancelled draft’s selection names no site', async () => {
    visit(`/?site=${UNRESOLVED_SITE_ID}`);
    const container = renderDashboard(fleetWithFailedListing());
    await settle();

    // The precondition, pinned so this cannot quietly decay into the test above:
    // the selection survived the failed listing — the URL still carries it — and
    // no panel is on screen to take the focus.
    expect(window.location.search).toBe(`?site=${UNRESOLVED_SITE_ID}`);
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();

    clickMap();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(document.activeElement).toBe(container.querySelector('.dashboard-context'));
  });

  it('focuses the new site’s panel heading when a creation succeeds', async () => {
    renderDashboard(new DemoFleetDataSource());
    await settle();

    await addSite();

    // A creation takes the region without anybody clicking into it, which is
    // exactly the case a focus move written into a click handler would miss.
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: CREATED_SITE_NAME }));
  });
});
