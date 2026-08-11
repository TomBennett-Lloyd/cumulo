import type { Forecast, GenerationReading } from '@cumulo/shared';
import type { ReactElement } from 'react';

import { ForecastChart } from '../charts/ForecastChart';
import type { ChartOverlaySeries, ForecastChartPoint } from '../charts/ForecastChart';
import type { QueryState } from '../data/use-fleet-query';
import type { ChartCopy } from './fleet-panel-copy';
import { EMPTY_FLEET_AGGREGATE, type FleetChartAggregate } from './fleet-series';
import { PanelEmpty, PanelError, PanelPending } from './panel-states';
import {
  EMPTY_FLEET_MESSAGE,
  FLEET_ACTUALS_FAILURE_NOTICE,
  fleetForecastFailureMessage,
  LOADING_FLEET_FORECAST_LABEL,
  NO_FLEET_FORECAST_MESSAGE,
  partialAggregateNotice,
  RETRY_ACTION_LABEL,
  siteOverlayFailureNotice,
} from './state-copy';

/*
 * What the fleet chart section puts under its controls, in every state it can
 * be in.
 *
 * Cut out of `FleetPanel.tsx` when the restructure below took that file past
 * `structure.md` rule 4's 300-line ceiling — the second cut from the same wall,
 * after `fleet-panel-copy.ts`. The body builders were the right thing to move
 * rather than the nearest thing: every function here is pure, takes what it
 * reads (rule 1), and returns markup, so the file that is left is the component
 * — its props, its queries and its controls row — with no rendering arithmetic
 * in it.
 *
 * ## One chart, in every state, and nothing that swaps around it
 *
 * The body is always the same two things in the same order: whatever the panel
 * has to *say* right now, and the chart. Loading, failed, empty, forecastless
 * and ready differ only in the first of those and in how many points the second
 * one draws (#284 D3). Before this, three of those states returned in place of
 * the chart, so a reader watching a retry land saw the page's tallest element
 * appear under their pointer and everything below it jump — and a reader whose
 * fleet read failed lost the axes, the legend and the table twin along with the
 * numbers, which is more than the failure took. `ForecastChart` draws bare
 * chrome for an empty series by contract, so "no points yet" is a chart with
 * nothing plotted on it rather than a hole where a chart goes.
 *
 * ### Restatement ledger (`architecture.md` rule 9)
 *
 * This section is the owner of the claim "one chart, in every state" — that the
 * body is one arrangement the states differ *inside*, rather than a switch
 * between arrangements. The sites below restate it in their own words, each
 * because it asserts or reasons about it locally; changing what the states share
 * finds them here rather than one review cycle at a time. Banked on #403 and
 * written in #431, the first member since to touch this file.
 *
 * - `bodyLayout`'s docblock below — "the one arrangement every state renders",
 *   which is this claim stated about the function that enforces it.
 * - `FleetPanel.tsx` — the "One chart, always on screen" section, the
 *   `combineFleetQueries` docblock ("nothing takes the section down any more"),
 *   and the `enabled` comment.
 * - `FleetPanel.structure.test.tsx` — the file header, and
 *   `expectPanelFurniture`'s docblock, which is where D3's clauses are read.
 * - `FleetPanel.test.tsx` — the figure-presence note, the overlay-state note and
 *   the first-mount note.
 * - `Dashboard.test.tsx` — the first-paint live-region case's comment.
 * - `Dashboard.tsx` — the composition comment's "nothing swaps" paragraph.
 * - `Dashboard.deep-link.test.tsx` — the comment spending #178's saving on the
 *   grounds that the chart is on screen from first paint.
 * - `dashboard-test-fixture.tsx` — the chart-section locator's docblock.
 * - `map/SitePopoverCard.tsx` — the note that the card plots nothing because the
 *   fleet chart is on screen in every state of the panel.
 * - `docs/design/dashboard-composition.md` — the "A selection changes what is
 *   drawn, not what is on screen" section.
 * - `docs/standards/react.md`'s D3 bullets — **listed, never edited.** That file
 *   is a standards doc; a change here that falsified those bullets is a proposal
 *   to amend the standard, not an edit to make in passing.
 *
 * The sweep is
 * `command grep -rnE "in every state|One chart|one arrangement" apps/web/src docs`,
 * run **from the worktree root** — run at the repo root it descends into
 * `.claude/worktrees/` and returns every sibling checkout's copy of this list.
 * Re-run 2026-08-11, which is where the list above comes from; the three members
 * #403 banked without (`Dashboard.tsx`, `Dashboard.deep-link.test.tsx`, the
 * composition doc) are what that re-run added. It is still a floor rather than a
 * census, because a carrier paraphrasing the claim without the phrase is
 * invisible to it (`architecture.md` rule 10).
 *
 * Two things the sweep returns that are **not** members, named so the next
 * reader does not re-decide them: the "in every state" in `Dashboard.test.tsx`'s
 * attribution-credit docblock and in `design.md` / `design-principles.md`
 * belongs to the Open-Meteo licence claim, a different obligation that happens
 * to share the phrase.
 *
 * ## An empty answer is the *joined* series being empty
 *
 * The empty guard asks about what would be drawn, not about the forecast alone.
 * A fleet whose forecast read summed to nothing while its actuals arrived is
 * a fleet with hours to plot, and the earlier guard — which returned on an empty
 * forecast before the two series were joined — threw those hours away and told
 * the reader there was nothing at all (#290). What that state is owed is the
 * chart, and the partial-aggregate line saying the forecast half is short; both
 * fall out of the ordinary ready arm below once the join happens first.
 */

