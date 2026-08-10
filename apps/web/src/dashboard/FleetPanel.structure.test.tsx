// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ACTUALS_ONLY_FLEET,
  CountingFleetSource,
  DISJOINT_WINDOW_FLEET,
  FAILED_FLEET,
  FORECASTLESS_FLEET,
  FULL_FLEET,
  HORIZON_ONLY_CAPABILITIES,
  panel,
  renderSettled,
  rowCells,
  settle,
  SIMULATED_ACTUALS_CAPABILITIES,
} from './fleet-panel-test-fixture';
import {
  EMPTY_FLEET_MESSAGE,
  LOADING_FLEET_FORECAST_LABEL,
  NO_FLEET_FORECAST_MESSAGE,
} from './state-copy';

/*
 * The shape of the fleet panel, as opposed to what it says.
 *
 * Split from `FleetPanel.test.tsx` when #284's restructure took that file past
 * the 300-line ceiling (`structure.md` rule 4), on the same subject line the
 * overlay suite was split on: that file owns the panel's *copy* — which window
 * the chart names, what is and is not said about simulated actuals — and this
 * one owns its furniture. One heading row holding everything the panel knows
 * about itself, one (i), a picker on every arm that has a window to choose, and
 * one chart present in every state the panel can be in.
 *
 * The messages below are imported from `state-copy.ts` rather than written out,
 * which is the opposite of what the copy suite does and for the same reason: a
 * case about structure should keep passing across a rewording, and a case about
 * wording must not. What is asserted here is that the sentence and the chart are
 * both on screen, not which sentence it is.
 */

afterEach(cleanup);

/** The heading row, as an element the queries can be scoped to. */
const fleetHeader = (container: HTMLElement): HTMLElement => {
  const header = container.querySelector('.fleet-panel-header');

  if (!(header instanceof HTMLElement)) {
    throw new Error('The fleet panel rendered no heading row at all.');
  }

  return header;
};

/**
 * The chart's figure, as an element the legend query can be scoped to.
 *
 * Exactly one, not "at least one" — a state that grew a second chart beside the
 * first would satisfy a presence check while doubling the tallest thing on the
 * page.
 */
const chartFigure = (container: HTMLElement): HTMLElement => {
  const figures = container.querySelectorAll('.forecast-chart-figure');

  expect(figures).toHaveLength(1);

  const [figure] = figures;

  if (!(figure instanceof HTMLElement)) {
    throw new Error('The fleet panel rendered no chart figure at all.');
  }

  return figure;
};

/**
 * The furniture every state owes the reader, whatever that state has to say.
 *
 * #284 D3 asks for three things in every state and not only for the figure: the
 * panel's heading, the chart, and the chart's legend. The figure alone is the
 * weakest of the three to assert, because the states that used to return *in
 * place of* the chart took the heading's siblings and the key down with it — and
 * a figure that came back without its legend reads as a plot of anonymous lines,
 * which is the regression this pair exists to catch.
 *
 * The heading is queried by role over the whole document rather than by class,
 * because what the criterion is about is a heading a reader can navigate to.
 *
 * The legend's entries are counted rather than read: *which* series it names is
 * copy, and this suite owns furniture (see the file header), so a rewording must
 * not fail here. Counting is what keeps an empty `<ul>` from satisfying a bare
 * presence check.
 *
 * **Two, not the three D3 was written against — deliberately, and this is the
 * clause reinterpreted rather than eroded.** #295 makes the band's legend row
 * conditional on the data: a series of point estimates gets no P10–P90 row,
 * because a legend naming a band nothing produced is the chart claiming an
 * uncertainty it does not have. That is mutually exclusive with a fixed count of
 * three, so D3's literal number could not survive the change whatever it did.
 * What D3 actually asked for does survive untouched, and is what is asserted
 * here: the chart's key is never taken away by a *state*. The two unconditional
 * rows — median and actuals — are the fixed set, and every state below is
 * band-less (nothing is selected, so there is no overlay row either, and none of
 * these fixtures carries a forecast with a band). A state that returned early
 * past the legend still fails here, which is the regression the clause exists
 * for; a series that honestly has no band no longer does.
 */
