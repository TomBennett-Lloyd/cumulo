// @vitest-environment jsdom

import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DemoFleetDataSource } from '../data/demo-fleet-data-source';
import {
  advanceBy,
  firstListedSite,
  fleetPanel,
  renderDashboard,
  settle,
  sitePopover,
  visit,
} from './dashboard-test-fixture';

/*
 * `?site=<id>`: the URL as a way in, and as a record of where the reader is.
 *
 * The parsing and writing rules are `selection-url.test.ts`'s. What this file
 * proves is the dashboard's half — that a link opens on the site it names, that
 * a link naming nobody costs nothing, and that the address bar tracks the
 * selection in both directions.
 */

/** A well-formed id that no fleet contains: a link to a site that was deleted, or mistyped. */
const ABSENT_SITE_ID = '11111111-2222-4333-8444-555555555555';

/** The hook's deadline — how long a dead deep link would poll for if nothing cleared it. */
const FIRST_FORECAST_DEADLINE_MS = 90_000;

beforeEach(() => {
  vi.useFakeTimers();
  visit('/');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  visit('/');
});

describe('Dashboard deep links', () => {
  it('opens on the site its URL names, and closes back to a fleet and a bare URL', async () => {
    const dataSource = new DemoFleetDataSource();
    const site = await firstListedSite(dataSource);

    visit(`/?site=${site.id}`);
    const container = renderDashboard(dataSource);
    await settle();

    // The site's own card, reached without a click — and the fleet panel is
    // still right there under the map, because a selection no longer displaces
    // anything (#265).
    expect(screen.getByRole('heading', { name: site.name })).toBeDefined();
    expect(sitePopover(container)).not.toBeNull();
    expect(fleetPanel(container)).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await settle();

    // The way out of a link, which is a different path from the way out of a
    // click: this selection was never written to the address bar by the sync
    // effect — it arrived already there, in the lazy initialiser. A dashboard
    // whose close only undid its own writes would leave a reader who arrived
    // cold on `?site=` still advertising a site they have shut, and would hand
    // that stale link back to anyone copying the URL afterwards.
    expect(sitePopover(container)).toBeNull();
    expect(screen.queryByRole('heading', { name: site.name })).toBeNull();
    expect(window.location.search).toBe('');
  });

  it('spends the fleet fan-out once on a deep link, the trade for a chart that is never hidden', async () => {
    const dataSource = new DemoFleetDataSource();
    const fleetForecasts = vi.spyOn(dataSource, 'fleetForecasts');
    const site = await firstListedSite(dataSource);

    visit(`/?site=${site.id}`);
    renderDashboard(dataSource);
    await settle();

    /*
     * #178 deferred this fan-out until the fleet panel was first revealed, so a
     * deep-linked reader who never looked at the fleet never paid for it. #265
     * spent that saving deliberately: the fleet's chart is on screen from first
     * paint in every state of the page, and the selected site is drawn *over*
     * it, so there is no reader left who does not look at the fleet — only one
     * who would be shown a spinner where the chart already is. In live mode the
     * cost is a paced per-site fan-out (~8 s over 60 sites).
     *
     * What survives is the half that was always load-bearing: it is spent
     * **once**. The listing resolving and the deep link's selection landing in
     * the same commit must not read as two events.
     */
    expect(fleetForecasts).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await settle();

    // Deselection is still not an event that changes the sum — #161's
    // spent-once-and-kept property, unchanged.
    expect(fleetForecasts).toHaveBeenCalledTimes(1);
  });

  it('drops a link to a site the fleet does not have, and stops asking about it', async () => {
    const dataSource = new DemoFleetDataSource();
    const getSiteForecast = vi.spyOn(dataSource, 'getSiteForecast');

    visit(`/?site=${ABSENT_SITE_ID}`);
    const container = renderDashboard(dataSource);
    await settle();

    // The listing has answered, so the id is now known to name nobody: no card
    // opens, and the URL stops advertising a site that is not there.
    expect(sitePopover(container)).toBeNull();
    expect(fleetPanel(container)).not.toBeNull();
    expect(window.location.search).toBe('');

    const pollsSoFar = getSiteForecast.mock.calls.length;
    await advanceBy(FIRST_FORECAST_DEADLINE_MS);

    // The point of clearing it at the listing rather than later: without the
    // guard this loop would keep asking for a site that does not exist, once
    // every five seconds, for the full ninety-second deadline.
    expect(getSiteForecast).toHaveBeenCalledTimes(pollsSoFar);
  });

  it('publishes a selection to the address bar and takes it back on close', async () => {
    const dataSource = new DemoFleetDataSource();
    const site = await firstListedSite(dataSource);
    renderDashboard(dataSource);
    await settle();

    expect(window.location.search).toBe('');

    fireEvent.click(screen.getByRole('button', { name: `Marker: ${site.name}` }));
    await settle();

    // The link a reader would copy out of the address bar at this moment is the
    // link the first test above arrives on.
    expect(window.location.search).toBe(`?site=${site.id}`);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await settle();

    expect(window.location.search).toBe('');
  });
});
