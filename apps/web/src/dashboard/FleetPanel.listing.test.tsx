// @vitest-environment jsdom

import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CountingFleetSource,
  FULL_FLEET,
  renderSettled,
  SITE_A,
  type FleetPanelListing,
} from './fleet-panel-test-fixture';
import { CHART_DATA_UNAVAILABLE_MESSAGE, EMPTY_FLEET_MESSAGE } from './state-copy';

/*
 * What the panel makes of the fleet listing's status — the prop it gained in
 * #452, when the listing's own pending and failure states left the page and the
 * chart took over accounting for them.
 *
 * Split from `FleetPanel.test.tsx` when these cases took that file past the
 * 300-line ceiling (`structure.md` rule 4), on the subject line that file's
 * header already draws: it owns what the panel says about the *fleet*, and this
 * owns what it says about the *read that listed the fleet*. Precedent for the
 * split shape: `packages/storage/src/client-retry-classification.test.ts`.
 *
 * The whole subject is one boundary, and it is a boundary about *routing* rather
 * than about copy: only a failure that leaves the chart nothing to draw from gets
 * the generic in-figure account. A listing that failed beside sites already in
 * hand does not, because the fleet endpoints never depended on the listing — the
 * owner's own degradation story, in their words: *"if it's just data and we have
 * the sites they'll appear on the map"*. Both directions are pinned below,
 * because a predicate is only as good as its negative case.
 *
 * **This state is unreachable in a browser and will not be covered by the lane.**
 * `DemoFleetDataSource` answers from memory and never fails, so no Playwright
 * spec can route the demo app into it (`testing.md` rule 10 asks for exactly
 * this to be said rather than implied). These assertions are the whole of the
 * coverage this state has.
 */

afterEach(cleanup);

/** A listing that failed, with a counted recourse — the pair the panel is handed. */
const failedListing = (onRetryListing: () => void): FleetPanelListing => ({
  listing: 'failed',
  onRetryListing,
});

describe('FleetPanel when the fleet listing failed', () => {
  it('shows the generic unavailable state in the graph area, and never the empty invitation', async () => {
    /*
     * Error is not empty, which is the whole reason the listing had to become a
     * prop: both states arrive as `sites: []`, and answering a failed read with
     * the demo's invitation would tell a reader to add a site to a fleet that
     * may be full of them. The two assertions are the two halves of that and
     * neither stands alone — a panel rendering nothing at all satisfies the
     * second.
     */
    const onRetryListing = vi.fn<() => void>();
    const dataSource = new CountingFleetSource(FULL_FLEET);
    const container = await renderSettled(dataSource, [], failedListing(onRetryListing));

    const alert = screen.getByRole('alert');

    expect(alert.className).toBe('forecast-chart-error');
    expect(alert.textContent).toContain(CHART_DATA_UNAVAILABLE_MESSAGE);
    expect(screen.queryByText(EMPTY_FLEET_MESSAGE)).toBeNull();
    // Inside the figure, which is where the owner asked for it and where the
    // no-jump argument lives: an overlay on the chart's own box cannot move the
    // page. The pixels are `charts.css`'s and `chart-css-contract.test.ts`
    // reads the declarations; what jsdom can hold is the containment.
    expect(container.querySelector('.forecast-chart-figure .forecast-chart-error')).toBe(alert);
    // The notice slot above the chart is empty, so nothing arrived over the
    // plot's head — the jsdom half of "the chart does not move".
    expect(container.querySelector('.fleet-panel-body')?.firstElementChild?.className).toBe(
      'forecast-chart-figure',
    );
    // Not a wait: the failure is text-bearing and announces through its own
    // alert, so `aria-busy` stays the loading arm's alone (`react.md`'s Pending
    // bullet, as amended).
    expect(container.querySelector('.fleet-panel-body')?.getAttribute('aria-busy')).toBeNull();
  });

  it('offers the listing’s own retry, and spends no fleet request on it', async () => {
    const onRetryListing = vi.fn<() => void>();
    const dataSource = new CountingFleetSource(FULL_FLEET);
    await renderSettled(dataSource, [], failedListing(onRetryListing));

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    // The recourse re-asks the read that failed and only that one. A button
    // wired to the fleet's own attempt counter would re-run a query that never
    // ran — there are no sites to sum — and leave the reader pressing something
    // that cannot work, which is precisely what `react.md`'s Failed bullet
    // refuses.
    expect(onRetryListing).toHaveBeenCalledTimes(1);
    expect(dataSource.forecastCallCount).toBe(0);
    expect(dataSource.actualsCallCount).toBe(0);
  });

  it('still draws the chart when sites are in hand, because the fleet reads do not need the listing', async () => {
    /*
     * The negative case at the predicate's edge, and the one that dies when the
     * `&& sites.length === 0` conjunct is deleted from `FleetPanel.tsx`: without
     * it, the unavailable state paints over a fleet whose queries can answer,
     * and every positive case above stays green while the reader loses a chart
     * that was working. This is the state a visitor is in after adding a site
     * while the listing was down.
     */
    const dataSource = new CountingFleetSource(FULL_FLEET);
    const container = await renderSettled(
      dataSource,
      [SITE_A],
      failedListing(() => undefined),
    );

    expect(container.querySelectorAll('.forecast-chart > .forecast-chart-median')).not.toHaveLength(
      0,
    );
    expect(container.querySelector('.forecast-chart-error')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    // And the reads really were spent, which is what "the graph can show data"
    // means: a panel that had rendered the chart chrome without asking anything
    // would satisfy the median assertion only by accident.
    expect(dataSource.forecastCallCount).toBe(1);
  });
});
