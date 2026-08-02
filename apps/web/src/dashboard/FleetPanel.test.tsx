// @vitest-environment jsdom

import type { Site } from '@cumulo/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { DemoFleetDataSource } from '../data/demo-fleet-data-source';
import {
  CountingFleetSource,
  FAILED_FLEET,
  FORECASTLESS_FLEET,
  FULL_FLEET,
  HORIZON_ONLY_CAPABILITIES,
  PARTIAL_FLEET,
  panel,
  renderSettled,
  settle,
  SITE_A,
  type StubFleet,
} from './fleet-panel-test-fixture';
import { EMPTY_FLEET_MESSAGE } from './state-copy';

// Vitest runs without global test hooks, so Testing Library's automatic cleanup never registers
// itself — every render has to be torn down explicitly or later queries match two panels.
afterEach(cleanup);

/**
 * One rendered table row, in column order — the row header and its cells together.
 *
 * `th, td` rather than the `cell` role, because the time column is a `rowheader` and a row read as
 * four values would drop the hour each of them belongs to.
 */
const rowCells = (row: HTMLElement): readonly string[] =>
  Array.from(row.querySelectorAll('th, td'), (cell) => cell.textContent);

const demoFleet = async (dataSource: DemoFleetDataSource): Promise<readonly Site[]> => {
  const listed = await dataSource.listSites();
  if (listed.kind === 'error') {
    throw new Error(`the demo source refused to list its fleet: ${listed.error.message}`);
  }
  return listed.value;
};