const expectPanelFurniture = (container: HTMLElement): void => {
  expect(screen.getByRole('heading', { name: 'Fleet forecast', level: 2 })).toBeDefined();

  const legend = within(chartFigure(container)).getByRole('list');

  expect(legend.className).toBe('forecast-chart-legend');
  expect(within(legend).getAllByRole('listitem')).toHaveLength(2);
};

/** The pair every state owes the reader: whatever it has to say, over the furniture. */
const expectChartWith = (container: HTMLElement, message: string | RegExp): void => {
  expect(screen.getByText(message)).toBeDefined();
  expectPanelFurniture(container);
};

describe('FleetPanel’s heading row', () => {
  it('holds the title, the fleet’s numbers, the description and the window control', async () => {
    const container = await renderSettled(new CountingFleetSource(FULL_FLEET));
    const header = fleetHeader(container);

    expect(within(header).getByRole('heading', { name: 'Fleet forecast', level: 2 })).toBeDefined();
    expect(within(header).getByRole('button', { name: 'About this chart' })).toBeDefined();
    expect(within(header).getByRole('group', { name: 'Aggregation range' })).toBeDefined();

    // Order, because the row reads left to right: the fleet's own numbers are
    // content and the (i) is an annotation on the heading beside them, so a tip
    // that drifted ahead of the numbers would put the aside before the fact.
    // `querySelectorAll` returns document order, which is what a reader tabbing
    // through and a screen reader reading out both follow.
    expect(
      Array.from(
        header.querySelectorAll('.fleet-panel-stats, .info-tip-button'),
        (element) => element.className,
      ),
    ).toEqual(['fleet-panel-stats', 'info-tip-button']);
  });

  it('carries exactly one (i), against a source that once had two', async () => {
    /*
     * The horizon-only source is the arm that used to render a second tip
     * naming the window, because it had no picker to state it. #284 D5 deleted
     * the tip rather than moving it: this arm is pinned to the default window by
     * construction — nothing can call `setRange` without a picker — so the
     * chart's own name is where the window is stated, and one description behind
     * one (i) is all the panel has left.
     *
     * The negative queries have their positive control in the case above, which
     * finds a tip button by role and name; a null here is therefore an absent
     * control rather than a query that never matches anything.
     */
    const container = await renderSettled(
      new CountingFleetSource(FULL_FLEET, HORIZON_ONLY_CAPABILITIES),
    );

    expect(screen.queryByRole('group', { name: 'Aggregation range' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'About this window' })).toBeNull();
    expect(container.querySelectorAll('.info-tip-button')).toHaveLength(1);
    expect(screen.getByRole('img', { name: /Fleet forecast/u }).getAttribute('aria-label')).toBe(
      'Fleet forecast, next 24 h',
    );
  });

  it('offers the window control to a source with actuals but no look-back, and re-asks on it', async () => {
    /*
     * The combination #264 made real, and the reason D5 could delete the caption
     * instead of rewriting it. A source with simulated actuals has a window
     * worth choosing even though its forecast read reaches forward only — a
     * wider one buys more measured hours behind the horizon and asks that read
     * for more ahead of it — so the picker is offered, and both halves of that
     * are asserted: the source really is re-asked at 48 h, and the chart's own
     * name really does follow.
     */
    const dataSource = new CountingFleetSource(
      DISJOINT_WINDOW_FLEET,
      SIMULATED_ACTUALS_CAPABILITIES,
    );
    const container = await renderSettled(dataSource);

    expect(
      within(fleetHeader(container)).getByRole('group', { name: 'Aggregation range' }),
    ).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: '48 h' }));

    await waitFor(() => {
      expect(dataSource.forecastRanges).toEqual([24, 48]);
    });
    expect(screen.getByRole('img', { name: /Fleet forecast/u }).getAttribute('aria-label')).toBe(
      'Fleet forecast and simulated actuals, past 48 h and the forecast ahead',
    );
  });

  it('names the window control for assistive technology alone, with no visible label beside it', async () => {
    /*
     * #329, and the answer to the question that raised it: the window's name is
     * for screen readers, and it is already only for them. `design.md` rule 2
     * settles the move — a label whose only job is naming for assistive
     * technology becomes an accessible name, not visible text — and #284 D5 had
     * already made it, deleting the window captions when the picker took over
     * stating the window. This case is what stops one growing back as a heading
     * over the control.
     *
     * Neither half stands alone. The `getByRole` is the positive control: it
     * proves the name is still *on* the group, so the null below reads as "the
     * name is not visible" rather than "the name was deleted". Which window is
     * drawn is copy and stays in `FleetPanel.test.tsx`; what is pinned here is
     * the route — `aria-label`, and no visible node.
     */
    const container = await renderSettled(new CountingFleetSource(FULL_FLEET));

    expect(
      within(fleetHeader(container)).getByRole('group', { name: 'Aggregation range' }),
    ).toBeDefined();
    expect(screen.queryByText('Aggregation range')).toBeNull();
  });
});