/**
 * What the fleet's second read contributed, once the first one has answered.
 *
 * A union rather than a list plus a boolean (`typing.md` rule 4): "some readings
 * and also a failure" is not a state this panel has — the actuals arrive whole
 * or not at all — and the failed arm carries nothing because the notice it
 * produces names no detail.
 */
export type FleetActualsState =
  | { readonly kind: 'readings'; readonly readings: readonly GenerationReading[] }
  | { readonly kind: 'failed' };

/** The two source calls this panel makes, once the forecast has answered. */
export interface FleetSeries {
  readonly forecasts: readonly Forecast[];
  readonly actuals: FleetActualsState;
}

/**
 * What the selected site contributes to the chart right now.
 *
 * A union rather than an optional series plus a loose error flag (`typing.md`
 * rule 4): "a series and a failure" and "neither, but a site name to apologise
 * about" are not states this panel has. `none` covers every reason there is
 * nothing to draw and nothing to say — no selection, a selection whose first
 * forecast has not arrived, a read still in flight — because the reader is owed
 * the same thing in all three: the fleet's chart, unannotated.
 */
export type OverlayState =
  | { readonly kind: 'none' }
  | { readonly kind: 'series'; readonly series: ChartOverlaySeries }
  | { readonly kind: 'failed'; readonly siteName: string };

/**
 * Everything the body needs that is not the fleet's own numbers, as one value.
 *
 * Threaded rather than passed as four more parameters: the builders below are
 * top-level functions precisely so they can be read without the component
 * around them (`structure.md` rule 1), and a signature that grows a parameter
 * per surface stops being readable at about this point.
 */
export interface FleetChartContext {
  readonly siteCount: number;
  readonly chart: ChartCopy;
  readonly overlay: OverlayState;
  /** Re-asks for the selected site's hours, and only those. */
  readonly onRetryOverlay: () => void;
  /** Re-asks for the fleet's readings, and only those — never the forecast read beside them. */
  readonly onRetryActuals: () => void;
}

/**
 * The completeness line, stated in the one direction that is news.
 *
 * `minContributing` and `siteCount` are both rendered because "partial" without
 * the two numbers is a shrug: the reader needs to know whether one site is
 * missing or fifty.
 *
 * It is also what covers the state #290 found. A forecast that summed to nothing
 * beside actuals that arrived has a minimum of zero contributing sites, so this
 * says the aggregate is short of every site rather than leaving the missing
 * forecast half unremarked beside a chart that still draws the measured hours
 * (`error-handling.md` rule 5).
 *
 * **The complete arm is `null`, and that is the whole of #323's change here.**
 * It used to render "Aggregated from n sites" in a `.panel-caption` — a sentence
 * restating what the chart beside it draws, which is description rather than
 * state and so does not earn its line (`design.md` rule 2). What the panel says
 * about its state is unchanged: an aggregate that is short still says so, in the
 * same notice, in the same place. Only the case with no news left stopped
 * speaking, and `.panel-caption` went with it — this was its one caller.
 */
