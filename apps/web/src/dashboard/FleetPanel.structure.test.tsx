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
 * The pair every state owes the reader: whatever it has to say, over the chart.
 *
 * Exactly one figure, not "at least one" — a state that grew a second chart
 * beside the first would satisfy a presence check while doubling the tallest
 * thing on the page.
 */
const expectChartWith = (container: HTMLElement, message: string | RegExp): void => {
  expect(screen.getByText(message)).toBeDefined();
  expect(container.querySelectorAll('.forecast-chart-figure')).toHaveLength(1);
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
     * worth choosing even though its fan-out reaches forward only — a wider one
     * buys more measured hours behind the horizon and asks the fan-out for more
     * ahead of it — so the picker is offered, and both halves of that are
     * asserted: the source really is re-asked at 48 h, and the chart's own name
     * really does follow.
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
});

describe('FleetPanel’s chart', () => {
  it('keeps the chart on screen in every fleet state', async () => {
    /*
     * #284 D3, as one case rather than four scattered assertions. The panel used
     * to return its pending, failed and empty states *in place of* the chart, so
     * the tallest element on the page appeared and vanished under a reader
     * watching a retry land — and a failed fan-out took the axes, the legend and
     * the table twin with it, which is more than the failure had actually
     * removed. Each arm asserts the state's own sentence beside the figure,
     * because a chart that stayed while the explanation went missing would be
     * the opposite defect.
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
     * series (`fleet-series.ts`, #264): a fleet whose fan-out has not produced
     * yet still has every measured hour to draw, and the guard that returned on
     * an empty *forecast* threw those hours away and told the reader there was
     * nothing at all. The fix is to join first and ask about what would be
     * drawn, which is what this case pins.
     */
    const container = await renderSettled(new CountingFleetSource(ACTUALS_ONLY_FLEET));

    expect(screen.queryByText(NO_FLEET_FORECAST_MESSAGE)).toBeNull();
    // Genuinely drawn, not merely tabulated: the two measured hours are one
    // contiguous run, so they are one polyline on the plot.
    expect(container.querySelectorAll('.forecast-chart > .forecast-chart-actuals')).toHaveLength(1);

    const table = screen.getByRole('table', { name: /Table view/u });

    // Every forecast cell is the em dash a gap reads as, which is what says the
    // measured hours reached the chart on their own rather than by borrowing an
    // x-domain from a forecast that never arrived.
    expect(within(table).getAllByRole('row').map(rowCells)).toEqual([
      ['Time (UTC)', 'P10', 'Median', 'P90', 'Actual'],
      ['10:00', '—', '—', '—', '5.0'],
      ['11:00', '—', '—', '—', '6.0'],
    ]);
  });
});
