// @vitest-environment jsdom

import type { Site } from '@cumulo/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { DemoFleetDataSource } from '../data/demo-fleet-data-source';
import { FleetPanel } from './FleetPanel';
import {
  ACTUALS_FAILED_FLEET,
  CountingFleetSource,
  DISJOINT_WINDOW_FLEET,
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
  SIMULATED_ACTUALS_CAPABILITIES,
  SITE_A,
  type StubFleet,
} from './fleet-panel-test-fixture';
import { EMPTY_FLEET_MESSAGE } from './state-copy';

/*
 * What the fleet panel says about the fleet.
 *
 * Two of its other subjects have suites of their own, both split off when this
 * file reached the 300-line ceiling (`structure.md` rule 4). What a *selected
 * site* adds to the same chart is `FleetPanel.overlay.test.tsx`'s. The panel's
 * own furniture — one heading row, one (i), and one chart present in every
 * state — is `FleetPanel.structure.test.tsx`'s. All three share
 * `fleet-panel-test-fixture.tsx`, which is where the canned fleets and the two
 * lines every test writes to get a panel on screen live.
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

/**
 * The forecast is *plotted* — not merely a figure on screen.
 *
 * `container.querySelector('svg')` stood at each of these sites, and since #284
 * D3 it proves nothing: the figure is rendered in every state the panel has,
 * loading and failed included, so the query is true by construction and passes
 * over exactly the defect it was written to catch. The median path is the
 * part that exists only once the fleet read has summed to hours worth stroking,
 * which is what each of these cases means when it says the chart survived. The
 * figure's mere presence has an owner — `FleetPanel.structure.test.tsx`, whose
 * whole subject it is — so restating it here bought a second copy of a weaker
 * claim.
 *
 * One helper rather than the same line three times: the three sites have one
 * intent, so a change to what counts as "plotted" must reach all of them
 * (`structure.md` rule 7).
 *
 * Scoped to the plot's own children, because the legend draws a swatch in the
 * same class and an unscoped sweep would find the key rather than the line —
 * the same scoping the forecast-failure case relies on to assert the *absence*,
 * which is this assertion's positive control and its mirror image.
 */
const expectForecastPlotted = (container: HTMLElement): void => {
  expect(container.querySelectorAll('.forecast-chart > .forecast-chart-median')).not.toHaveLength(
    0,
  );
};

