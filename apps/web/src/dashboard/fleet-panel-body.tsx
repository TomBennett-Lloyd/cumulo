import type { FleetActualsAggregatePoint, FleetForecastAggregatePoint } from '@cumulo/shared';
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
 * ## One chart, in every state, and nothing that swaps around it
 *
 * The body is always the same two slots in the same order: whatever the panel has
 * to *say* right now, and the chart. Loading, failed, empty, forecastless and
 * ready differ only in what fills the first and in what the second draws (#284
 * D3). `ForecastChart` draws bare chrome for an empty series by
 * contract, so "no points yet" is a chart with nothing plotted on it rather than
 * a hole where a chart goes.
 *
 * **Two of the five states now fill the first slot with nothing**, and both moved
 * the same way: the wait (#448) is drawn inside the plot by
 * `apps/web/src/charts/chart-loading-curve.ts`, and a total failure (#452) is an
 * overlay inside the figure, `apps/web/src/charts/forecast-chart-error.tsx`.
 * Neither can move the page. The wait stays machine-readable through
 * `bodyLayout`'s `aria-busy` (`docs/standards/react.md`'s Pending bullet).
 *
 * What did *not* move is every **partial** state: a failed actuals read, a failed
 * overlay and a short aggregate all still speak in the first slot, because each
 * has a chart that arrived and an answer to keep (`error-handling.md` rule 5).
 * Which failures are total is `FleetPanel.tsx`'s to decide and is decided there.
 *
 * ### Restatement ledger
 *
 * `.claude/ledgers/one-chart-in-every-state.ledger` (`architecture.md` rule 9); carriers
 * cite this section as `fleet-panel-body.tsx` § One chart and `check:ledgers` holds the list to it.
 *
 * ## An empty answer is the *joined* series being empty
 *
 * The empty guard asks about what would be drawn, not about the forecast alone. A
 * fleet whose forecast read summed to nothing while its actuals arrived is a
 * fleet with hours to plot (#290). That state is owed the chart plus
 * the partial-aggregate line; both fall out of the ready arm below once the join
 * happens first.
 */

/**
 * What the fleet's second read contributed, once the first one has answered.
 *
 * A union rather than a list plus a boolean (`typing.md` rule 4): the actuals
 * arrive whole or not at all.
 */
export type FleetActualsState =
  | { readonly kind: 'points'; readonly points: readonly FleetActualsAggregatePoint[] }
  | { readonly kind: 'failed' };

/** The two source calls this panel makes, once the forecast has answered. */
export interface FleetSeries {
  /** Already summed — one point per hour, as `FleetDataSource.fleetForecasts` now answers (#494). */
  readonly forecasts: readonly FleetForecastAggregatePoint[];
  readonly actuals: FleetActualsState;
}

/**
 * What the selected site contributes to the chart right now.
 *
 * A union rather than an optional series plus a loose error flag (`typing.md`
 * rule 4). `none` covers every reason there is
 * nothing to draw and nothing to say — no selection, a selection whose first
 * forecast has not arrived, a read still in flight.
 */
export type OverlayState =
  | { readonly kind: 'none' }
  | { readonly kind: 'series'; readonly series: ChartOverlaySeries }
  | { readonly kind: 'failed'; readonly siteName: string };

/**
 * Everything the body needs that is not the fleet's own numbers, as one value.
 */
export interface FleetChartContext {
  readonly siteCount: number;
  readonly chart: ChartCopy;
  /**
   * Which unit the points in this context's arms are already in (#291).
   *
   * The values arrive normalised — the panel's seam is `fleet-series.ts` and
   * `site-overlay.ts` — so what travels here is only the chart's need to say
   * which unit it is drawing.
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
 * **The complete arm is `null`, and that is the whole of #323's change here.**
 * A sentence restating what the chart beside it draws is description rather than
 * state and so does not earn its line (`design.md` rule 2).
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
 * existed. Spreading the shared props
 * keeps the two arms from drifting (`structure.md` rule 7).
 *
 * `loading` and, since #452, `error` keep the same by-presence contract and reach
 * the chart by a conditional spread rather than by further arms.
 *
 * `unit` is the fourth member of that set (#291). The chart's prop is the
 * one-member `'percent'` rather than a `'kw' | 'percent'` pair, so kW is its
 * *absence* and no caller has to pass the default. The spread is therefore a
 * translation across the panel seam rather than a forwarding of an optional
 * flag: `?? 'kw'` here would be `testing.md` rule 9's defect.
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
 * Deliberately **not** a live region. `react.md` budgets one per panel and this
 * panel's is the chart's own readout. An incomplete answer is a caption on the
 * answer, not an event — the same reason the completeness note above is not live
 * either.
 *
 * It re-asks only the series that failed
 * and never the fleet's forecast read beside it, which arrived.
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
 * `loading` (#448) and `error` (#452) are here because a state that used to
 * arrive as a sentence above the chart now arrives inside the chart's own box.
 * `notice` is nullable for the same reason — a state with no news has no element
 * to render, and a placeholder would put an empty box in the grid above the
 * chart, which is the page jump those rounds removed.
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
 * total and which are merely partial).
 *
 * The points come from {@link EMPTY_FLEET_AGGREGATE} rather than from the
 * caller's aggregate, and that is not a shortcut: a non-ready state is handed
 * exactly that aggregate by construction (`FleetPanel.tsx`'s `chartAggregateOf`).
 * Naming the constant is what keeps the chart handed
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
 * added that quietly drops the chart. The notice is a fragment in the ready arm,
 * so its children stay direct
 * children of the grid and keep the body's own gap.
 *
 * `aria-busy` is what carries the wait for anything that cannot see a drawing,
 * now that the loading arm says nothing at all (#448).
 *
 * `undefined` rather than `"false"` on the settled path, so the attribute is
 * absent instead of present-and-negative. The two are equivalent to assistive
 * technology and are not equivalent to an `[aria-busy="true"]` query, which is
 * what `apps/web/src/dashboard/fleet-panel-test-fixture.tsx`'s `settle()` waits
 * on and what `apps/web/e2e/chart-loading.spec.ts` watches for.
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
 */
export const unavailableFleetBody = (
  context: FleetChartContext,
  onRetry: () => void,
): ReactElement => bodyLayout(unavailableContent(onRetry), context);

/**
 * A fleet with no sites in it: the demo's invitation, over the same bare chart.
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
     */
    return { notice: null, points: aggregate.points, loading: true, error: null };
  }
  if (state.status === 'failed') {
    /*
     * The forecast read is the answer itself, so its failure is total and takes
     * the generic in-figure account (#452) rather than a sentence of its own.
     * The *retry* survives on the argument it always had: a fleet read that came
     * back with nothing is exactly the failure a repeat can outlive. That reads
     * `react.md`'s **Failed** bullet ("a retry only when retrying can work"; no
     * retry that "re-runs an identical metered request") as withholding one where
     * re-running would deterministically return what it already returned — an
     * interpretation rather than the bullet's own words, and
     * `docs/tech-debt.md` has why the amendment belongs in `react.md`.
     *
     * The source's own message is deliberately dropped
     * (`apps/web/src/dashboard/state-copy.ts`'s `CHART_DATA_UNAVAILABLE_MESSAGE`).
     * `state.error` is still carried this far —
     * `apps/web/src/data/use-fleet-query.ts` says why it stays typed.
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
 * component's to keep.
 */
export const fleetBody = (
  state: QueryState<FleetSeries>,
  aggregate: FleetChartAggregate,
  context: FleetChartContext,
  onRetry: () => void,
): ReactElement => bodyLayout(stateContent(state, aggregate, context, onRetry), context);
