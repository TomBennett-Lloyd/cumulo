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
      name: 'Table view — fleet forecast and simulated actuals, 24 h range, kW',
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
        name: 'Table view — fleet forecast and simulated actuals, 24 h range, kW',
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

    // Site B forecasts 4 and 5 kW at these hours where site A forecast 2 and 3. The fleet's own
    // columns are unchanged, which is the other half of "a selection redraws one line, not the
    // chart".
    const table = screen.getByRole('table', {
      name: 'Table view — fleet forecast and simulated actuals, 24 h range, kW',
    });

    await waitFor(() => {
      expect(within(table).getAllByRole('row').map(rowCells)).toEqual([
        ['Time (UTC)', 'P10', 'Median', 'P90', 'Actual', SITE_B.name],
        ['06:00', '4.0', '6.0', '9.0', '5.0', '4.0'],
        ['07:00', '6.0', '8.0', '11.0', '—', '5.0'],
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