const completenessNote = (minContributing: number, siteCount: number): ReactElement | null =>
  minContributing < siteCount ? (
    <p className="panel-notice">{partialAggregateNotice(minContributing, siteCount)}</p>
  ) : null;

/**
 * The chart, with the overlay prop present only when there is an overlay.
 *
 * Two calls rather than `overlay={overlay}` with a possibly-`undefined` value:
 * under `exactOptionalPropertyTypes` an absent optional prop and one explicitly
 * set to `undefined` are different values, and `ForecastChart`'s contract is
 * that an *absent* overlay renders exactly what it rendered before overlays
 * existed — no mark, no legend row, no table column. Spreading the shared props
 * keeps the two arms from drifting (`structure.md` rule 7).
 */
const fleetChart = (
  points: readonly ForecastChartPoint[],
  { chart, overlay }: FleetChartContext,
): ReactElement => {
  const common = { points, ariaLabel: chart.ariaLabel, tableCaption: chart.tableCaption };

  return overlay.kind === 'series' ? (
    <ForecastChart {...common} overlay={overlay.series} />
  ) : (
    <ForecastChart {...common} />
  );
};

/**
 * A chart that arrived, with one of its series missing and a way to re-ask.
 *
 * Both of this panel's partial states render through here, because they are one
 * intent in two subjects (`structure.md` rule 7): a complete answer stands, the
 * missing part is named, and the recourse is the single cheap request that could
 * supply it. What differs is only the sentence and which counter the button
 * bumps, so those are the parameters and nothing else is.
 *
 * Partial results are labelled partial (`error-handling.md` rule 5), and a
 * series that failed silently is the exact shape that rule refuses: nothing on
 * screen distinguishes "this site tracks the fleet closely" from "this site's
 * line never arrived", or a fleet with no simulated actuals from a fleet whose
 * actuals did not load.
 *
 * Deliberately **not** a live region. `react.md` budgets one per panel and this
 * panel's is the chart's own readout, which is the announcement a reader asked
 * for by moving the selection; a second region here would mean whichever won.
 * It is the same non-live treatment the completeness note above uses, for the
 * same reason — an incomplete answer is a caption on the answer, not an event.
 *
 * The single co-occurrence that budget sanctions lives in this file: the failed
 * arm's `PanelError` mounts a `role="alert"` beside that readout, which #284 D3
 * made possible by keeping the chart on screen through a failure rather than
 * returning in place of it. It is allowed because it cannot compete — a failed
 * fleet read leaves no points, so the readout renders empty for exactly as long
 * as the alert is up — and it is not licence for a third region here.
 *
 * The retry is offered because re-asking genuinely can work, which is the test
 * `react.md` sets for offering one at all: a series that did not arrive is a
 * failure a transient network fault or a 5xx can be repeated out of. What it
 * re-asks is only the series that failed — one site's hours, or the fleet's one
 * metered actuals request — and never the fleet's forecast read beside it,
 * which arrived. Until #296 that second half was a cost argument too, because
 * the forecast read was then a per-site fan-out over the whole fleet; it is one
 * metered request now, and the half that survives is that refetching a series
 * which never failed is waste at any price.
 */
const partialSeriesNote = (message: string, onRetry: () => void): ReactElement => (
  <p className="panel-notice">
    {message}{' '}
    <button type="button" className="panel-retry" onClick={onRetry}>
      {RETRY_ACTION_LABEL}
    </button>
  </p>
);

const overlayNote = (overlay: OverlayState, onRetry: () => void): ReactElement | null =>
  overlay.kind === 'failed'
    ? partialSeriesNote(siteOverlayFailureNotice(overlay.siteName), onRetry)
    : null;

const actualsNote = (actuals: FleetActualsState, onRetry: () => void): ReactElement | null =>
  actuals.kind === 'failed' ? partialSeriesNote(FLEET_ACTUALS_FAILURE_NOTICE, onRetry) : null;

/**
 * The one arrangement every state renders: what the panel says, then the chart.
 *
 * One function rather than the same two lines in each arm, so a state cannot be
 * added that quietly drops the chart — which is the shape the restructure was
 * fixing. The notice is a fragment in the ready arm, so its children stay direct
 * children of the grid and keep the body's own gap.
 */
