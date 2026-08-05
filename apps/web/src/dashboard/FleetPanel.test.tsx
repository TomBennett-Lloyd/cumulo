// @vitest-environment jsdom

import type { Site } from '@cumulo/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { DemoFleetDataSource } from '../data/demo-fleet-data-source';
import { FleetPanel } from './FleetPanel';
import {
  CountingFleetSource,
  FAILED_FLEET,
  FORECASTLESS_FLEET,
  FULL_FLEET,
  HORIZON_ONLY_CAPABILITIES,
  NO_SELECTION,
  OVERLAYLESS_FLEET,
  PARTIAL_FLEET,
  panel,
  renderSettled,
  settle,
  SITE_A,
  SITE_A_PENDING,
  SITE_A_SELECTED,
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
      ['Time (UTC)', 'P10', 'Median', 'P90', 'Actual'],
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
  });

  it('leaves the add-a-site invitation to the map, in every fleet state', async () => {
    // The panel used to carry a paragraph of instructions beside its chart. The
    // map's own labelled control replaced it (#265), and this is what stops a
    // second copy of that prose growing back here — the map is where the reader
    // is looking when they place a site, and one instruction is enough.
    const withSites = await renderSettled(new CountingFleetSource(FULL_FLEET));

    expect(withSites.querySelector('.fleet-panel-hint')).toBeNull();
    expect(withSites.textContent).not.toContain('anywhere on the map');

    cleanup();
    const empty = await renderSettled(new CountingFleetSource(FULL_FLEET), []);

    // The empty fleet keeps *an* invitation — it is the demo's opening line —
    // and it names the control rather than a bare click, which is the thing the
    // control changed about what a click does.
    expect(empty.textContent).toContain('press “Add a site” on the map');
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

describe('FleetPanel as the page keeps it mounted', () => {
  it('re-sums the fleet when the dashboard bumps the refresh token', async () => {
    const dataSource = new CountingFleetSource(FULL_FLEET);
    const { rerender } = render(panel(dataSource));
    await settle();

    expect(dataSource.forecastCallCount).toBe(1);

    rerender(panel(dataSource, NO_SELECTION, 1));

    await waitFor(() => {
      expect(dataSource.forecastCallCount).toBe(2);
    });
  });

  it('sums the fleet on mount, without waiting to be looked at', async () => {
    /*
     * The trade #265 accepted, pinned as a fact rather than left as prose. The panel used to
     * defer its first fan-out until it was first revealed, because a `?site=` deep link could
     * leave it hidden forever (#178). Nothing hides it now — it is on screen in every state of
     * the page — so a deferral would only buy a spinner in front of a chart the reader is
     * already looking at.
     */
    const dataSource = new CountingFleetSource(FULL_FLEET);
    render(panel(dataSource));

    await waitFor(() => {
      expect(dataSource.forecastCallCount).toBe(1);
    });
    expect(dataSource.actualsCallCount).toBe(1);
  });

  it('asks nothing at all of a fleet with no sites in it', async () => {
    // The other half of the gate that survived the reveal latch, and the one that still matters
    // on a deep link: the listing is briefly in flight with no sites, and a fan-out fired then
    // would be a sum of nothing followed straight away by a real one.
    const dataSource = new CountingFleetSource(FULL_FLEET);
    render(
      <FleetPanel
        dataSource={dataSource}
        sites={[]}
        selectedSite={null}
        selectionReady={false}
        refreshToken={0}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(EMPTY_FLEET_MESSAGE)).toBeDefined();
    });
    expect(dataSource.forecastCallCount).toBe(0);
    expect(dataSource.actualsCallCount).toBe(0);
  });

  it('reports a failed sum in an alert that mounts into a tree already on screen', async () => {
    const dataSource = new CountingFleetSource(FAILED_FLEET);
    render(panel(dataSource));

    // A first mount into a tree that is already on screen — which is the one arrangement in which
    // `role="alert"` actually announces (#161). It is the only arrangement left: the panel is
    // never hidden, so an alert can no longer mount inside a `display: none` subtree that
    // assistive technology never reads.
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Could not load the fleet forecast: fleetForecasts range=24: upstream timed out',
    );
    expect(dataSource.forecastCallCount).toBe(1);
  });

  it('credits Open-Meteo nowhere inside itself — the page footer owns that credit', async () => {
    await renderSettled(new CountingFleetSource(FULL_FLEET));

    expect(screen.queryByRole('link', { name: 'Open-Meteo.com' })).toBeNull();
  });
});

