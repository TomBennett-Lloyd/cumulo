import {
  type FleetActualsAggregatePoint,
  type FleetForecastAggregatePoint,
  type Forecast,
  type GenerationReading,
  type Site,
} from '@cumulo/shared';
import { useId, useMemo, useState, type ReactElement } from 'react';

import { forecastChartLegend } from '../charts/forecast-chart-legend';
import type { FleetDataSource, FleetSourceResult, RangeHours } from '../data/fleet-data-source';
import { useFleetQuery, type QueryState } from '../data/use-fleet-query';
import { InfoTip } from '../info/InfoTip';
import type { ChartUnit } from './chart-unit';
import {
  emptyFleetBody,
  fleetBody,
  unavailableFleetBody,
  type FleetActualsState,
  type FleetChartContext,
  type FleetSeries,
  type OverlayState,
} from './fleet-panel-body';
import {
  chartCopy,
  fleetStatsLine,
  SUBTITLE_FORECAST_ONLY,
  SUBTITLE_WITH_ACTUALS,
  windowLabel,
} from './fleet-panel-copy';
import {
  EMPTY_FLEET_AGGREGATE,
  fleetChartAggregate,
  type FleetChartAggregate,
} from './fleet-series';
import { RangePicker } from './range-picker';
import { siteOverlaySeries } from './site-overlay';
import { useChartUnit } from './use-chart-unit';
import { UnitToggle } from './unit-toggle';

/*
 * The fleet's story, and — while a site is selected — that site's line over it.
 *
 * ## One chart, always on screen
 *
 * The chart is on screen from first paint in every state of the page, and "in
 * every state" is structural rather than merely usual: the body renders one
 * `.forecast-chart-figure` whether the fleet is loading, failed, empty,
 * forecastless or ready, and the states differ only in what is said above it and
 * what is drawn inside it (#284 D3, #448, #452).
 * `fleet-panel-body.tsx` § One chart owns that arrangement.
 *
 * The trade, stated because it was accepted rather than overlooked: **a `?site=`
 * deep link spends the fleet's forecast read**, one metered request to
 * `GET /v1/fleet/forecast` (#296; #178, #265).
 *
 * ## The listing is one of this panel's inputs, for one question only
 *
 * Since #452 the fleet listing has no surface of its own. So `listing` answers
 * the one question an empty `sites` array
 * cannot: nothing to show because the fleet is empty, or because the read that
 * would have told us failed.
 *
 * ## The selected site is one more series, not a second chart
 *
 * One value axis, never two (`docs/design/chart-treatment.md`).
 * The chart is the site's
 * *only* chart: its card on the map carries the site's facts and nothing
 * plotted.
 *
 * **What that axis counts is the reader's to choose, and a selection chooses it
 * for them once** (#291). None of those rules live here:
 * `apps/web/src/dashboard/chart-unit.ts` is the state machine and
 * `apps/web/src/dashboard/use-chart-unit.ts` the wiring. The unit reaches three
 * places from that one value — the aggregate and the overlay, normalised before
 * the chart sees them (`fleet-series.ts`, `site-overlay.ts`), and the chart's
 * chrome by way of `chartCopy`.
 *
 * The overlay read fails on its own terms. The fleet's sum is not withdrawn
 * because an addition to it did not arrive — but an addition that failed
 * *silently* is indistinguishable from a site whose output tracks the fleet, so
 * the panel labels the chart partial and offers a retry for that one site
 * (`error-handling.md` rule 5).
 *
 * ## Capability honesty is structural here, not editorial
 *
 * This panel says only what the source it holds can answer
 * (`dataSource.capabilities`). Fleet actuals are synthesised by the forecast
 * service (#264), and synthesised
 * is not measured, so the arm that mentions them says "simulated actuals" and no
 * arm claims a metered reading.
 *
 * What the *control* is gated on is a wider question, and #284 D5 separated the
 * two. A window is worth choosing wherever a wider one would show more hours,
 * which is true of both flags. The picker renders on
 * `fleetLookback || fleetActuals`, and only a source with neither — a bare
 * forward horizon, pinned to {@link DEFAULT_RANGE} because nothing can call
 * `setRange` — goes without one. That pin is what lets `windowLabel`'s
 * no-capability arm name its window outright.
 *
 * ## Description behind a press, state on the page
 *
 * What the chart *is* sits behind an (i) (`apps/web/src/info/InfoTip.tsx`,
 * #265); what it currently *says* — the partial-aggregate notice, an overlay
 * that failed — stays inline, because a reader cannot press for news they do not
 * know has happened.
 *
 * The **legend** joined the sentence behind that press on the owner's routing.
 * So this panel owns two facts the chart
 * used to derive for itself — whether the drawn points carry a band, and what
 * the overlay is called — and hands them to
 * `apps/web/src/charts/forecast-chart-legend.tsx`;
 * `apps/web/src/charts/ForecastChart.tsx` renders no legend at all.
 *
 * #323 drew that line against the `<h2>` and the stats line too, and **the owner
 * reversed that half on 2026-08-11**. Both are visible text, and
 * the section borrows the heading by `aria-labelledby` rather than spelling the
 * name a second time in an `aria-label`. What did *not* come back is the rest of
 * #323: still a full-width band rather than a
 * card (`apps/web/src/dashboard/fleet-panel.css`), and the completeness note
 * still has no complete arm (`fleet-panel-body.tsx`).
 *
 * The stats line is the one thing here allowed to disappear, and it disappears
 * by *width* rather than by state (`design.md` rule 7 — controls have wrap
 * priority over auxiliary text).
 * `apps/web/src/dashboard/fleet-panel.css` owns and derives that width.
 *
 * ## Attribution
 *
 * There is deliberately no Open-Meteo credit inside this panel. The page carries
 * one persistent credit in its footer, on screen through every state the reading
 * can be in; a second one here would discharge the same obligation twice on one
 * flow.
 */

