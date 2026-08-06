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
  PARTIAL_FLEET,
  panel,
  renderSettled,
  rowCells,
  settle,
  SITE_A,
  type StubFleet,
} from './fleet-panel-test-fixture';
import { EMPTY_FLEET_MESSAGE } from './state-copy';

/*
 * What the fleet panel says about the fleet.
 *
 * Its other subject — what a *selected site* adds to the same chart — is
 * `FleetPanel.overlay.test.tsx`, split off when this file reached the 300-line
 * ceiling (`structure.md` rule 4) with the overlay's failure and retry cases
 * still to write. The two suites share `fleet-panel-test-fixture.tsx`, which is
 * where the canned fleet and the two lines every test writes to get a panel on
 * screen live.
 */

// Vitest runs without global test hooks, so Testing Library's automatic cleanup never registers
// itself — every render has to be torn down explicitly or later queries match two panels.
afterEach(cleanup);

/**
 * Press an (i), the way a reader asks a surface to explain itself.
 *
 * The panel's descriptions live behind toggletips since #265
 * (`info/InfoTip.tsx`), and their content is mounted only while one is open — so
 * a case about what the panel *says* has to ask first. Named by the button's
 * accessible name rather than by a class, because that name is the contract a
 * reader has with the control.
 */
const openTip = (label: string): void => {
  fireEvent.click(screen.getByRole('button', { name: label }));
};

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

    openTip('About this chart');

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

  it('withholds the range control and names the horizon when asked', async () => {
    const container = await renderSettled(horizonSource());

    expect(screen.queryByRole('group', { name: 'Aggregation range' })).toBeNull();

    // The caption is a description, so it sits behind an (i) like the panel's
    // other prose (#265); the control on the other arm of the same conditional
    // stays inline, because an affordance nobody can see is one nobody uses.
    openTip('About this window');

    expect(container.querySelector('.info-tip-panel')?.textContent).toBe(
      'Forecast horizon: next 24 hours',
    );
  });

  it('never says the word "measured" — not in prose, not in the chart\'s accessible name', async () => {
    const container = await renderSettled(horizonSource());

    // Both tips opened first, and that is what keeps this assertion biting: the
    // sentences they carry are not in the document while they are shut, so a
    // sweep of `innerHTML` over a closed panel would pass without having looked
    // at the copy this case is about.
    openTip('About this chart');
    openTip('About this window');

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
