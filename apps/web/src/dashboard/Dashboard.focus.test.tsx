// @vitest-environment jsdom

import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DemoFleetDataSource } from '../data/demo-fleet-data-source';
import { firstListedSite, renderDashboard, settle, visit } from './dashboard-test-fixture';

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

/**
 * What `AddSiteForm` names a site dropped at the fixture's `CLICK_POSITION`.
 *
 * Restated rather than derived, for the reason `Dashboard.test.tsx` restates it:
 * it is the *form's* naming rule being relied on, and a test that computed the
 * name the same way the form does would still pass if both were wrong together.
 */
const CREATED_SITE_NAME = 'Site at 53.5000, -5.5000';

const fleetList = (): HTMLElement => screen.getByRole('list', { name: 'Fleet sites' });

const clickMap = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'Click the map' }));
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

  it('focuses the new site’s panel heading when a creation succeeds', async () => {
    renderDashboard(new DemoFleetDataSource());
    await settle();

    clickMap();
    fireEvent.click(screen.getByRole('button', { name: 'Add site' }));
    await settle();

    // A creation takes the region without anybody clicking into it, which is
    // exactly the case a focus move written into a click handler would miss.
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: CREATED_SITE_NAME }));
  });
});
