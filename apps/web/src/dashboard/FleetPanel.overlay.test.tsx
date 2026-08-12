// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CountingFleetSource,
  FULL_FLEET,
  NO_SELECTION,
  OVERLAYLESS_FLEET,
  panel,
  renderSettled,
  rowCells,
  settle,
  SITE_A,
  SITE_A_PENDING,
  SITE_A_SELECTED,
  SITE_B,
  SITE_B_SELECTED,
} from './fleet-panel-test-fixture';

// Vitest runs without global test hooks, so Testing Library's automatic cleanup never registers
// itself — every render has to be torn down explicitly or later queries match two panels.
afterEach(cleanup);

/*
 * The selected site, drawn over the fleet it is part of.
 *
 * Asserted through the chart's table twin, which is where the plotted numbers are readable as
 * text; the SVG carries the same values as coordinates nobody can assert on without re-deriving
 * the geometry. The overlay's own arithmetic — which forecast becomes which point — is
 * `site-overlay.test.ts`'s, and the join onto the fleet's hours is `chart-series.test.ts`'s. What
 * is left for this suite is the panel's part: when the request is spent, what it is asked for,
 * and whether the answer reaches the chart.
 *
 * **Every case here selects a site, so every case here is in percent of capacity** (#291). That is
 * not a fixture detail this suite works around — it is the reason the overlay exists at all: a
 * ~4 kW roof against a ~330 kW fleet is a flat line on an absolute axis, so a selection switches
 * the panel to the unit both curves are comparable in (`chart-unit.ts`). The captions below end
 * `% of capacity` and the rows are percentages for exactly that reason, and a suite that pinned
 * kW here would be pinning a state a reader never sees with a site selected. What the toggle
 * *does* — the auto-switch, a manual choice outranking it, the revert on deselect — is
 * `FleetPanel.unit-toggle.test.tsx`'s subject; this suite only has to be in the unit the panel
 * puts it in.
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

  it('puts the site’s own output beside the fleet’s in the table, hour for hour', async () => {
    render(panel(new CountingFleetSource(FULL_FLEET), SITE_A_SELECTED));
    await settle();

    const table = await screen.findByRole('table', {
      name: 'Table view — fleet forecast and simulated actuals, 24 h range, % of capacity',
    });

    /*
     * The fixture's own arithmetic, stated rather than computed, and in the unit a selection puts
     * the panel in. Both sites are 4 kW, so the fleet's divisor is 8 kW at both hours and the
     * site's own is 4.
     *
     * At 06:00 the fleet forecasts 2 + 4 = 6 kW (75.0%), its band is 1+3 = 4 (50.0%) to 3+6 = 9
     * (112.5%), and its measured hour is 1.5 + 3.5 = 5 kW (62.5%); site A's own 2 kW is half its
     * own nameplate (50.0%). At 07:00 the fleet forecasts 3 + 5 = 8 kW (100.0%), band 2+4 = 6
     * (75.0%) to 4+7 = 11 (137.5%), no measured hour at all, and site A's 3 kW is 75.0% of its
     * own.
     *
     * **The 112.5 and the 137.5 are the no-clamping rule visible in a suite.** A fleet outrunning
     * the nameplate its inverters are rated at is a real reading, and flattening it to 100 would
     * hide exactly the hour worth looking at (`fleet-series.ts` owns that rule; this is where it
     * shows up as a number).
     *
     * The site's column being *under* the fleet's median at 06:00 and equal to neither at 07:00
     * is the same claim the kW rows used to make, and it survives the unit change: the two
     * divisors differ, so a site at 75% of its own roof under a fleet at 100% of its own is still
     * the overlay being a component of the sum rather than a second copy of it.
     */
    await waitFor(() => {
      expect(within(table).getAllByRole('row').map(rowCells)).toEqual([
        ['Time (UTC)', 'P10', 'Median', 'P90', 'Actual', SITE_A.name],
        ['06:00', '50.0', '75.0', '112.5', '62.5', '50.0'],
        ['07:00', '75.0', '100.0', '137.5', '—', '75.0'],
      ]);
    });
  });

  it('names the site in the chart’s legend, since a mark’s colour never names it alone', async () => {
    const { container } = render(panel(new CountingFleetSource(FULL_FLEET), SITE_A_SELECTED));
    await settle();

    /*
     * Behind the (i) since 2026-08-11 (#429), so the press is part of the claim:
     * the legend is mounted only while the tip is open, and the reader reaches
     * the site's name by asking for it. Pressed after `settle`, because what is
     * asserted is the legend the *arrived* overlay produced — a tip opened
     * before it would have to be re-opened to see one.
     */
    fireEvent.click(screen.getByRole('button', { name: 'About this chart' }));

    // Scoped to the legend rather than swept for across the panel: the site's
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

  it('says which line is missing when the site’s own hours fail, and keeps the fleet', async () => {
    /*
     * Partial results are labelled partial (`error-handling.md` rule 5). The overlay is an
     * addition, not a precondition — a fleet sum that vanished because a second, optional series
     * failed would be the page losing the answer it already had — but an addition that fails
     * silently is indistinguishable from a site that simply tracks the fleet, which is the exact
     * dishonesty that rule refuses.
     */
    render(panel(new CountingFleetSource(OVERLAYLESS_FLEET), SITE_A_SELECTED));
    await settle();

    const notice = await screen.findByText(new RegExp(`${SITE_A.name}.+could not be loaded`, 'u'));

    expect(notice.className).toBe('panel-notice');
    // A notice, not an alert: this panel's one live-region budget belongs to the chart's readout,
    // which announces the sample a reader asked for (`react.md`). An incomplete answer is a
    // caption on the answer rather than an event.
    expect(screen.queryByRole('alert')).toBeNull();
    // And the fleet is still drawn, with no column for the line that never came.
    expect(overlayHeader()).toBeNull();
    expect(
      screen.getByRole('table', {
        name: 'Table view — fleet forecast and simulated actuals, 24 h range, % of capacity',
      }),
    ).toBeDefined();
  });

  it('re-asks for just the failed site’s hours, without re-summing the fleet', async () => {
    /*
     * The recourse the notice owes. Re-asking genuinely can work here — this is one request for
     * one site, which is what `react.md` sets as the test for offering a retry at all — and the
     * counter it bumps is the overlay's own, so pressing it must not re-spend the fleet's own
     * forecast read. That second assertion is the one that would catch a shared counter.
     */
    const dataSource = new CountingFleetSource(OVERLAYLESS_FLEET);
    render(panel(dataSource, SITE_A_SELECTED));
    await settle();
    await screen.findByText(new RegExp(`${SITE_A.name}.+could not be loaded`, 'u'));

    expect(dataSource.siteForecastRequests).toEqual([`${SITE_A.id}@24`]);
    expect(dataSource.forecastCallCount).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => {
      expect(dataSource.siteForecastRequests).toEqual([`${SITE_A.id}@24`, `${SITE_A.id}@24`]);
    });
    expect(dataSource.forecastCallCount).toBe(1);
  });

  it('drops a superseded site’s answer instead of letting it land under the next site’s name', async () => {
    /*
     * The site is part of the query key, and this is what that member buys. Without it, moving the
     * selection from one site to the next is not a key change: `useFleetQuery` never re-runs, the
     * previous site's hours stay in state, and the *label* — which comes from the prop, not from
     * the answer — flips to the new site. The chart would then draw site A's forecast, in the
     * legend and the table, under site B's name. Nothing about that is visibly broken, which is
     * exactly why it needs a test.
     *
     * Both halves are asserted because either alone is satisfiable by the bug: the request log
     * says a second question was actually asked, and the numbers say the answer that reached the
     * chart is the second site's. The two sites' hours differ in the fixture precisely so the
     * second assertion can tell them apart.
     */
    const dataSource = new CountingFleetSource(FULL_FLEET);
    const { rerender } = render(panel(dataSource, SITE_A_SELECTED));
    await settle();
    await waitFor(() => {
      expect(overlayHeader()).not.toBeNull();
    });

    rerender(panel(dataSource, SITE_B_SELECTED));

    await waitFor(() => {
      expect(screen.queryByRole('columnheader', { name: SITE_B.name })).not.toBeNull();
    });
    expect(dataSource.siteForecastRequests).toEqual([`${SITE_A.id}@24`, `${SITE_B.id}@24`]);

    // Site B forecasts 4 and 5 kW at these hours where site A forecast 2 and 3 — 100.0% and
    // 125.0% of its own 4 kW roof, where site A read 50.0 and 75.0. The fleet's own columns are
    // unchanged, which is the other half of "a selection redraws one line, not the chart", and
    // the unit is unchanged too: a site-to-site move is one continuous selection episode, so no
    // second courtesy switch fires and nothing about the fleet's rows moves under it.
    const table = screen.getByRole('table', {
      name: 'Table view — fleet forecast and simulated actuals, 24 h range, % of capacity',
    });

    await waitFor(() => {
      expect(within(table).getAllByRole('row').map(rowCells)).toEqual([
        ['Time (UTC)', 'P10', 'Median', 'P90', 'Actual', SITE_B.name],
        ['06:00', '50.0', '75.0', '112.5', '62.5', '100.0'],
        ['07:00', '75.0', '100.0', '137.5', '—', '125.0'],
      ]);
    });
  });

  it('takes the column away again when the selection is cleared', async () => {
    const dataSource = new CountingFleetSource(FULL_FLEET);
    const { rerender } = render(panel(dataSource, SITE_A_SELECTED));
    await settle();
    await waitFor(() => {
      expect(overlayHeader()).not.toBeNull();
    });

    rerender(panel(dataSource, NO_SELECTION));

    // A chart still naming a site nobody has selected is a chart telling the reader they are
    // looking at something they closed.
    await waitFor(() => {
      expect(overlayHeader()).toBeNull();
    });
  });
});
