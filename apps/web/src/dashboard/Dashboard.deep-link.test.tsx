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
  it('opens on the site its URL names', async () => {
    const dataSource = new DemoFleetDataSource();
    const site = await firstListedSite(dataSource);

    visit(`/?site=${site.id}`);
    const container = renderDashboard(dataSource);
    await settle();

    // The site's own context, reached without a click — and the fleet panel
    // yielding the region is what says the selection really took, rather than
    // the heading having been rendered somewhere harmless.
    expect(screen.getByRole('heading', { name: site.name })).toBeDefined();
    expect(fleetPanel(container)?.hasAttribute('hidden')).toBe(true);
  });

  it('drops a link to a site the fleet does not have, and stops asking about it', async () => {
    const dataSource = new DemoFleetDataSource();
    const getSiteForecast = vi.spyOn(dataSource, 'getSiteForecast');

    visit(`/?site=${ABSENT_SITE_ID}`);
    const container = renderDashboard(dataSource);
    await settle();

    // The listing has answered, so the id is now known to name nobody: the
    // reader gets the fleet, and the URL stops advertising a site that is not
    // there.
    expect(fleetPanel(container)?.hasAttribute('hidden')).toBe(false);
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