const bodyLayout = (
  notice: ReactElement,
  points: readonly ForecastChartPoint[],
  context: FleetChartContext,
): ReactElement => (
  <div className="fleet-panel-body">
    {notice}
    {fleetChart(points, context)}
  </div>
);

/**
 * A fleet with no sites in it: the demo's invitation, over the same bare chart.
 *
 * The panel asks its source nothing in this state — there is nothing to sum —
 * so the chart is drawn from no points at all rather than from a query that was
 * never spent.
 */
export const emptyFleetBody = (context: FleetChartContext): ReactElement =>
  bodyLayout(<PanelEmpty message={EMPTY_FLEET_MESSAGE} />, EMPTY_FLEET_AGGREGATE.points, context);

/** What a state says, and what it leaves the chart to draw — the only two things that vary. */
interface FleetBodyContent {
  readonly notice: ReactElement;
  readonly points: readonly ForecastChartPoint[];
}

const readyContent = (
  data: FleetSeries,
  { points, minContributingSites }: FleetChartAggregate,
  context: FleetChartContext,
): FleetBodyContent => {
  // The join is asked about before anything is decided: what the chart would
  // draw is the union of both series' hours (`fleet-series.ts`), and it is that
  // union — not the forecast alone — that "nothing to show" has to be a
  // statement about. It happened before this function was called, in the
  // panel's memo, which is the only thing #293 moved about it.
  if (points.length === 0) {
    return { notice: <PanelEmpty message={NO_FLEET_FORECAST_MESSAGE} />, points };
  }

  return {
    notice: (
      <>
        {completenessNote(minContributingSites, context.siteCount)}
        {actualsNote(data.actuals, context.onRetryActuals)}
        {overlayNote(context.overlay, context.onRetryOverlay)}
      </>
    ),
    points,
  };
};

const stateContent = (
  state: QueryState<FleetSeries>,
  aggregate: FleetChartAggregate,
  context: FleetChartContext,
  onRetry: () => void,
): FleetBodyContent => {
  // A state with no answer in it draws no points, and takes them from the
  // aggregate anyway: what a non-ready state is handed is
  // `EMPTY_FLEET_AGGREGATE` by construction, so the chart gets the same array
  // every render here too rather than a fresh empty literal per state.
  if (state.status === 'loading') {
    return {
      notice: <PanelPending label={LOADING_FLEET_FORECAST_LABEL} />,
      points: aggregate.points,
    };
  }
  if (state.status === 'failed') {
    // The sentence is `state-copy.ts`'s; what this panel decides is the retry,
    // which is offered because a fleet read that came back with nothing is
    // exactly the failure a repeat can outlive. The rule is `react.md`'s
    // **Failed** bullet ("a retry only when retrying can work"; no retry that
    // "re-runs an identical metered request"), read as withholding one where
    // re-running would deterministically return what it already returned — a
    // read that failed being the opposite case. That reading is an
    // interpretation, not the bullet's own words; `docs/tech-debt.md` has why
    // the amendment belongs in `react.md` rather than here.
    return {
      notice: (
        <PanelError message={fleetForecastFailureMessage(state.error.message)} onRetry={onRetry} />
      ),
      points: aggregate.points,
    };
  }
  return readyContent(state.data, aggregate, context);
};

/**
 * The body, over an aggregate the caller has already computed.
 *
 * The aggregate arrives as a parameter rather than being summed here, and the
 * two arguments are not a redundancy: `state` is the two source reads and what
 * the panel has to *say* about them, `aggregate` is what a chart draws, and the
 * second is memoized by `FleetPanel` because a `useMemo` cannot live in a plain
 * builder (#293). A caller that passes an aggregate not derived from this
 * `state` would draw one answer under another's notice, so the pairing is the
 * component's to keep — which is exactly where the hook that keeps it lives.
 */
export const fleetBody = (
  state: QueryState<FleetSeries>,
  aggregate: FleetChartAggregate,
  context: FleetChartContext,
  onRetry: () => void,
): ReactElement => {
  const { notice, points } = stateContent(state, aggregate, context, onRetry);

  return bodyLayout(notice, points, context);
};
