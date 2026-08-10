import { type Forecast, type GenerationReading, type Site } from '@cumulo/shared';
import { useId, useMemo, useState, type ReactElement, type RefObject } from 'react';

import type { FleetDataSource, FleetSourceResult, RangeHours } from '../data/fleet-data-source';
import { useFleetQuery, type QueryState } from '../data/use-fleet-query';
import { InfoTip } from '../info/InfoTip';
import {
  emptyFleetBody,
  fleetBody,
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

/*
 * The fleet's story, and — while a site is selected — that site's line over it.
 *
 * ## One chart, always on screen
 *
 * This panel used to be the *resting* state of a context region that a site
 * panel could take from it, so it was rendered `hidden` rather than unmounted
 * and its first fleet read was deferred until it was first revealed (#178). #265
 * removed the region: a site's card is anchored to its marker on the map now,
 * nothing displaces this panel, and there is no hidden state left to model. The
 * latch went with it.
 *
 * The trade that leaves, stated because it is a real cost and it was accepted
 * rather than overlooked: **a `?site=` deep link now spends the fleet's forecast
 * read**, which in live mode is one metered request to `GET /v1/fleet/forecast`
 * (#296 — the browser used to ask each site in turn instead, and the per-site
 * Queries that answers it now run server-side, inside that one request). #178
 * saved that spend for a reader who never looked at the fleet, and a reader who
 * never looks at the fleet is exactly who no longer exists — the fleet chart is
 * on screen from first paint in every state of the page. Deferring a request for
 * a chart the reader is already looking at would buy nothing and cost a spinner.
 *
 * "In every state" is now structural rather than merely usual: the body renders
 * one `.forecast-chart-figure` whether the fleet is loading, failed, empty,
 * forecastless or ready, and the states differ only in what is said above it
 * (#284 D3). `fleet-panel-body.tsx` holds that arrangement and the reasoning.
 *
 * ## The selected site is one more series, not a second chart
 *
 * When a site is selected and its first forecast has arrived, this panel fetches
 * that site's forecasts and hands them to `ForecastChart` as an overlay. One kW
 * axis, never two (`docs/design/chart-treatment.md`) — the point of drawing the
 * site here at all is that a reader can see how much of the fleet's afternoon is
 * this one roof, and two axes would invent a correlation the numbers do not
 * contain. The chart is the site's *only* chart: its card on the map carries the
 * site's facts and the state of its first forecast, and nothing plotted.
 *
 * That second read fails on its own terms, and says so on its own terms. The
 * fleet's sum is not withdrawn because an addition to it did not arrive — but an
 * addition that failed *silently* is indistinguishable from a site whose output
 * tracks the fleet, so the panel labels the chart partial and offers a retry
 * that re-asks for that one site (`error-handling.md` rule 5). The two retries
 * are separate counters on purpose; the comments on them say why.
 *
 * ## Capability honesty is structural here, not editorial
 *
 * This panel says only what the source it holds can actually answer
 * (`dataSource.capabilities`). A fleet-level read in live mode is one request to
 * `GET /v1/fleet/forecast`, which serves *future* hours only; fleet
 * actuals do have a producer now — the forecast service synthesises them (#264)
 * — but synthesised is not measured, so the arm that mentions them says
 * "simulated actuals" and no arm claims a metered reading. Rather than carrying
 * copy that is right half the time, the clause is gated on `fleetActuals`, which
 * decides whether actuals are mentioned anywhere, including in the chart's
 * accessible name. That was #150's review finding, and the fix it asked for was
 * structural rather than a rewording.
 *
 * What the *control* is gated on is a wider question than what the copy is, and
 * #284 D5 separated the two. A window is worth choosing wherever a wider one
 * would show the reader more hours, and that is true of both flags: with
 * `fleetLookback` the picker widens a look-back, and with `fleetActuals` alone
 * it widens the horizon the fleet read asks for *and* the span of simulated actuals
 * behind it. So the picker renders on `fleetLookback || fleetActuals` and only a
 * source with neither — a bare forward horizon, pinned to
 * {@link DEFAULT_RANGE} because nothing can call `setRange` — goes without one.
 * That pin is what lets `windowLabel`'s no-capability arm name 24 hours outright.
 *
 * ## Description behind a press, state on the page
 *
 * One of this panel's sentences is a description — what the chart is a sum of —
 * and it sits behind an (i) (`info/InfoTip.tsx`, #265). It was read once and
 * then occupied a line on every render, above a chart that is the reason anyone
 * is here. There was a second (i) beside it, naming the window for the arm with
 * no picker; #284 D5 deleted it rather than moving it, because the picker now
 * renders on that arm and states the window as a control the reader can act on.
 * What has never moved is everything the panel says about its current state: the
 * completeness note, and the notice that a selected site's line failed. A reader
 * cannot press for news they do not know has happened, so state stays where it
 * can be seen and description is one press away.
 *
 * ## Attribution
 *
 * There is deliberately no Open-Meteo credit inside this panel. The page carries
 * one persistent credit in its footer, which stays on screen through every state
 * the reading can be in; a second one here would be the same obligation
 * discharged twice on the same flow.
 */

/** Both fleet reads open on the nearest window, whether or not a picker can move it. */
const DEFAULT_RANGE: RangeHours = 24;

/**
 * Collapse the two queries into the one state the panel renders.
 *
 * **The two failures are not symmetrical, and that asymmetry is the whole of
 * this function.** Nothing takes the panel down any more: since #284 D3 the
 * heading row, the figure and its legend are on screen in every state, so a
 * failure changes what the panel *says* and what the plot *has on it*, never
 * whether there is a chart. What survives is the difference in weight — a failed
 * forecast is the answer itself not arriving, so it is an `alert` over a plot
 * with nothing drawn on it; a failed actuals read is an addition to an answer
 * that did arrive, so it is a `panel-notice` over a plot still carrying every
 * forecast hour. These are two requests over two windows — one metered
 * `/v1/fleet/forecast` call and one metered `/v1/fleet/actuals` call — so either
 * can fail alone, and a failed actuals read used to be returned here as *the*
 * failure: the panel then withdrew a fleet sum that had already arrived and
 * reported it under the forecast's name, blaming a party that had not failed
 * (`error-handling.md` rule 1's blame tiebreak) and discarding a complete answer
 * to say so (rule 5). A failed actuals read is now a `ready` state carrying a
 * `failed` actuals arm, which the body draws as the chart plus a notice.
 *
 * Loading still waits for both. A chart that painted the forecast and then grew
 * a past half a moment later would be the panel reflowing under a reader who is
 * already reading it, which is a worse trade than one spinner.
 */
const combineFleetQueries = (
  forecasts: QueryState<readonly Forecast[]>,
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
const chartAggregateOf = (state: QueryState<FleetSeries>): FleetChartAggregate =>
  state.status === 'ready'
    ? fleetChartAggregate(state.data.forecasts, readingsOf(state.data.actuals))
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
): OverlayState => {
  if (site === null) {
    return { kind: 'none' };
  }
  if (forecasts.status === 'failed') {
    return { kind: 'failed', siteName: site.name };
  }
  return forecasts.status === 'ready'
    ? { kind: 'series', series: siteOverlaySeries(site, forecasts.data) }
    : { kind: 'none' };
};

export interface FleetPanelProps {
  readonly dataSource: FleetDataSource;
  /** The dashboard's one site list — listing plus session-created sites. */
  readonly sites: readonly Site[];
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
  /**
   * Handed to the window picker, which points it at its pressed button.
   *
   * The dashboard's concern rather than this panel's: a reader-initiated
   * selection lands focus on the picker (#284 D14, `map/SitePopoverCard.tsx`),
   * and the two ends of that rule sit in different halves of the page — the
   * card is on the map, the control it lands on is here. The panel reads
   * nothing from it and behaves identically without one, which is why it is
   * optional: a caller with no focus rule to serve has nothing to point
   * anywhere. On the arm that renders no picker it simply never fills, and the
   * card falls back to its own heading.
   */
  readonly rangePickerRef?: RefObject<HTMLButtonElement | null>;
}

export const FleetPanel = ({
  dataSource,
  sites,
  selectedSite,
  selectionReady,
  refreshToken,
  rangePickerRef,
}: FleetPanelProps): ReactElement => {
  const headingId = useId();
  const [range, setRange] = useState<RangeHours>(DEFAULT_RANGE);
  /*
   * Retrying is a new question, so it is a new query key rather than an
   * imperative refetch: `useFleetQuery` re-runs on key change and nothing else,
   * and a counter is the smallest honest way to say "ask again".
   *
   * Three counters, not one, and the split is about *scope*. Each of the three
   * reads answers a different question — the fleet's forecasts, the fleet's
   * simulated actuals, one selected site's own hours — so a shared counter would
   * make any one recourse re-ask all three, and a reader pressing "try again" on
   * the single series that failed would spend two further metered requests
   * refetching answers that had already arrived.
   *
   * The split used to be about price as well, and that half has expired: until
   * #296 the forecast's retry re-spent a per-site fan-out over the whole fleet
   * while the actuals' re-asked one metered request, which is why the actuals
   * got their own counter in #264's review — they had been keyed on
   * `fleetAttempt` alongside it, so the one button offered for the cheapest
   * failure on the panel was spending the most expensive request on it. Both
   * fleet reads are one metered request each now, so the asymmetry is gone and
   * the reason for three counters is not: refetching a series that never failed
   * is waste at any price.
   */
  const [fleetAttempt, setFleetAttempt] = useState(0);
  const [actualsAttempt, setActualsAttempt] = useState(0);
  const [overlayAttempt, setOverlayAttempt] = useState(0);

  /*
   * An empty fleet has nothing to sum, so it asks nothing. That is the whole of
   * the gate now: this panel is on screen in every state of the page, so there
   * is no longer a reader who might never look at it and no reveal to defer the
   * first fleet read to (#178, retired with the context region in #265 — the
   * docblock above states the trade).
   *
   * It still matters on a deep link, for a different reason than it used to: the
   * listing is briefly in flight with `sites` empty, and a fleet read fired then
   * would be a sum of nothing followed immediately by a second one over the real
   * fleet.
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
   * `useFleetQuery` holds its state in `useState`, so each of these values is
   * one object per state transition and unchanged in between; a render caused by
   * anything else — the range picker, a retry counter, the dashboard's
   * once-a-second poll during add-a-site — leaves both dependencies untouched
   * and both memos intact. That poll is why this is measured rather than
   * decorative (`react.md` rule 2 asks for exactly that before a `useMemo`):
   * without it, a 60-site fleet's series were re-summed and re-joined every
   * second while a reader watched their new site generate (#293).
   *
   * The first memo is not about cost — combining two query states is three
   * comparisons — but about being an honest dependency for the second. Its
   * result is a fresh object per render otherwise, which would defeat the memo
   * that reads it; stabilizing it at its source is what `react.md` rule 2 asks
   * for instead of trimming a dependency array.
   */
  const fleet = useMemo(() => combineFleetQueries(forecasts, actuals), [forecasts, actuals]);
  const aggregate = useMemo(() => chartAggregateOf(fleet), [fleet]);

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
    chart: chartCopy(windowLabel(range, fleetLookback, fleetActuals), fleetActuals),
    overlay: overlayState(selectedSite, overlayForecasts),
    onRetryOverlay: retryOverlay,
    onRetryActuals: retryActuals,
  };

  return (
    <section className="fleet-panel" aria-labelledby={headingId}>
      {/*
       * One row, and everything the panel knows about itself is in it: what it
       * is, how big the fleet is, the description behind an (i), and the window
       * control. Four stacked lines used to sit between the top of the panel and
       * the chart; a wrapping flex row spends one (#284 D4), and `flex-wrap` is
       * what makes that safe — at a width that cannot hold all four the picker
       * drops to its own line instead of crushing the numbers.
       */}
      <header className="fleet-panel-header">
        <h2 className="fleet-panel-title" id={headingId}>
          Fleet forecast
        </h2>
        <p className="fleet-panel-stats">{fleetStatsLine(sites)}</p>
        {/*
         * The subtitle, behind an (i) since #265. It was a paragraph under the
         * heading that every reader read once and then scrolled past on every
         * render — description rather than state, which is the line this page
         * now draws: what the panel *is* goes behind a press, what the panel
         * currently *says* (the completeness note, an overlay that failed)
         * stays inline, because a reader cannot ask for news they do not know
         * has happened.
         *
         * The capability arms are untouched by the move and stay whole:
         * `fleetActuals` still chooses between two complete sentences rather
         * than assembling a clause, so "simulated actuals" is still readable
         * as belonging to exactly one arm.
         */}
        <InfoTip label="About this chart">
          {fleetActuals ? SUBTITLE_WITH_ACTUALS : SUBTITLE_FORECAST_ONLY}
        </InfoTip>
        {/*
         * A control rather than a caption, on both arms that have a window to
         * choose. It stays visible for an empty fleet too: it is part of the
         * panel's furniture, and furniture that appears when the first site
         * lands is the reading rearranging itself under a reader who was
         * looking at it. An empty fleet asks the source nothing whatever the
         * picker says, because `enabled` gates the queries and not this.
         *
         * It is also where a reader-initiated selection puts the focus (#284
         * D14): {@link FleetPanelProps.rangePickerRef} reaches the pressed
         * button through it, so the card on the map can land a reader on a
         * control that is on screen in every state this panel can be in.
         */}
        {fleetLookback || fleetActuals ? (
          <RangePicker
            range={range}
            ariaLabel="Aggregation range"
            onSelect={setRange}
            pressedButtonRef={rangePickerRef}
          />
        ) : null}
      </header>
      {sites.length === 0
        ? emptyFleetBody(context)
        : fleetBody(fleet, aggregate, context, retryFleet)}
    </section>
  );
};