describe('FleetPanel against a source with the full fleet-level capabilities', () => {
  it('offers the aggregation range and promises simulated actuals, against the demo source', async () => {
    const dataSource = new DemoFleetDataSource();
    const sites = await demoFleet(dataSource);
    const container = await renderSettled(dataSource, sites);

    expect(screen.getByRole('group', { name: 'Aggregation range' })).toBeDefined();

    openTip('About this chart');

    expect(screen.getByText(/summed hour by hour/u).textContent).toContain('simulated actuals');
    // The canonical demo fleet is 60 sites; the kW figure is asserted by shape rather than by
    // value, because restating the sum here would only prove that two copies of it agree.
    expect(container.querySelector('.fleet-panel-stats')?.textContent).toMatch(
      /^60 sites · \d+(\.\d)? kW installed$/u,
    );
    expectForecastPlotted(container);
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
    // "Partial" is a caption on an aggregate that arrived, so the hours it is
    // short of a site are still drawn — which is the half a bare figure check
    // could not tell from a fleet read that returned nothing at all.
    expectForecastPlotted(container);
  });

  it('sums the fleet into the chart, hour by hour: median, band bounds and actuals', async () => {
    await renderSettled(new CountingFleetSource(FULL_FLEET));

    const table = screen.getByRole('table', {
      name: 'Table view — fleet forecast and simulated actuals, 24 h range, kW',
    });

    /*
     * The table twin is where the plotted numbers are readable as text, so it is where the
     * aggregate can be pinned; the SVG carries the same values as coordinates nobody can assert
     * on without re-deriving the geometry.
     *
     * Every figure below is the fixture's own arithmetic, stated rather than computed: at 06:00
     * the two sites forecast 2 and 4 kW (median 6), their bands are 1–3 and 3–6 (P10 4, P90 9 —
     * comonotonic addition, `@cumulo/shared`'s rule, not this panel's), and their actuals are 1.5
     * and 3.5 (5). 07:00 has no readings at all, so its actuals cell is the em dash a gap reads
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

  it('never says "simulated actuals" — not in prose, not in the chart\'s accessible name', async () => {
    const container = await renderSettled(horizonSource());

    // The tip opened first, and that is what keeps this assertion biting: the
    // sentence it carries is not in the document while it is shut, so a sweep of
    // `innerHTML` over a closed panel would pass without having looked at the
    // copy this case is about.
    openTip('About this chart');

    // innerHTML rather than textContent on purpose: an aria-label is copy too, and it is the copy
    // most easily left promising data the source cannot produce. The phrase's positive control is
    // the suite below, which finds it with the capability on — so an empty match here is the
    // gating working rather than a phrase nothing ever says.
    expect(container.innerHTML.toLowerCase()).not.toContain('simulated actuals');
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

/*
 * The combination #264 makes reachable, and the reason this suite exists at all.
 * The forecast service synthesises fleet actuals now, so the live source carries
 * them while its forecast read still reaches forward only. No source was ever in that
 * state before, and the copy that covered it named "next 24 h" over a plot that
 * now also carries the hours behind the horizon.
 *
 * This arm *does* carry a range picker, which is what #284 D5 changed and what
 * this docblock used to deny: the control is gated on `fleetLookback ||
 * fleetActuals` rather than on look-back alone, because with simulated actuals a
 * wider window buys both more measured hours behind the horizon and more
 * forecast hours ahead of it. `FleetPanel.tsx`'s docblock owns that reasoning
 * and `FleetPanel.structure.test.tsx` asserts the picker and the re-ask pressing
 * it triggers; what this suite owns is the copy that combination produces.
 */
describe('FleetPanel against a source with simulated actuals but no look-back', () => {
  /*
   * Over the *live* shape, always. This suite's whole subject is the combination
   * only the deployed source is in, and against a fixture whose two windows
   * overlap it would prove nothing about that source: the defect #264's review
   * found — every simulated actual dropped, because the join made the forecast
   * the x-domain — is invisible unless the two windows are disjoint.
   */
  const liveSource = (): CountingFleetSource =>
    new CountingFleetSource(DISJOINT_WINDOW_FLEET, SIMULATED_ACTUALS_CAPABILITIES);

  it('keeps disjoint-window actuals on the chart, past hours before the forecast’s', async () => {
    const container = await renderSettled(liveSource());

    const table = screen.getByRole('table', {
      name: 'Table view — fleet forecast and simulated actuals, past 24 h and the forecast ahead, kW',
    });

    /*
     * The fixture's own arithmetic, stated rather than computed. 10:00 and 11:00 were measured and
     * never forecast (1.5+3.5, then 2+4); 12:00 and 13:00 were forecast and not yet measured
     * (medians 2+4 and 3+5, bands added comonotonically by `@cumulo/shared`). Every row therefore
     * has an em dash on exactly one side, and the two measured rows existing *at all* is the
     * assertion the pre-fix join fails — it returned the last two rows and nothing else.
     */
    expect(within(table).getAllByRole('row').map(rowCells)).toEqual([
      ['Time (UTC)', 'P10', 'Median', 'P90', 'Actual'],
      ['10:00', '—', '—', '—', '5.0'],
      ['11:00', '—', '—', '—', '6.0'],
      ['12:00', '4.0', '6.0', '9.0', '—'],
      ['13:00', '6.0', '8.0', '11.0', '—'],
    ]);
    // And both series are genuinely drawn, not merely tabulated: each is one run of two hours, so
    // each is one path. A chart that dropped the actuals would still render the table above if
    // the drop happened downstream of the join.
    expect(container.querySelectorAll('.forecast-chart > .forecast-chart-actuals')).toHaveLength(1);
    expect(container.querySelectorAll('.forecast-chart > .forecast-chart-median')).toHaveLength(1);
  });

  it('names both halves of the window it draws, in the chart’s own two names', async () => {
    await renderSettled(liveSource());

    // Written out rather than imported from `fleet-panel-copy.ts`: a test that
    // reads the constant it checks asserts nothing about the wording, and would
    // follow a silent rewrite straight past the reader the words are for.
    //
    // The forecast half is named without an hour count, and that is the claim
    // worth pinning: the fleet read asks for the chosen window but serves only the
    // hours ahead of the clock, so a label promising a number of forecast hours
    // would be the chart describing a window it was never given.
    expect(screen.getByRole('img', { name: /Fleet forecast/u }).getAttribute('aria-label')).toBe(
      'Fleet forecast and simulated actuals, past 24 h and the forecast ahead',
    );
  });
});

/*
 * Two reads, two windows, two requests — so either can fail alone, and what the panel does about
 * it is not symmetrical. The forecast is the answer; the actuals are an addition to it, and one
 * that costs a single metered request — as, since #296, the forecast does too. Before #264's
 * review both failures came out of one `combineFleetQueries` arm: a failed actuals read withdrew
 * a fleet sum that had arrived and reported it as "Could not load the fleet forecast", and its
 * "Try again" re-spent the 60-site fan-out the forecast read then was, to re-ask one request that
 * had never been the fleet's.
 */
describe('FleetPanel when the fleet’s actuals fail on their own', () => {
  const actualsFailurePattern = /simulated actuals could not be loaded/u;

  it('keeps the forecast chart and names the actuals, rather than blaming the forecast', async () => {
    const container = await renderSettled(new CountingFleetSource(ACTUALS_FAILED_FLEET));

    // The chart the reader already had is still on screen *with its numbers on it*, and the
    // forecast — which did not fail — is not named as the thing that did. The plotted median is
    // the load-bearing half: it is exactly what the forecast-failure case below asserts the
    // absence of, so the two cases now differ in the plot rather than in a figure both states have.
    expectForecastPlotted(container);
    expect(container.textContent).not.toContain('Could not load the fleet forecast');
    expect(screen.queryByRole('alert')).toBeNull();

    const notice = screen.getByText(actualsFailurePattern);

    // A notice, not an alert, for the reason the overlay's is: this panel's one live-region budget
    // belongs to the chart's readout, and a partial answer is a caption on the answer.
    expect(notice.className).toBe('panel-notice');
  });

  it('re-asks only the actuals request, never the fleet’s forecast read beside it', async () => {
    const dataSource = new CountingFleetSource(ACTUALS_FAILED_FLEET);
    await renderSettled(dataSource);
    await screen.findByText(actualsFailurePattern);

    expect(dataSource.forecastCallCount).toBe(1);
    expect(dataSource.actualsCallCount).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => {
      expect(dataSource.actualsCallCount).toBe(2);
    });
    // The assertion that catches a shared attempt counter: a recourse offered for one missing
    // series must not silently re-ask the other one, which arrived.
    expect(dataSource.forecastCallCount).toBe(1);
  });

  it('still empties the chart when it is the forecast that failed', async () => {
    /*
     * The other half of the asymmetry, stated here beside it rather than left to be inferred from
     * the failure suite below. An actuals failure is a caption on numbers that arrived; a forecast
     * failure is the numbers themselves not arriving — and since #284 D3 the difference shows in
     * the plot rather than in whether there is a plot. The figure stays put in every state, so
     * what a failed fleet read takes away is every row of it.
     */
    const container = await renderSettled(new CountingFleetSource(FAILED_FLEET));
    const table = screen.getByRole('table', { name: /Table view/u });

    expect(within(table).getAllByRole('row').map(rowCells)).toEqual([
      ['Time (UTC)', 'P10', 'Median', 'P90', 'Actual'],
    ]);
    // Scoped to the plot's own children: the legend draws a swatch in the same
    // class, so an unscoped sweep would find the key rather than the line.
    expect(container.querySelector('.forecast-chart > .forecast-chart-median')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('Could not load the fleet forecast');
    expect(screen.queryByText(actualsFailurePattern)).toBeNull();
  });
});

describe('FleetPanel with nothing to show', () => {
  it('makes an empty fleet the invitation, without rearranging the panel around it', async () => {
    await renderSettled(new CountingFleetSource(FULL_FLEET), []);

    expect(screen.getByText(EMPTY_FLEET_MESSAGE)).toBeDefined();
    // The heading row is what it is in every other state, picker included. A
    // control that materialises when the first site lands is the reading
    // rearranging itself under a reader who was already looking at it (#284
    // D3/D5) — and an empty fleet still asks the source nothing, because the
    // queries are gated on having sites rather than on having a picker.
    expect(screen.getByRole('group', { name: 'Aggregation range' })).toBeDefined();
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

  it('explains a fleet with sites but neither forecast hours nor measured ones', async () => {
    await renderSettled(new CountingFleetSource(FORECASTLESS_FLEET));

    // Both reads are empty in this fixture, and that is what "nothing to show" means since the
    // chart's x-domain became the union of the two (#290). The half-empty case — no forecast,
    // actuals present — belongs to `FleetPanel.structure.test.tsx`, and must *not* reach this
    // sentence: it has hours to draw.
    expect(screen.getByText('No fleet forecast available yet')).toBeDefined();
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
     * defer its first fleet read until it was first revealed, because a `?site=` deep link could
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
    // on a deep link: the listing is briefly in flight with no sites, and a fleet read fired then
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
