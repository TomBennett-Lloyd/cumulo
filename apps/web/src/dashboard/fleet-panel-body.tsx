import type { Forecast, GenerationReading } from '@cumulo/shared';
import type { ReactElement } from 'react';

import { ForecastChart } from '../charts/ForecastChart';
import type {
  ChartErrorNotice,
  ChartOverlaySeries,
  ForecastChartPoint,
  ForecastChartProps,
} from '../charts/ForecastChart';
import type { QueryState } from '../data/use-fleet-query';
import type { ChartUnit } from './chart-unit';
import type { ChartCopy } from './fleet-panel-copy';
import { EMPTY_FLEET_AGGREGATE, type FleetChartAggregate } from './fleet-series';
import { PanelEmpty } from './panel-states';
import {
  CHART_DATA_UNAVAILABLE_MESSAGE,
  EMPTY_FLEET_MESSAGE,
  FLEET_ACTUALS_FAILURE_NOTICE,
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
 * The body is always the same two slots in the same order: whatever the panel
 * has to *say* right now, and the chart. Loading, failed, empty, forecastless
 * and ready differ only in what fills the first of those and in what the second
 * one draws (#284 D3). Before this, three of those states returned in place of
 * the chart, so a reader watching a retry land saw the page's tallest element
 * appear under their pointer and everything below it jump — and a reader whose
 * fleet read failed lost the axes, the legend and the table twin along with the
 * numbers, which is more than the failure took. `ForecastChart` draws bare
 * chrome for an empty series by contract, so "no points yet" is a chart with
 * nothing plotted on it rather than a hole where a chart goes.
 *
 * **The loading state fills the first slot with nothing, and #448 is why.** The
 * owner's round of 2026-08-12 took the pending sentence out of it — *"graph
 * loading state needs to be visual not words … It also causes the page to
 * jump"* — so that arm now says nothing and the chart draws the wait instead, as
 * a self-tracing curve inside the plot (`charts/chart-loading-curve.ts`,
 * `docs/design/chart-treatment.md`'s Loading section). Which makes the claim
 * this section owns *stronger* rather than weaker: the states no longer differ
 * only in a sentence above a fixed chart, they differ in what is drawn on it,
 * and the one state that used to change the body's height by arriving and
 * leaving no longer changes anything. What the reader is owed while they wait is
 * still stated, just not in words — `bodyLayout` marks the container `aria-busy`
 * so the state stays machine-readable, and `docs/standards/react.md`'s Pending
 * bullet was amended by the same round to say when a surface may do that.
 *
 * **The failed state emptied the first slot too, and #452 is why.** The owner's
 * follow-up asked for the fleet's failure to be shown where the chart is —
 * *"the sites fetch error state should show in the graph area"* — and ruled it
 * generic: one account for any total failure of the chart's data path, rather
 * than a sentence per read. So the failed arm's `PanelError` card left this file
 * and became an overlay inside the figure
 * (`charts/forecast-chart-error.tsx`), which is #448's move made for the other
 * end of the same read. Two of the five states now say nothing above the chart,
 * and neither of them can move the page. What did *not* move is every **partial**
 * state: a failed actuals read, a failed overlay and a short aggregate all still
 * speak in the first slot, because each of them has a chart that arrived and an
 * answer to keep (`error-handling.md` rule 5). Which failures are total is
 * `FleetPanel.tsx`'s to decide and is decided there.
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
 * #448 is the second, and it is the case the ledger was for: taking the words
 * out of the loading arm falsified the *phrasing* of several members without
 * touching the claim — each of them said the states differ in what the panel
 * *says* — so they were trued in that change rather than found a cycle at a
 * time. What each gained is the same clause: the states differ in what is drawn
 * as well as in what is said, and the loading one now differs only in that.
 *
 * #452 is the third, and it is the same shape once more rather than a new one:
 * the failed arm joined the loading arm in saying nothing above the chart, so
 * members quoting the failed state's sentence — or counting the alert it used to
 * mount here — were falsified in their phrasing while the claim held. They are
 * trued in that change. The claim itself comes out stronger again: what is left
 * speaking above the chart is only the states with something *partial* or
 * *absent* to report, and the two states that used to swap the tallest element
 * on the page for a sentence now differ from every other state in what the plot
 * has on it and in nothing else.
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
  /**
   * Which unit the points in this context's arms are already in (#291).
   *
   * The values arrive normalised — the panel's seam is `fleet-series.ts` and
   * `site-overlay.ts`, both above this file — so what travels here is only the
   * chart's need to say which unit it is drawing. It is the panel's whole state
   * rather than the chart's one-member `'percent'`, because this is still the
   * dashboard side of that seam; `fleetChart` below is where the two-state value
   * becomes the by-presence prop.
   */
  readonly unit: ChartUnit;
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
 * The loading flag as a value, so it can be spread in rather than branched on.
 *
 * Typed by the prop it fills rather than by inference: `{ loading: true }`
 * written inline infers `boolean`, and `ForecastChart`'s prop is the literal
 * `true` (its own docblock says why). A named constant is also the cheapest
 * thing here that is not a `as const` assertion (`typing.md` rule 2).
 */
const DRAWN_AS_LOADING: Pick<Required<ForecastChartProps>, 'loading'> = { loading: true };

/**
 * The chart, with each optional prop present only when it has something to say.
 *
 * Two calls rather than `overlay={overlay}` with a possibly-`undefined` value:
 * under `exactOptionalPropertyTypes` an absent optional prop and one explicitly
 * set to `undefined` are different values, and `ForecastChart`'s contract is
 * that an *absent* overlay renders exactly what it rendered before overlays
 * existed — no mark, no legend row, no table column. Spreading the shared props
 * keeps the two arms from drifting (`structure.md` rule 7).
 *
 * `loading` and, since #452, `error` keep the same by-presence contract and reach
 * the chart by a conditional spread rather than by further arms. The flags are
 * independent — a site's overlay can already have arrived while a range change
 * re-asks the fleet — so branching on each would be eight copies of one call for
 * three facts that barely interact, which is the shape rule 7 exists to refuse.
 * (`loading` and `error` are in fact exclusive, but that is a property of the
 * arms below rather than of this call, and the chart's own docblock says so.)
 *
 * `unit` is the fourth member of that set and the one that reads oddest, so it
 * is worth saying why it is spelled this way (#291). The chart's prop is the
 * one-member `'percent'` rather than a `'kw' | 'percent'` pair, so kW is its
 * *absence* and no caller has to pass the default — which is what keeps a chart
 * rendered without it emitting what it emitted before the toggle existed. The
 * spread is therefore a translation across the panel seam rather than a
 * forwarding of an optional flag: `?? 'kw'` here would be `testing.md` rule 9's
 * defect, restating the chart's own default at the call site and retiring every
 * test that exercises it.
 */
const fleetChart = (
  points: readonly ForecastChartPoint[],
  { chart, overlay, unit }: FleetChartContext,
  loading: boolean,
  error: ChartErrorNotice | null,
): ReactElement => {
  const common = {
    points,
    ariaLabel: chart.ariaLabel,
    tableCaption: chart.tableCaption,
    ...(loading ? DRAWN_AS_LOADING : {}),
    ...(error === null ? {} : { error }),
    ...(unit === 'percent' ? { unit: 'percent' as const } : {}),
  };

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
 * The single co-occurrence that budget sanctions is the panel's failed state,
 * which #284 D3 made possible by keeping the chart on screen through a failure
 * rather than returning in place of it. Since #452 that alert is no longer this
 * file's: the failure is drawn inside the figure, so the `role="alert"` and the
 * readout it sits beside are now both the chart's own
 * (`charts/forecast-chart-error.tsx`). The sanctioning property is untouched by
 * the move, because it was never about which file rendered the alert — a failed
 * fleet read leaves no points, so the readout renders empty for exactly as long
 * as the alert is up, and the two provably cannot compete. It is not licence for
 * a third region here either, and the partial states above deliberately take
 * none: this arm's notice is a caption on an answer, not an event.
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
 * What a state says, what it leaves the chart to draw, whether it is still
 * waiting, and whether it has anything to draw *from* — the only four things
 * that vary.
 *
 * The third joined the first two in #448, when the wait stopped being something
 * the panel *says*, and the fourth in #452, when a total failure stopped being
 * one either. Both moved the same way and for the same reason: a state that used
 * to arrive as a sentence above the chart now arrives inside the chart's own box,
 * so it changes what the reader sees without changing where anything sits.
 * `notice` is nullable for that reason too — a state with no news has no element
 * to render, and a placeholder one would put an empty box in the grid above the
 * chart, which is the page jump these rounds removed, spelled a different way.
 *
 * `error` is `null` in every arm but one, and it is deliberately not a union with
 * `loading`: the chart takes them as two independent by-presence props over two
 * different mechanisms (a mark among the marks, and an HTML panel over the whole
 * figure), so collapsing them here would only mean expanding them again at the
 * call below.
 */
interface FleetBodyContent {
  readonly notice: ReactElement | null;
  readonly points: readonly ForecastChartPoint[];
  readonly loading: boolean;
  readonly error: ChartErrorNotice | null;
}

/**
 * The one state in which the chart has nothing to draw and no prospect of
 * anything: what it shows, and the single request that could change that.
 *
 * Shared by the two arms that reach it — the fleet's own forecast read having
 * failed, and a listing that failed leaving the panel no fleet to sum
 * (`FleetPanel.tsx` routes both, and owns the argument for which failures are
 * total and which are merely partial). One builder rather than two identical
 * literals, because they are one intent in two subjects and only the retry
 * differs (`structure.md` rule 7): what changes is which counter the button
 * bumps, so that is the parameter and nothing else is.
 *
 * `notice: null` is the whole of what is left above the chart, and it is the
 * change #452 made to this arm: the sentence used to sit there in a `PanelError`
 * card and now sits inside the figure, which is the same no-jump move #448 made
 * for the wait. Nothing else in the body is above the plot any more in this
 * state.
 *
 * The points come from {@link EMPTY_FLEET_AGGREGATE} rather than from the
 * caller's aggregate, and that is not a shortcut: a non-ready state is handed
 * exactly that aggregate by construction (`FleetPanel.tsx`'s `chartAggregateOf`),
 * and a fleet with no sites has nothing to sum either, so both callers would
 * pass the identical array. Naming the constant is what keeps the chart handed
 * the *same* array on every render rather than an equal one.
 */
const unavailableContent = (onRetry: () => void): FleetBodyContent => ({
  notice: null,
  points: EMPTY_FLEET_AGGREGATE.points,
  loading: false,
  error: { message: CHART_DATA_UNAVAILABLE_MESSAGE, retryLabel: RETRY_ACTION_LABEL, onRetry },
});

/**
 * The one arrangement every state renders: what the panel says, then the chart.
 *
 * One function rather than the same two lines in each arm, so a state cannot be
 * added that quietly drops the chart — which is the shape the restructure was
 * fixing. The notice is a fragment in the ready arm, so its children stay direct
 * children of the grid and keep the body's own gap.
 *
 * **What a state differs in is no longer only what it says.** Since #448 the
 * loading arm says nothing at all: it is the chart that carries the wait, as a
 * mark inside the plot (`charts/chart-loading-curve.ts`), and this container
 * carries the same fact for anything that cannot see a drawing —
 * `aria-busy="true"` while the read is out, and no attribute at all otherwise.
 * The arrangement is unchanged and if anything more nearly one arrangement than
 * before: every state renders the same two slots, and the state that used to
 * fill the first with a sentence now leaves it empty rather than swapping the
 * layout around it.
 *
 * `undefined` rather than `"false"` on the settled path, so the attribute is
 * absent instead of present-and-negative. The two are equivalent to assistive
 * technology and are not equivalent to a `[aria-busy="true"]` query, which is
 * what `fleet-panel-test-fixture.tsx`'s `settle()` waits on and what
 * `e2e/chart-loading.spec.ts` watches for.
 *
 * **`aria-busy` stays loading's alone, and #452's failure state deliberately
 * does not touch it.** A failed read is not a wait, and the reason the wordless
 * loading arm needs the attribute at all is that it has nothing to say — a
 * drawing announces nothing. The failure has the opposite problem and the
 * opposite solution: it is text-bearing, so it takes `react.md`'s **Failed**
 * lane and announces through its own `role="alert"` inside the figure. Marking
 * the body busy as well would tell a reader something is arriving when nothing
 * is.
 */
const bodyLayout = (
  { notice, points, loading, error }: FleetBodyContent,
  context: FleetChartContext,
): ReactElement => (
  <div className="fleet-panel-body" aria-busy={loading ? 'true' : undefined}>
    {notice}
    {fleetChart(points, context, loading, error)}
  </div>
);

/**
 * The fleet's chart with nothing to draw on it and one request that might
 * change that — the state a listing failure and a failed fleet read share.
 *
 * Exported for `FleetPanel.tsx`, which is the only surface that can tell a
 * listing that failed with no sites in hand from one that failed beside sites
 * this session created — a distinction this file has no way to see, and the
 * whole of the owner's degradation story: if the graph *can* show data, it does.
 */
export const unavailableFleetBody = (
  context: FleetChartContext,
  onRetry: () => void,
): ReactElement => bodyLayout(unavailableContent(onRetry), context);

/**
 * A fleet with no sites in it: the demo's invitation, over the same bare chart.
 *
 * The panel asks its source nothing in this state — there is nothing to sum —
 * so the chart is drawn from no points at all rather than from a query that was
 * never spent. Nothing is in flight either, which is why this arm is not busy:
 * an empty fleet is a finished answer, not a wait.
 */
export const emptyFleetBody = (context: FleetChartContext): ReactElement =>
  bodyLayout(
    {
      notice: <PanelEmpty message={EMPTY_FLEET_MESSAGE} />,
      points: EMPTY_FLEET_AGGREGATE.points,
      loading: false,
      error: null,
    },
    context,
  );

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
    return {
      notice: <PanelEmpty message={NO_FLEET_FORECAST_MESSAGE} />,
      points,
      loading: false,
      error: null,
    };
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
    loading: false,
    error: null,
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
    /*
     * No notice, and that is the state's whole content (#448).
     *
     * The owner asked for this one directly: the label that used to sit here
     * "is both misleading (most of the time is spent fetching not summing) and
     * also not visually appealing. It also causes the page to jump." Both
     * complaints are answered by the same deletion — a sentence that arrives
     * above the chart and leaves again is the jump, and a sentence naming the
     * wrong half of the wait is the misleading part. What replaces it is drawn
     * inside the plot, in the box the chart already occupies, so no reader is
     * told anything and nothing moves.
     *
     * The wait is still machine-readable: `bodyLayout` marks this container
     * `aria-busy`, which is the half of `react.md`'s Pending bullet that the
     * amendment of 2026-08-12 kept. Completion is unchanged too — it is this
     * busy container being replaced by content, never an announcement.
     */
    return { notice: null, points: aggregate.points, loading: true, error: null };
  }
  if (state.status === 'failed') {
    /*
     * The forecast read is the answer itself, so its failure is total and takes
     * the generic in-figure account (#452) rather than a sentence of its own.
     * What is left of the old arm here is the *retry*, which survives on the
     * same argument it always had: it is offered because a fleet read that came
     * back with nothing is exactly the failure a repeat can outlive. The rule is
     * `react.md`'s **Failed** bullet ("a retry only when retrying can work"; no
     * retry that "re-runs an identical metered request"), read as withholding
     * one where re-running would deterministically return what it already
     * returned — a read that failed being the opposite case. That reading is an
     * interpretation, not the bullet's own words; `docs/tech-debt.md` has why
     * the amendment belongs in `react.md` rather than here.
     *
     * What the arm gave up is the source's own message, and it was the owner's
     * call rather than this file's: a total failure gets one generic sentence,
     * because a transport detail is not something the reader can act on
     * (`state-copy.ts`'s `CHART_DATA_UNAVAILABLE_MESSAGE`). `state.error` is
     * still carried this far — `use-fleet-query.ts` says why it stays typed.
     */
    return unavailableContent(onRetry);
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
): ReactElement => bodyLayout(stateContent(state, aggregate, context, onRetry), context);