describe('FleetPanel against a source with the full fleet-level capabilities', () => {
  it('offers the aggregation range and promises measured output, against the demo source', async () => {
    const dataSource = new DemoFleetDataSource();
    const sites = await demoFleet(dataSource);
    const container = await renderSettled(dataSource, sites);

    expect(screen.getByRole('group', { name: 'Aggregation range' })).toBeDefined();
    expect(screen.getByText(/summed hour by hour/u).textContent).toContain('measured output');
    // The canonical demo fleet is 60 sites; the kW figure is asserted by shape rather than by
    // value, because restating the sum here would only prove that two copies of it agree.
    expect(container.querySelector('.fleet-panel-stats')?.textContent).toMatch(
      /^60 sites · \d+(\.\d)? kW installed$/u,
    );
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('says "site" once and "sites" otherwise', async () => {
    const oneSite = await renderSettled(new CountingFleetSource(FULL_FLEET), [SITE_A]);

    expect(oneSite.querySelector('.fleet-panel-stats')?.textContent).toBe(
      '1 site · 4.0 kW installed',
    );

    cleanup();
    const twoSites = await renderSettled(new CountingFleetSource(FULL_FLEET));

    expect(twoSites.querySelector('.fleet-panel-stats')?.textContent).toBe(
      '2 sites · 8.0 kW installed',
    );
  });

  it('asks the source for 168 hours when the 7 d control is pressed', async () => {
    const dataSource = new CountingFleetSource(FULL_FLEET);
    await renderSettled(dataSource);

    expect(dataSource.forecastRanges).toEqual([24]);

    fireEvent.click(screen.getByRole('button', { name: '7 d' }));

    await waitFor(() => {
      expect(dataSource.forecastRanges).toEqual([24, 168]);
    });
  });

  it('labels the aggregate partial, with both counts, when an hour is missing a site', async () => {
    const container = await renderSettled(new CountingFleetSource(PARTIAL_FLEET));

    expect(container.querySelector('.panel-notice')?.textContent).toBe(
      'Partial aggregate: some hours include only 1 of 2 sites.',
    );
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('sums the fleet into the chart, hour by hour: median, band bounds and measurement', async () => {
    await renderSettled(new CountingFleetSource(FULL_FLEET));

    const table = screen.getByRole('table', {
      name: 'Table view — fleet forecast and measured output, 24 h range, kW',
    });

    /*
     * The table twin is where the plotted numbers are readable as text, so it is where the
     * aggregate can be pinned; the SVG carries the same values as coordinates nobody can assert
     * on without re-deriving the geometry.
     *
     * Every figure below is the fixture's own arithmetic, stated rather than computed: at 06:00
     * the two sites forecast 2 and 4 kW (median 6), their bands are 1–3 and 3–6 (P10 4, P90 9 —
     * comonotonic addition, `@cumulo/shared`'s rule, not this panel's), and they measured 1.5 and
     * 3.5 (5). 07:00 has no readings at all, so its measurement cell is the em dash a gap reads
     * as — which is what stops a suite from passing on an actuals series that silently went
     * missing.
     */
    expect(within(table).getAllByRole('row').map(rowCells)).toEqual([
      ['Time', 'P10', 'Median', 'P90', 'Actual'],
      ['06:00', '4.0', '6.0', '9.0', '5.0'],
      ['07:00', '6.0', '8.0', '11.0', '—'],
    ]);
  });

  it('states the fleet size when every displayed hour has the whole fleet in it', async () => {
    const container = await renderSettled(new CountingFleetSource(FULL_FLEET));

    expect(container.querySelector('.panel-caption')?.textContent).toBe('Aggregated from 2 sites');
    expect(container.querySelector('.panel-notice')).toBeNull();
  });
});

describe('FleetPanel against a source that can only see the horizon', () => {
  const horizonSource = (canned: StubFleet = FULL_FLEET): CountingFleetSource =>
    new CountingFleetSource(canned, HORIZON_ONLY_CAPABILITIES);

  it('withholds the range control and names the horizon instead', async () => {
    const container = await renderSettled(horizonSource());

    expect(screen.queryByRole('group', { name: 'Aggregation range' })).toBeNull();
    expect(container.querySelector('.panel-caption')?.textContent).toBe(
      'Forecast horizon: next 24 hours',
    );
  });

  it('never says the word "measured" — not in prose, not in the chart\'s accessible name', async () => {
    const container = await renderSettled(horizonSource());

    // innerHTML rather than textContent on purpose: an aria-label is copy too, and it is the copy
    // most easily left promising data the source cannot produce.
    expect(container.innerHTML.toLowerCase()).not.toContain('measured');
    expect(screen.getByRole('img', { name: /Fleet forecast/u }).getAttribute('aria-label')).toBe(
      'Fleet forecast, next 24 h',
    );
  });

  it('only ever asks for the 24 hour window it advertises', async () => {
    const dataSource = horizonSource();
    await renderSettled(dataSource);

    expect(dataSource.forecastRanges).toEqual([24]);
  });
});

describe('FleetPanel with nothing to show', () => {
  it('makes an empty fleet the invitation, with no chart and no range control', async () => {
    const container = await renderSettled(new CountingFleetSource(FULL_FLEET), []);

    expect(screen.getByText(EMPTY_FLEET_MESSAGE)).toBeDefined();
    expect(container.querySelector('svg')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Aggregation range' })).toBeNull();
    expect(container.querySelector('.fleet-panel-hint')).toBeNull();
  });

  it('explains a fleet with sites but no forecast hours', async () => {
    const container = await renderSettled(new CountingFleetSource(FORECASTLESS_FLEET));

    expect(screen.getByText('No fleet forecast available yet')).toBeDefined();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('frames the source failure with the surface that failed, and retries on request', async () => {
    const dataSource = new CountingFleetSource(FAILED_FLEET);
    await renderSettled(dataSource);

    expect(screen.getByRole('alert').textContent).toContain(
      'Could not load the fleet forecast: fleetForecasts range=24: upstream timed out',
    );
    expect(dataSource.forecastCallCount).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => {
      expect(dataSource.forecastCallCount).toBe(2);
    });
  });
});

describe('FleetPanel as the column keeps it mounted', () => {
  it('re-sums the fleet when the dashboard bumps the refresh token', async () => {
    const dataSource = new CountingFleetSource(FULL_FLEET);
    const { rerender } = render(panel(dataSource, false));
    await settle();

    expect(dataSource.forecastCallCount).toBe(1);

    rerender(panel(dataSource, false, 1));

    await waitFor(() => {
      expect(dataSource.forecastCallCount).toBe(2);
    });
  });

  it('empties itself while hidden, and comes back without refetching', async () => {
    const dataSource = new CountingFleetSource(FULL_FLEET);
    const { container, rerender } = render(panel(dataSource, false));
    await settle();

    expect(dataSource.forecastCallCount).toBe(1);

    rerender(panel(dataSource, true));

    expect(container.querySelector('.fleet-panel')?.hasAttribute('hidden')).toBe(true);
    // The children leave the tree with the reveal, not just the paint: an alert that mounts
    // inside `display: none` never announces, and the reveal is an attribute change no screen
    // reader reads as one (#161). The state that matters is in the hooks, not the markup.
    expect(container.querySelector('svg')).toBeNull();

    rerender(panel(dataSource, false));

    expect(container.querySelector('.fleet-panel')?.hasAttribute('hidden')).toBe(false);
    // Back on screen from the aggregate the hooks held throughout — the source was asked once.
    expect(container.querySelector('svg')).not.toBeNull();
    expect(dataSource.forecastCallCount).toBe(1);
  });

  it('drops a failure alert out of the DOM while hidden, rather than hiding it in place', async () => {
    const dataSource = new CountingFleetSource(FAILED_FLEET);
    const { rerender } = render(panel(dataSource, false));
    await settle();

    expect(screen.getByRole('alert').textContent).toContain('Could not load the fleet forecast');

    rerender(panel(dataSource, true));

    // `hidden: true` puts elements excluded from the accessibility tree back in scope for the
    // query, so null here means *absent*, not merely inert. An alert left in the DOM through the
    // hide is an alert the eventual reveal cannot announce.
    expect(screen.queryByRole('alert', { hidden: true })).toBeNull();
  });

  it('mounts the failure alert fresh on re-reveal, from the answer it got while hidden', async () => {
    const dataSource = new CountingFleetSource(FAILED_FLEET);
    const { rerender } = render(panel(dataSource, false));
    // Revealed once, so the fan-out is spent and the failure is on screen. A panel that has never
    // been revealed asks nothing at all (#178) — `FleetPanel.reveal.test.tsx` holds that half.
    await settle();

    rerender(panel(dataSource, true));
    rerender(panel(dataSource, true, 1));

    // Once revealed, a refresh token still re-sums while hidden: the reveal is what buys the first
    // request, not a condition on every later one.
    await waitFor(() => {
      expect(dataSource.forecastCallCount).toBe(2);
    });
    expect(screen.queryByRole('alert', { hidden: true })).toBeNull();

    // The token stays at 1 through the reveal: the dashboard's token is a count of created sites,
    // so it never goes backwards, and re-rendering with the default 0 here would be a key change —
    // a third request that says nothing about revealing.
    rerender(panel(dataSource, false, 1));

    // A first mount into a tree that is already on screen — which is the one arrangement in which
    // `role="alert"` actually announces.
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Could not load the fleet forecast: fleetForecasts range=24: upstream timed out',
    );
    expect(dataSource.forecastCallCount).toBe(2);
  });

  it('credits Open-Meteo nowhere inside itself — the column footer owns that credit', async () => {
    await renderSettled(new CountingFleetSource(FULL_FLEET));

    expect(screen.queryByRole('link', { name: 'Open-Meteo.com' })).toBeNull();
  });
});