/** Both fleet reads open on the nearest window, whether or not a picker can move it. */
const DEFAULT_RANGE: RangeHours = 24;

/**
 * Collapse the two queries into the one state the panel renders.
 *
 * **The two failures are not symmetrical, and that asymmetry is the whole of
 * this function.** What differs is weight: a failed forecast is the answer
 * itself not arriving,
 * so it is an `alert` over an empty plot; a failed actuals read is an addition
 * to an answer that did arrive, so it is a `panel-notice` over a plot still
 * carrying every forecast hour.
 *
 * Loading waits for both. A chart that painted the forecast and then grew a past
 * half a moment later would be the panel reflowing under a reader already
 * reading it (#448).
 */
const combineFleetQueries = (
  forecasts: QueryState<readonly FleetForecastAggregatePoint[]>,
  actuals: QueryState<readonly FleetActualsAggregatePoint[]>,
): QueryState<FleetSeries> => {
  if (forecasts.status === 'failed') {
    return forecasts;
  }
  if (forecasts.status === 'loading' || actuals.status === 'loading') {
    return { status: 'loading' };
  }
  const actualsState: FleetActualsState =
    actuals.status === 'failed' ? { kind: 'failed' } : { kind: 'points', points: actuals.data };

  return { status: 'ready', data: { forecasts: forecasts.data, actuals: actualsState } };
};

/** No points is what a failed actuals read leaves the chart: a forecast, and no second series. */
const actualPointsOf = (actuals: FleetActualsState): readonly FleetActualsAggregatePoint[] =>
  actuals.kind === 'points' ? actuals.points : [];

/**
 * What the chart draws, for whichever state the two reads are in.
 */
const chartAggregateOf = (
  state: QueryState<FleetSeries>,
  sites: readonly Site[],
  unit: ChartUnit,
): FleetChartAggregate =>
  state.status === 'ready'
    ? fleetChartAggregate(state.data.forecasts, actualPointsOf(state.data.actuals), sites, unit)
    : EMPTY_FLEET_AGGREGATE;

/** The two halves of one site's window, which the overlay draws either side of its seam. */
interface SiteOverlayHours {
  readonly forecasts: readonly Forecast[];
  readonly actuals: readonly GenerationReading[];
}