describe('FleetPanel’s chart', () => {
  it('keeps the chart on screen in every fleet state', async () => {
    /*
     * #284 D3, as one case rather than four scattered assertions. The panel used
     * to return its pending, failed and empty states *in place of* the chart, so
     * the tallest element on the page appeared and vanished under a reader
     * watching a retry land — and a failed fleet read took the axes, the legend
     * and the table twin with it, which is more than the failure had actually
     * removed. Each arm asserts the state's own sentence beside the figure,
     * because a chart that stayed while the explanation went missing would be
     * the opposite defect.
     *
     * D3's two other clauses — every heading exists whether or not there is
     * data, and the legend renders in every state — are asserted per arm by
     * `expectPanelFurniture` rather than left implied by the figure count. Both
     * hold by construction and that is the point of pinning them: the heading
     * row is rendered outside the state switch in `FleetPanel.tsx` and the
     * legend unconditionally inside the figure in `ForecastChart.tsx`, so a
     * future state that returns early past either would be exactly the
     * regression these clauses were written against.
     */
    const loading = render(panel(new CountingFleetSource(FULL_FLEET))).container;

    expectChartWith(loading, LOADING_FLEET_FORECAST_LABEL);

    await settle();
    cleanup();

    expectChartWith(
      await renderSettled(new CountingFleetSource(FAILED_FLEET)),
      /Could not load the fleet forecast/u,
    );

    cleanup();

    expectChartWith(
      await renderSettled(new CountingFleetSource(FORECASTLESS_FLEET)),
      NO_FLEET_FORECAST_MESSAGE,
    );

    cleanup();

    expectChartWith(
      await renderSettled(new CountingFleetSource(FULL_FLEET), []),
      EMPTY_FLEET_MESSAGE,
    );
  });

  it('draws the actuals when the forecast half summed to nothing, rather than calling it empty', async () => {
    /*
     * #290's second finding. "No forecast" and "nothing to show" stopped being
     * the same question when the chart's x-domain became the union of the two
     * series (`fleet-series.ts`, #264): a fleet whose forecast half has not
     * produced yet still has every measured hour to draw, and the guard that
     * returned on an empty *forecast* threw those hours away and told the reader
     * there was nothing at all. The fix is to join first and ask about what
     * would be drawn, which is what this case pins.
     */
    const container = await renderSettled(new CountingFleetSource(ACTUALS_ONLY_FLEET));

    // The fifth state D3's clauses cover, and the one arm above cannot reach:
    // it is the only state whose sentence is an *absence*, so the furniture is
    // asserted here directly rather than through `expectChartWith`.
    expectPanelFurniture(container);
    expect(screen.queryByText(NO_FLEET_FORECAST_MESSAGE)).toBeNull();
    // Genuinely drawn, not merely tabulated: the two measured hours are one
    // contiguous run, so they are one path on the plot.
    expect(container.querySelectorAll('.forecast-chart > .forecast-chart-actuals')).toHaveLength(1);

    const table = screen.getByRole('table', { name: /Table view/u });

    // The Median cell is the em dash a gap reads as, beside an Actual that has a
    // number — which is what says the measured hours reached the chart on their
    // own rather than by borrowing an x-domain from a forecast that never
    // arrived. It used to be three em dashes; #295 drops the P10 and P90 columns
    // where no hour carries a band, and Median is not gated, so the same claim is
    // made by one cell instead of three.
    expect(within(table).getAllByRole('row').map(rowCells)).toEqual([
      ['Time (UTC)', 'Median', 'Actual'],
      ['10:00', '—', '5.0'],
      ['11:00', '—', '6.0'],
    ]);
  });
});
