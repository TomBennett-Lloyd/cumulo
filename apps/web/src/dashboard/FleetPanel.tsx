import {
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
 * `apps/web/src/dashboard/fleet-panel-body.tsx` holds that arrangement.
 *
 * The trade, stated because it was accepted rather than overlooked: **a `?site=`
 * deep link spends the fleet's forecast read**, one metered request to
 * `GET /v1/fleet/forecast` (#296). #178 deferred that spend behind a reveal, for
 * a reader who never looked at the fleet; #265 removed the region that could
 * hide this panel, so that reader no longer exists and deferring a request for a
 * chart already in front of them would buy nothing and cost a visible wait.
 *
 * ## The listing is one of this panel's inputs, for one question only
 *
 * Since #452 the fleet listing has no surface of its own — the owner routed what
 * was left of it into the chart: *"the sites fetch error state should show in the
 * graph area"*. So `listing` answers the one question an empty `sites` array
 * cannot: nothing to show because the fleet is empty, or because the read that
 * would have told us failed. The two failing reads stay independent — a listing
 * that failed beside sites already in hand still gets a chart, because the fleet
 * endpoints never depended on the listing.
 *
 * ## The selected site is one more series, not a second chart
 *
 * One value axis, never two (`docs/design/chart-treatment.md`) — the point of
 * drawing the site here is that a reader can see how much of the fleet's
 * afternoon is this one roof, and two axes would invent a correlation the
 * numbers do not contain. The chart is the site's *only* chart: its card on the
 * map carries the site's facts and nothing plotted.
 *
 * **What that axis counts is the reader's to choose, and a selection chooses it
 * for them once** (#291). A ~4 kW roof against a ~330 kW fleet is a flat line on
 * an absolute scale, so selecting a site switches the panel to percent of
 * capacity — and a reader who then presses the toggle owns the unit for the rest
 * of that selection. None of those rules live here:
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
 * (`dataSource.capabilities`). `GET /v1/fleet/forecast` serves *future* hours;
 * fleet actuals are synthesised by the forecast service (#264), and synthesised
 * is not measured, so the arm that mentions them says "simulated actuals" and no
 * arm claims a metered reading. The clause is gated on `fleetActuals` rather
 * than reworded, which decides whether actuals are mentioned anywhere including
 * in the chart's accessible name — #150's review finding, and it asked for a
 * structural fix rather than a rewrite.
 *
 * What the *control* is gated on is a wider question, and #284 D5 separated the
 * two. A window is worth choosing wherever a wider one would show more hours,
 * which is true of both flags: `fleetLookback` widens a look-back, and
 * `fleetActuals` alone widens both the horizon the fleet read asks for and the
 * span of simulated actuals behind it. So the picker renders on
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
 * know has happened. The window is no longer readable without a press either
 * since 2026-08-11's fold (`apps/web/src/dashboard/range-picker.tsx` writes that
 * loss down); what carries it now is the chart's accessible name and its table
 * caption, both from `apps/web/src/dashboard/fleet-panel-copy.ts`.
 *
 * The **legend** joined the sentence behind that press on the owner's routing —
 * *"the legend can go in the (i) section"* — as the same line drawn once more: a
 * key answers "which line is which", is read once, and then occupies a row under
 * the plot for the rest of the reading. So this panel owns two facts the chart
 * used to derive for itself — whether the drawn points carry a band, and what
 * the overlay is called — and hands them to
 * `apps/web/src/charts/forecast-chart-legend.tsx`;
 * `apps/web/src/charts/ForecastChart.tsx` renders no legend at all.
 *
 * #323 drew that line against the `<h2>` and the stats line too, and **the owner
 * reversed that half on 2026-08-11**: a heading over the page's one chart is not
 * only naming it, and a fleet's size is a fact the plot states nowhere — a plot
 * of output is not a count of roofs, in either unit. Both are visible text, and
 * the section borrows the heading by `aria-labelledby` rather than spelling the
 * name a second time in an `aria-label`. What did *not* come back is the rest of
 * #323, which stands on its own arguments: still a full-width band rather than a
 * card (`apps/web/src/dashboard/fleet-panel.css`), and the completeness note
 * still has no complete arm (`fleet-panel-body.tsx`).
 *
 * The stats line is the one thing here allowed to disappear, and it disappears
 * by *width* rather than by state: below a measured container width the row
 * cannot hold every item, and the numbers are the item that yields
 * (`design.md` rule 7 — controls have wrap priority over auxiliary text).
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
 * this function.** No state takes the section down, so a state changes what the
 * section *says* and what the plot *has on it*, never whether there is a chart.
 * What differs is weight: a failed forecast is the answer itself not arriving,
 * so it is an `alert` over an empty plot; a failed actuals read is an addition
 * to an answer that did arrive, so it is a `panel-notice` over a plot still
 * carrying every forecast hour. `/v1/fleet/forecast` and `/v1/fleet/actuals` are
 * two metered requests and either can fail alone — a failed actuals read used to
 * be returned here as *the* failure, which withdrew a fleet sum that had already
 * arrived and reported it under the forecast's name, blaming a party that had
 * not failed (`error-handling.md` rule 1's blame tiebreak) and discarding a
 * complete answer to say so (rule 5).
 *
 * Loading waits for both. A chart that painted the forecast and then grew a past
 * half a moment later would be the panel reflowing under a reader already
 * reading it; the single wait it is traded against costs no reflow of its own,
 * because it is a mark drawn inside the plot's existing box rather than a
 * sentence appearing above it (#448).
 */
const combineFleetQueries = (
  forecasts: QueryState<readonly FleetForecastAggregatePoint[]>,
  actuals: QueryState<readonly GenerationReading[]>,
): QueryState<FleetSeries> => {
  if (forecasts.status === 'failed') {
    return forecasts;
  }
  if (forecasts.status === 'loading' || actuals.status === 'loading') {
    return { status: 'loading' };
  }
  const actualsState: FleetActualsState =
    actuals.status === 'failed' ? { kind: 'failed' } : { kind: 'readings', readings: actuals.data };

  return { status: 'ready', data: { forecasts: forecasts.data, actuals: actualsState } };
};

/** No readings is what a failed actuals read leaves the chart: a forecast, and no second series. */
const readingsOf = (actuals: FleetActualsState): readonly GenerationReading[] =>
  actuals.kind === 'readings' ? actuals.readings : [];

/**
 * What the chart draws, for whichever state the two reads are in.
 *
 * The non-ready arms answer with the one shared empty aggregate rather than a
 * fresh one, so the chart is handed the same points array on every render of a
 * panel that is loading or has failed, exactly as the ready arm is handed the
 * same one by the memo below.
 */
const chartAggregateOf = (
  state: QueryState<FleetSeries>,
  sites: readonly Site[],
  unit: ChartUnit,
): FleetChartAggregate =>
  state.status === 'ready'
    ? fleetChartAggregate(state.data.forecasts, readingsOf(state.data.actuals), sites, unit)
    : EMPTY_FLEET_AGGREGATE;

/**
 * The selected site's forecasts, or an empty answer when nothing is selected.
 *
 * The empty arm is not dead: `enabled` gates the *request*, and a caller whose
 * `selectionReady` says yes while holding no site is asking about nobody, which
 * is honestly answered by no hours rather than by a crash. Top-level and fully
 * parameterised so it reads on its own (`structure.md` rule 1).
 */
const siteOverlayForecasts = (
  dataSource: FleetDataSource,
  site: Site | null,
  range: RangeHours,
): Promise<FleetSourceResult<readonly Forecast[]>> =>
  site === null
    ? Promise.resolve({ kind: 'ok', value: [] })
    : dataSource.siteForecasts(site.id, range);

/**
 * The selection and the answer about it, collapsed into the one value the body
 * renders from.
 *
 * A `loading` read is `none` rather than a third visible state: the fleet's
 * chart is already on screen and complete, and a spinner for a line that is
 * about to appear over it would be chrome flashing on top of content the reader
 * is reading. The failure is the one that has to speak, because it is the one
 * that ends with something missing and no other explanation for it.
 */
const overlayState = (
  site: Site | null,
  forecasts: QueryState<readonly Forecast[]>,
  unit: ChartUnit,
): OverlayState => {
  if (site === null) {
    return { kind: 'none' };
  }
  if (forecasts.status === 'failed') {
    return { kind: 'failed', siteName: site.name };
  }
  return forecasts.status === 'ready'
    ? { kind: 'series', series: siteOverlaySeries(site, forecasts.data, unit) }
    : { kind: 'none' };
};

/**
 * How the dashboard's one-off fleet listing went, as far as this panel needs it.
 *
 * A bare literal union rather than a mirror of the dashboard's own `FleetLoad`
 * (`typing.md` rule 4 asks for a discriminated union where the arms *carry*
 * different data; none of these do). The sites themselves arrive on
 * {@link FleetPanelProps.sites}, already merged with whatever this session
 * created, so a `ready` arm holding a list would be a second copy of a prop —
 * and `FleetLoad['status']` is assignable straight to this, which keeps the
 * dashboard from destructuring its own state to satisfy this panel.
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
   * `sites: []` and are not the same news: one is the demo's invitation and the
   * other is the page having nothing to show (#452). It arrives as a prop rather
   * than being asked for here because the listing is the dashboard's one request
   * and this panel must not be a second caller of it.
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
   * It gates the overlay request rather than merely the drawing. A site created
   * seconds ago has no forecast at all, and asking its `/forecast` window on a
   * cadence would spend metered requests to be told so; the poll is already
   * asking that question and is the only surface that should.
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
   *
   * The id rather than the site, because that is the whole of what the hook
   * reads: it watches the *edges* of "something is selected" so a move from one
   * site to another is one continuous episode, and a value that changed on every
   * site would have to be compared for nullity anyway. Every rule about when the
   * unit moves lives in `chart-unit.ts`; nothing here re-decides one.
   */
  const { unit, onToggle } = useChartUnit(selectedSite?.id ?? null);
  /*
   * Retrying is a new question, so it is a new query key rather than an
   * imperative refetch: `useFleetQuery` re-runs on key change and nothing else,
   * and a counter is the smallest honest way to say "ask again".
   *
   * Three counters, not one, and the split is about *scope*. Each read answers a
   * different question — the fleet's forecasts, the fleet's simulated actuals,
   * one selected site's hours — so a shared counter would make any one recourse
   * re-ask all three, and a reader pressing "try again" on the single series that
   * failed would spend two further metered requests refetching answers that had
   * already arrived. Refetching a series that never failed is waste at any price,
   * which is why the split outlived the price asymmetry #264's review found (both
   * fleet reads are one metered request each since #296).
   */
  const [fleetAttempt, setFleetAttempt] = useState(0);
  const [actualsAttempt, setActualsAttempt] = useState(0);
  const [overlayAttempt, setOverlayAttempt] = useState(0);

  /*
   * An empty fleet has nothing to sum, so it asks nothing — the whole of the
   * gate, now that no reveal is left to defer the first fleet read to.
   *
   * It matters most on a deep link: the listing is briefly in flight with `sites`
   * empty, and a fleet read fired then would be a sum of nothing followed
   * immediately by a second one over the real fleet.
   *
   * The *state* the gate leaves behind is load-bearing as well as frugal. A query
   * that was never enabled reports its initial `loading`
   * (`apps/web/src/data/use-fleet-query.ts`), so a panel waiting on the listing
   * draws the wait rather than announcing an empty fleet it has not been told
   * about — which is what lets the body switch below leave that case to
   * `fleetBody` instead of carrying an arm of its own (#452).
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
   * that hook resets to `loading` from an effect, so one committed frame after a
   * selection moves still holds the previous site's data while the label below
   * has already followed the new prop. `docs/tech-debt.md` has it, with the
   * reason the guard for it belongs in the hooks rather than here.
   */
  const overlayForecasts = useFleetQuery(
    () => siteOverlayForecasts(dataSource, selectedSite, range),
    ['site-overlay', selectedSite?.id ?? null, range, overlayAttempt],
    { enabled: selectionReady },
  );

  /*
   * The fleet's answer, and the sum drawn from it — both memoized, and both on
   * the two query states' identities.
   *
   * `useFleetQuery` holds its state in `useState`, so each of these values is one
   * object per state transition and unchanged in between; a render caused by
   * anything else — the range picker, a retry counter, the dashboard's
   * once-a-second poll during add-a-site — leaves both dependencies untouched and
   * both memos intact. That poll is the measurement `react.md` rule 2 asks for
   * before a `useMemo`: without it the whole fleet's series were re-summed and
   * re-joined every second while a reader watched their new site generate (#293).
   *
   * The first memo is not about cost — combining two query states is three
   * comparisons — but about being an honest dependency for the second, which a
   * fresh object per render would defeat. Stabilizing it at its source is what
   * rule 2 asks for instead of trimming a dependency array.
   *
   * `sites` (#335) and `unit` (#291) are listed for the same reason rather than
   * trimmed: both are genuine inputs — where the sites are decides which hours
   * are shaded, and the unit decides what the summed hours are rescaled to — and
   * neither costs the memo anything, because `Dashboard` memoizes `sites` and the
   * unit moves only on a toggle press or a selection edge. An aggregate memoized
   * past a unit change would leave the chart drawing kW under a percent axis.
   */
  const fleet = useMemo(() => combineFleetQueries(forecasts, actuals), [forecasts, actuals]);
  const aggregate = useMemo(() => chartAggregateOf(fleet, sites, unit), [fleet, sites, unit]);
  /*
   * Whether the legend gets its band row: exactly the question the chart asks of
   * the same points before drawing a band, asked once here because the legend no
   * longer renders where that answer is already computed (the (i) below).
   *
   * Memoized on the same grounds as the two memos above rather than by reflex
   * (`react.md` rule 2): the dashboard's add-a-site poll re-renders this about
   * once a second, and this is a scan of every hour on the chart for a value that
   * changes only when a new aggregate does.
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
  // Derived during render: what the body draws is exactly a function of the
  // props and the answers about them, and mirroring any of it into state would
  // be a second copy of a fact those values already carry (`react.md` rule 1).
  const context: FleetChartContext = {
    siteCount: sites.length,
    chart: chartCopy(windowLabel(range, fleetLookback, fleetActuals), fleetActuals, unit),
    unit,
    overlay: overlayState(selectedSite, overlayForecasts, unit),
    onRetryOverlay: retryOverlay,
    onRetryActuals: retryActuals,
  };
  // The legend's fourth row, from the same value the chart's overlay mark is
  // drawn from: `none` and `failed` are both "no second series on the plot", and
  // a legend naming a line that is not there is the failure the row is gated
  // against. Read off `context.overlay` rather than off `selectedSite`, because
  // a site can be selected without its hours having arrived.
  const overlayLabel = context.overlay.kind === 'series' ? context.overlay.series.label : undefined;

  return (
    /*
     * A visible heading, restored by the owner on 2026-08-11 against #323's
     * reading of `design.md` rule 2: a heading over the page's one chart is not
     * only naming it — it is what tells a sighted reader where the fleet's
     * section begins on a page of full-width bands with no card edges left to
     * separate them.
     *
     * `aria-labelledby` rather than `aria-label`, now that there is an element to
     * point at: the name is written once and the landmark borrows it. `useId`
     * because a hand-written id would collide the moment a second panel rendered.
     */
    <section className="fleet-chart-section" aria-labelledby={headingId}>
      {/*
       * The controls row (#284 D4, plus the unit toggle #291 added).
       *
       * It is the positioned ancestor both of its overlays hang from — a contract
       * `apps/web/src/info/InfoTip.tsx` states in its own docblock and this row
       * has to keep. It is what clamps the tip's panel and the window sheet to
       * the row's width and right edge instead of letting either run off the
       * page; `apps/web/src/dashboard/fleet-panel.css` carries the measurements.
       *
       * Document order is the reading order and the tab order at once, which is
       * why the two controls come last: a reader meets the section's name, then
       * what it is a summary of, then the things they can press. The controls
       * reach the row's end by a margin on the (i) rather than a
       * `justify-content` that would space all four apart.
       *
       * `flex-wrap` does the job #284 D4 gave it: at a width that cannot hold the
       * controls the picker takes its own line rather than being crushed
       * (`design.md` rule 7 — controls have wrap priority). What gives way
       * *before* that is the stats line, which the stylesheet hides whole below a
       * measured container width.
       */}
      <div className="fleet-chart-controls">
        <h2 className="fleet-chart-title" id={headingId}>
          Fleet forecast
        </h2>
        {/*
         * The fleet in one line, and the row's one piece of auxiliary text.
         *
         * **It stays in kW while the toggle beside it is on percent** (#291).
         * The line states the fleet's installed capacity, which is the divisor
         * the percentages are taken against — in percent mode it is the thing
         * 100% means — so kW here is informative rather than inconsistent, and a
         * capacity restated as a percentage of itself would say nothing at all.
         * `fleetStatsLine` (`apps/web/src/dashboard/fleet-panel-copy.ts`) carries
         * the argument; this note exists so a reader looking at a percent axis
         * over a kW line does not read it as a bug.
         */}
        <p className="fleet-chart-stats">{fleetStatsLine(sites)}</p>
        {/*
         * The subtitle and, since 2026-08-11, the legend — the two things about
         * this chart that are description rather than state (#265, and the
         * owner's routing: *"the legend can go in the (i) section"*).
         *
         * `fleetActuals` chooses between two complete sentences rather than
         * assembling a clause, so "simulated actuals" stays readable as belonging
         * to exactly one arm.
         *
         * What `docs/design/chart-treatment.md` asks of a legend survives the
         * move: "identity is never carried by colour alone" is discharged by the
         * key being *reachable* — one press on a named, keyboard-operable
         * control, the same standard the table twin's disclosure is held to — and
         * "in every state" structurally, because this row sits outside the state
         * switch below.
         *
         * Both inputs are read off the same facts the plot is drawn from —
         * `hasBand` scans the drawn points, `overlayLabel` comes off the overlay
         * state the chart's mark reads — so the key cannot name a series the plot
         * is not carrying, which is #295's gating rule at its new address.
         */}
        <InfoTip label="About this chart">
          {fleetActuals ? SUBTITLE_WITH_ACTUALS : SUBTITLE_FORECAST_ONLY}
          {forecastChartLegend(overlayLabel, hasBand)}
        </InfoTip>
        {/*
         * What the value axis counts, as a control the reader can act on (#291).
         *
         * **Unconditional, where the picker beside it is not.** A window is only
         * worth offering where a wider one would show more hours, which is a
         * capability question; a unit is a way of reading numbers the chart
         * already has, so every source that can draw a chart can draw it either
         * way. Gating it would take the toggle away from the demo — the surface
         * the site overlay was built for, and the one where a ~4 kW roof against
         * a ~330 kW fleet is most visible.
         *
         * Outside the state switch below for the reason the (i) and the picker
         * are: this row is the panel's furniture, and furniture that appeared
         * when the first read landed would be the reading rearranging itself
         * under a reader looking at it. A toggle pressed while the fleet is still
         * loading changes the unit the arriving answer is drawn in, which is the
         * honest thing for it to do.
         */}
        <UnitToggle unit={unit} onSelect={onToggle} />
        {/*
         * A control rather than a caption, on both arms that have a window to
         * choose. It stays visible for an empty fleet too — furniture that
         * appeared when the first site landed would rearrange the reading under
         * the reader — and an empty fleet asks the source nothing whatever the
         * picker says, because `enabled` above gates the queries and not this.
         *
         * Nothing on this page lands a reader on it (#328, `design.md` rule 11).
         * What it does do is hand focus *back* on a selection: choosing a window
         * closes the popover and the buttons the reader was standing on leave the
         * document with it, so without the hand-back a keyboard reader is dropped
         * on `body`. `apps/web/src/dashboard/range-picker.tsx`'s docblock
         * (§ "Dismissal, and why the shape is copied rather than shared") carries
         * that argument.
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
       * the body marks itself busy — the honest answer, and what retires the
       * false "No sites yet" flash a reader used to get for the length of the
       * listing read (#452).
       *
       * (b) **A failed listing beside sites this session created still gets the
       * chart**: the fleet endpoints are independent of the listing, so if the
       * graph *can* show data it does. Only a failure that leaves nothing to sum
       * is total, which is what the `sites.length === 0` conjunct buys — dropping
       * it would paint the unavailable state over a fleet whose queries can
       * answer.
       *
       * An empty fleet is not a failure and keeps its own arm: a listing that
       * succeeded and returned nothing is a complete answer, and the demo's
       * invitation is what it is owed (`error-handling.md` rule 5 — degrade
       * honestly, in both directions).
       */}
      {listing === 'failed' && sites.length === 0
        ? unavailableFleetBody(context, onRetryListing)
        : listing === 'ready' && sites.length === 0
          ? emptyFleetBody(context)
          : fleetBody(fleet, aggregate, context, retryFleet)}
    </section>
  );
};