/**
 * The selected site's own hours — forecast and measured — or an empty answer
 * when nothing is selected.
 *
 * **Two reads, one metered call** (#530). `HttpFleetDataSource` answers both out
 * of the same `GET /v1/sites/{id}/series` payload and shares the in-flight
 * request between them (`apps/web/src/data/http-fleet-data-source.ts`'s
 * `seriesFor`), so asking together costs what asking for the forecast alone cost
 * — which is why the overlay can draw the site's measurements at all. Asserted
 * where that share lives: `apps/web/src/data/http-fleet-data-source.test.ts`,
 * "serves concurrent forecasts and actuals for one site and range from a single
 * request".
 *
 * **The `Promise.all` is the load-bearing half, and nothing in this panel's own
 * suite bites on it.** Both calls reach their first `await` before either
 * settles, which is what puts them in one flight; awaiting the first and then
 * starting the second would bill a second trip. `CountingFleetSource` shares
 * nothing, so that rewrite would leave every assertion in
 * `apps/web/src/dashboard/FleetPanel.overlay.test.tsx` green while doubling live
 * `/series` traffic — the named test above is the whole guard.
 *
 * Either failure fails the pair, on the arm that failed.
 */
const siteOverlayHours = async (
  dataSource: FleetDataSource,
  site: Site | null,
  range: RangeHours,
): Promise<FleetSourceResult<SiteOverlayHours>> => {
  if (site === null) {
    return { kind: 'ok', value: { forecasts: [], actuals: [] } };
  }
  const [forecasts, actuals] = await Promise.all([
    dataSource.siteForecasts(site.id, range),
    dataSource.siteActuals(site.id, range),
  ]);
  if (forecasts.kind === 'error') {
    return forecasts;
  }
  return actuals.kind === 'error'
    ? actuals
    : { kind: 'ok', value: { forecasts: forecasts.value, actuals: actuals.value } };
};

/**
 * The selection and the answer about it, collapsed into the one value the body
 * renders from.
 *
 * A `loading` read is `none` rather than a third visible state.
 */
const overlayState = (
  site: Site | null,
  hours: QueryState<SiteOverlayHours>,
  unit: ChartUnit,
): OverlayState => {
  if (site === null) {
    return { kind: 'none' };
  }
  if (hours.status === 'failed') {
    return { kind: 'failed', siteName: site.name };
  }
  return hours.status === 'ready'
    ? {
        kind: 'series',
        series: siteOverlaySeries(site, hours.data.forecasts, hours.data.actuals, unit),
      }
    : { kind: 'none' };
};

/**
 * How the dashboard's one-off fleet listing went, as far as this panel needs it.
 *
 * A bare literal union rather than a mirror of the dashboard's own `FleetLoad`
 * (`typing.md` rule 4 asks for a discriminated union where the arms *carry*
 * different data; none of these do).
 */
export type FleetListingStatus = 'loading' | 'ready' | 'failed';

export interface FleetPanelProps {
  readonly dataSource: FleetDataSource;
  /** The dashboard's one site list — listing plus session-created sites. */
  readonly sites: readonly Site[];
  /**
   * How the fleet listing went — the read that produces {@link FleetPanelProps.sites}.
   *
   * The panel needs it because a listing failure and an empty fleet are the same
   * `sites: []` and are not the same news (#452).
   */
  readonly listing: FleetListingStatus;
  /** Re-runs the fleet listing — the recourse the unavailable state offers. */
  readonly onRetryListing: () => void;
  /** The site whose line is drawn over the fleet's, or `null` when none is selected. */
  readonly selectedSite: Site | null;
  /**
   * Whether {@link FleetPanelProps.selectedSite}'s first forecast has arrived —
   * the dashboard's poll, as one boolean.
   *
   * It gates the overlay request rather than merely the drawing.
   */
  readonly selectionReady: boolean;
  /** Bumped by the dashboard when a site is created, to re-sum the fleet. */
  readonly refreshToken: number;
}