/*
 * The selected site, drawn over the fleet it is part of.
 *
 * Asserted through the chart's table twin, which is where the plotted numbers are readable as
 * text; the SVG carries the same values as coordinates nobody can assert on without re-deriving
 * the geometry. The overlay's own arithmetic — which forecast becomes which point — is
 * `site-overlay.test.ts`'s, and the join onto the fleet's hours is `chart-series.test.ts`'s. What
 * is left for this suite is the panel's part: when the request is spent, what it is asked for,
 * and whether the answer reaches the chart.
 */
describe('FleetPanel with a site selected', () => {
  const overlayHeader = (): HTMLElement | null =>
    screen.queryByRole('columnheader', { name: SITE_A.name });

  it('draws no overlay, and asks for nothing, while nothing is selected', async () => {
    const dataSource = new CountingFleetSource(FULL_FLEET);
    await renderSettled(dataSource);

    // The paired positive control for this negative is the case below, which finds the column
    // with the same query — so a null here is an absent column, not a query that never matches.
    expect(overlayHeader()).toBeNull();
    expect(dataSource.siteForecastRequests).toEqual([]);
  });

  it('asks for the selected site over the same window as the sum, once its forecast exists', async () => {
    const dataSource = new CountingFleetSource(FULL_FLEET);
    render(panel(dataSource, SITE_A_SELECTED));
    await settle();

    await waitFor(() => {
      expect(overlayHeader()).not.toBeNull();
    });
    expect(dataSource.siteForecastRequests).toEqual([`${SITE_A.id}@24`]);
  });

  it('puts the site’s own kW beside the fleet’s in the table, hour for hour', async () => {
    render(panel(new CountingFleetSource(FULL_FLEET), SITE_A_SELECTED));
    await settle();

    const table = await screen.findByRole('table', {
      name: 'Table view — fleet forecast and measured output, 24 h range, kW',
    });

    /*
     * The fixture's own arithmetic, stated rather than computed. Site A forecasts 2 and 3 kW at
     * 06:00 and 07:00; the fleet's medians at those hours are 6 and 8, because site B contributes
     * 4 and 5. The site's column being *under* the fleet's median in both rows is what says the
     * overlay is a component of the sum rather than a second copy of it.
     */
    await waitFor(() => {
      expect(within(table).getAllByRole('row').map(rowCells)).toEqual([
        ['Time (UTC)', 'P10', 'Median', 'P90', 'Actual', SITE_A.name],
        ['06:00', '4.0', '6.0', '9.0', '5.0', '2.0'],
        ['07:00', '6.0', '8.0', '11.0', '—', '3.0'],
      ]);
    });
  });

  it('names the site in the chart’s legend, since a mark’s colour never names it alone', async () => {
    const { container } = render(panel(new CountingFleetSource(FULL_FLEET), SITE_A_SELECTED));
    await settle();

    // Scoped to the legend rather than swept for across the figure: the site's
    // name is also the table's column header, and a document-wide text query
    // would go green on that alone — leaving the plot with an unnamed mark on it.
    await waitFor(() => {
      expect(container.querySelector('.forecast-chart-legend')?.textContent).toContain(SITE_A.name);
    });
  });

  it('spends nothing on a site whose first forecast has not arrived yet', async () => {
    /*
     * `selectionReady` is the dashboard's poll as a boolean, and it gates the *request*. A site
     * created seconds ago has no forecast at all; asking its window on every render would spend
     * metered requests to be told what the poll is already asking.
     */
    const dataSource = new CountingFleetSource(FULL_FLEET);
    render(panel(dataSource, SITE_A_PENDING));
    await settle();

    expect(dataSource.siteForecastRequests).toEqual([]);
    expect(overlayHeader()).toBeNull();
  });

  it('draws the fleet unchanged when the site’s own hours fail to load', async () => {
    /*
     * The overlay is an addition, not a precondition. A fleet sum that vanished because a second,
     * optional series failed would be the page losing the answer it already had — and there is no
     * alert either, because the reader has a recourse that works without one: deselecting, or
     * changing the range, re-asks.
     */
    render(panel(new CountingFleetSource(OVERLAYLESS_FLEET), SITE_A_SELECTED));
    await settle();

    expect(overlayHeader()).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(
      screen.getByRole('table', {
        name: 'Table view — fleet forecast and measured output, 24 h range, kW',
      }),
    ).toBeDefined();
  });

  it('drops a superseded site’s answer instead of letting it land on the chart', async () => {
    const dataSource = new CountingFleetSource(FULL_FLEET);
    const { rerender } = render(panel(dataSource, SITE_A_SELECTED));
    await settle();
    await waitFor(() => {
      expect(overlayHeader()).not.toBeNull();
    });

    rerender(panel(dataSource, NO_SELECTION));

    // The selection is part of the query key, so deselecting is a key change and the previous
    // site's column goes with it rather than sitting on the chart naming a site nobody selected.
    await waitFor(() => {
      expect(overlayHeader()).toBeNull();
    });
  });
});