export const FleetPanel = ({
  dataSource,
  sites,
  listing,
  onRetryListing,
  selectedSite,
  selectionReady,
  refreshToken,
}: FleetPanelProps): ReactElement => {
  const headingId = useId();
  const [range, setRange] = useState<RangeHours>(DEFAULT_RANGE);
  /*
   * The unit the chart is drawn in, and the reader's or the panel's claim on it.
   */
  const { unit, onToggle } = useChartUnit(selectedSite?.id ?? null);
  /*
   * Retrying is a new question, so it is a new query key rather than an
   * imperative refetch: `useFleetQuery` re-runs on key change and nothing else.
   *
   * Three counters, not one, and the split is about *scope*. A shared counter
   * would make any one recourse re-ask all three.
   */
  const [fleetAttempt, setFleetAttempt] = useState(0);
  const [actualsAttempt, setActualsAttempt] = useState(0);
  const [overlayAttempt, setOverlayAttempt] = useState(0);

  /*
   * An empty fleet has nothing to sum, so it asks nothing.
   *
   * It matters most on a deep link: the listing is briefly in flight with `sites`
   * empty, and a fleet read fired then would be a sum of nothing followed
   * immediately by a second one over the real fleet.
   */
  const enabled = sites.length > 0;

  const forecasts = useFleetQuery(
    () => dataSource.fleetForecasts(range),
    ['fleet-forecasts', range, refreshToken, fleetAttempt],
    { enabled },
  );
  const actuals = useFleetQuery(
    () => dataSource.fleetActuals(range),
    ['fleet-actuals', range, refreshToken, actualsAttempt],
    { enabled },
  );
  /*
   * The selected site's own hours, over the same window as the sum they are
   * drawn on. The key names every input the query reads, which is
   * `useFleetQuery`'s contract — including the site, so changing the selection
   * drops the previous site's answer rather than letting it land on the chart
   * under the next site's name.
   *
   * True from the query's effect onwards, and not for the render in between:
   * `docs/tech-debt.md` has it, with the
   * reason the guard for it belongs in the hooks rather than here.
   */
  const overlayHours = useFleetQuery(
    () => siteOverlayHours(dataSource, selectedSite, range),
    ['site-overlay', selectedSite?.id ?? null, range, overlayAttempt],
    { enabled: selectionReady },
  );

  /*
   * The fleet's answer, and the sum drawn from it — both memoized, and both on
   * the two query states' identities.
   *
   * A render caused by anything else — the dashboard's once-a-second poll during
   * add-a-site — leaves both dependencies untouched and
   * both memos intact. That poll is the measurement `react.md` rule 2 asks for
   * before a `useMemo`: without it the whole fleet's series were re-summed and
   * re-joined every second while a reader watched their new site generate (#293).
   */
  const fleet = useMemo(() => combineFleetQueries(forecasts, actuals), [forecasts, actuals]);
  const aggregate = useMemo(() => chartAggregateOf(fleet, sites, unit), [fleet, sites, unit]);
  /*
   * Whether the legend gets its band row: exactly the question the chart asks of
   * the same points before drawing a band, asked once here because the legend no
   * longer renders where that answer is already computed (the (i) below).
   *
   * `.some` over the drawn points rather than a flag threaded down from the
   * aggregation: "does the plot carry a band" is a question about what is on the
   * chart, and the chart derives it from these same points
   * (`apps/web/src/charts/ForecastChart.tsx`'s `bandRuns`). Two readings of one
   * array cannot disagree; a second producer's boolean could.
   */
  const hasBand = useMemo(
    () => aggregate.points.some((point) => point.band !== undefined),
    [aggregate],
  );

  const { fleetLookback, fleetActuals } = dataSource.capabilities;
  const retryFleet = (): void => {
    setFleetAttempt((previous) => previous + 1);
  };
  const retryActuals = (): void => {
    setActualsAttempt((previous) => previous + 1);
  };
  const retryOverlay = (): void => {
    setOverlayAttempt((previous) => previous + 1);
  };
  // Derived during render: mirroring any of it into state would be a second copy
  // of a fact those values already carry (`react.md` rule 1).
  const context: FleetChartContext = {
    siteCount: sites.length,
    chart: chartCopy(windowLabel(range, fleetLookback, fleetActuals), fleetActuals, unit),
    unit,
    overlay: overlayState(selectedSite, overlayHours, unit),
    onRetryOverlay: retryOverlay,
    onRetryActuals: retryActuals,
  };
  // The legend's fourth row, from the same value the chart's overlay mark is
  // drawn from.
  // Read off `context.overlay` rather than off
  // `selectedSite`, because a site can be selected without its hours having
  // arrived.
  const overlayLabel = context.overlay.kind === 'series' ? context.overlay.series.label : undefined;

  return (
    /*
     * A visible heading, restored by the owner on 2026-08-11 against #323's
     * reading of `design.md` rule 2: a heading over the page's one chart is not
     * only naming it — it is what tells a sighted reader where the fleet's
     * section begins on a page of full-width bands with no card edges left to
     * separate them.
     */
    <section className="fleet-chart-section" aria-labelledby={headingId}>
      {/*
       * The controls row (#284 D4, plus the unit toggle #291 added).
       *
       * It is the positioned ancestor both of its overlays hang from — a contract
       * `apps/web/src/info/InfoTip.tsx` states in its own docblock and this row
       * has to keep; `apps/web/src/dashboard/fleet-panel.css` carries the
       * measurements.
       */}
      <div className="fleet-chart-controls">
        <h2 className="fleet-chart-title" id={headingId}>
          Fleet forecast
        </h2>
        {/*
         * The fleet in one line, and the row's one piece of auxiliary text.
         *
         * **It stays in kW while the toggle beside it is on percent** (#291).
         * `fleetStatsLine` (`apps/web/src/dashboard/fleet-panel-copy.ts`) carries
         * the argument.
         */}
        <p className="fleet-chart-stats">{fleetStatsLine(sites)}</p>
        {/*
         * The subtitle and, since 2026-08-11, the legend — the two things about
         * this chart that are description rather than state (#265).
         *
         * What `docs/design/chart-treatment.md` asks of a legend survives the
         * move: "identity is never carried by colour alone" is discharged by the
         * key being *reachable* and "in every state" structurally, because this
         * row sits outside the state
         * switch below.
         *
         * Both inputs are read off the same facts the plot is drawn from, so the
         * key cannot name a series the plot
         * is not carrying, which is #295's gating rule at its new address.
         */}
        <InfoTip label="About this chart">
          {fleetActuals ? SUBTITLE_WITH_ACTUALS : SUBTITLE_FORECAST_ONLY}
          {forecastChartLegend(overlayLabel, hasBand)}
        </InfoTip>
        {/*
         * What the value axis counts, as a control the reader can act on (#291).
         *
         * **Unconditional, where the picker beside it is not.** A unit is a way of
         * reading numbers the chart already has, so every source that can draw a
         * chart can draw it either way. Gating it would take the toggle away from
         * the demo.
         */}
        <UnitToggle unit={unit} onSelect={onToggle} />
        {/*
         * A control rather than a caption, on both arms that have a window to
         * choose.
         *
         * Nothing on this page lands a reader on it (#328, `design.md` rule
         * 11). What it does do is hand focus *back* on a selection.
         * `apps/web/src/dashboard/range-picker.tsx`'s docblock (§ "Dismissal,
         * and why the shape is copied rather than shared") carries that
         * argument.
         */}
        {fleetLookback || fleetActuals ? (
          <RangePicker range={range} ariaLabel="Aggregation range" onSelect={setRange} />
        ) : null}
      </div>
      {/*
       * Which body the state gets, and the two arms worth explaining.
       *
       * (a) **A listing still in flight with no sites falls to `fleetBody`, on
       * purpose.** Its queries are gated off by `enabled` above, and a query that
       * was never enabled reports its initial `loading`
       * (`apps/web/src/data/use-fleet-query.ts`), so the chart draws the wait and
       * the body marks itself busy (#452).
       *
       * (b) **A failed listing beside sites this session created still gets the
       * chart**: the fleet endpoints are independent of the listing, so if the
       * graph *can* show data it does. Only a failure that leaves nothing to sum
       * is total, which is what the `sites.length === 0` conjunct buys — dropping
       * it would paint the unavailable state over a fleet whose queries can
       * answer.
       */}
      {listing === 'failed' && sites.length === 0
        ? unavailableFleetBody(context, onRetryListing)
        : listing === 'ready' && sites.length === 0
          ? emptyFleetBody(context)
          : fleetBody(fleet, aggregate, context, retryFleet)}
    </section>
  );
};
