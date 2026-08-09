import {
  aggregateFleetActuals,
  aggregateFleetForecast,
  type Forecast,
  type GenerationReading,
  type Site,
} from '@cumulo/shared';
import { useId, useState, type ReactElement } from 'react';

import { ForecastChart } from '../charts/ForecastChart';
import type { ChartOverlaySeries, ForecastChartPoint } from '../charts/ForecastChart';
import type { FleetDataSource, FleetSourceResult, RangeHours } from '../data/fleet-data-source';
import { useFleetQuery, type QueryState } from '../data/use-fleet-query';
import { InfoTip } from '../info/InfoTip';
import {
  chartCopy,
  fleetStatsLine,
  HORIZON_CAPTION,
  SUBTITLE_FORECAST_ONLY,
  SUBTITLE_WITH_ACTUALS,
  windowLabel,
  WINDOW_CAPTION_WITH_ACTUALS,
  type ChartCopy,
} from './fleet-panel-copy';
import { joinFleetSeries, minimumContributingSites } from './fleet-series';
import { PanelEmpty, PanelError, PanelPending } from './panel-states';
import { RangePicker } from './range-picker';
import { siteOverlaySeries } from './site-overlay';
import {
  aggregatedFromCaption,
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
 * The fleet's story, and — while a site is selected — that site's line over it.
 *
 * ## One chart, always on screen
 *
 * This panel used to be the *resting* state of a context region that a site
 * panel could take from it, so it was rendered `hidden` rather than unmounted
 * and its first fan-out was deferred until it was first revealed (#178). #265
 * removed the region: a site's card is anchored to its marker on the map now,
 * nothing displaces this panel, and there is no hidden state left to model. The
 * latch went with it.
 *
 * The trade that leaves, stated because it is a real cost and it was accepted
 * rather than overlooked: **a `?site=` deep link now spends the fleet fan-out**,
 * which in live mode is a paced per-site request (~8 s over 60 sites). #178
 * saved that spend for a reader who never looked at the fleet, and a reader who
 * never looks at the fleet is exactly who no longer exists — the fleet chart is
 * on screen from first paint in every state of the page. Deferring a request for
 * a chart the reader is already looking at would buy nothing and cost a spinner.
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
 * (`dataSource.capabilities`). A fleet-level read in live mode is a fan-out over
 * the per-site `/forecast` route, which serves *future* hours only; fleet
 * actuals do have a producer now — the forecast service synthesises them (#264)
 * — but synthesised is not measured, so the arm that mentions them says
 * "simulated actuals" and no arm claims a metered reading. Rather than carrying
 * copy that is right half the time, the control and the clause are both gated on
 * the flags: `fleetLookback` decides whether a window can be chosen at all,
 * `fleetActuals` decides whether actuals are mentioned anywhere, including in
 * the chart's accessible name. That was #150's review finding, and the fix it
 * asked for was structural rather than a rewording.
 *
 * The two flags move independently, and #264 makes the combination that had no
 * source in it — no look-back, but actuals — the live source's own state. When
 * `fleetLookback` is false the range is pinned to 24 by construction: the picker
 * is the only thing that ever calls `setRange`, so no picker means no second
 * value, and a tip beside the chart states the window the reader is actually
 * looking at for anyone who asks — a bare forward horizon without actuals, and
 * the past 24 hours plus the next 24 with them, because a plot carrying actuals
 * reaches behind the horizon whether or not a picker exists.
 *
 * ## Description behind a press, state on the page
 *
 * Two of this panel's sentences are descriptions — what the chart is a sum of,
 * and which window it covers — and both sit behind an (i) now
 * (`info/InfoTip.tsx`, #265). They were read once and then occupied a line each
 * on every render, above a chart that is the reason anyone is here. What did
 * *not* move is everything the panel says about its current state: the
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

/** Both fleet reads open on the nearest window, and stay there without a picker. */
const DEFAULT_RANGE: RangeHours = 24;

/**
 * What the fleet's second read contributed, once the first one has answered.
 *
 * A union rather than a list plus a boolean (`typing.md` rule 4): "some readings
 * and also a failure" is not a state this panel has — the actuals arrive whole
 * or not at all — and the failed arm carries nothing because the notice it
 * produces names no detail.
 */
type FleetActualsState =
  | { readonly kind: 'readings'; readonly readings: readonly GenerationReading[] }
  | { readonly kind: 'failed' };

/** The two source calls this panel makes, once the forecast has answered. */
interface FleetSeries {
  readonly forecasts: readonly Forecast[];
  readonly actuals: FleetActualsState;
}

/**
 * Collapse the two queries into the one state the panel renders.
 *
 * **Only the forecast can take the panel down, and that asymmetry is the whole
 * of this function.** These are two requests over two windows — a per-site
 * forecast fan-out and one metered `/v1/fleet/actuals` call — so either can fail
 * alone, and a failed actuals read used to be returned here as *the* failure:
 * the panel then withdrew a fleet sum that had already arrived and reported it
 * under the forecast's name, blaming a party that had not failed
 * (`error-handling.md` rule 1's blame tiebreak) and discarding a complete answer
 * to say so (rule 5). A failed actuals read is now a `ready` state carrying a
 * `failed` actuals arm, which `readyBody` draws as the chart plus a notice.
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
  return {
    status: 'ready',
    data: {
      forecasts: forecasts.data,
      actuals:
        actuals.status === 'failed'
          ? { kind: 'failed' }
          : { kind: 'readings', readings: actuals.data },
    },
  };
};

/**
 * The completeness line, stated in both directions.
 *
 * `minContributing` and `siteCount` are both rendered because "partial" without
 * the two numbers is a shrug: the reader needs to know whether one site is
 * missing or fifty.
 */
const completenessNote = (minContributing: number, siteCount: number): ReactElement =>
  minContributing < siteCount ? (
    <p className="panel-notice">{partialAggregateNotice(minContributing, siteCount)}</p>
  ) : (
    <p className="panel-caption">{aggregatedFromCaption(siteCount)}</p>
  );

/**
 * Everything the body needs that is not the fleet's own numbers, as one value.
 *
 * Threaded rather than passed as four more parameters: `readyBody` and
 * `fleetBody` are top-level functions precisely so they can be read without the
 * component around them (`structure.md` rule 1), and a signature that grows a
 * parameter per surface stops being readable at about this point.
 */
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
type OverlayState =
  | { readonly kind: 'none' }
  | { readonly kind: 'series'; readonly series: ChartOverlaySeries }
  | { readonly kind: 'failed'; readonly siteName: string };

interface FleetChartContext {
  readonly siteCount: number;
  readonly chart: ChartCopy;
  readonly overlay: OverlayState;
  /** Re-asks for the selected site's hours, and only those. */
  readonly onRetryOverlay: () => void;
  /** Re-asks for the fleet's readings, and only those — never the forecast fan-out. */
  readonly onRetryActuals: () => void;
}

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
 * The retry is offered because re-asking genuinely can work *and* is cheap: one
 * site's hours, or the fleet's one metered actuals request. Neither re-spends
 * the paced per-site forecast fan-out, which is the test `react.md` sets for
 * offering a retry at all.
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

/** No readings is what a failed actuals read leaves the chart: a forecast, and no second series. */
const readingsOf = (actuals: FleetActualsState): readonly GenerationReading[] =>
  actuals.kind === 'readings' ? actuals.readings : [];

const readyBody = (data: FleetSeries, context: FleetChartContext): ReactElement => {
  const forecastPoints = aggregateFleetForecast(data.forecasts);
  if (forecastPoints.length === 0) {
    return <PanelEmpty message={NO_FLEET_FORECAST_MESSAGE} />;
  }

  return (
    <div className="fleet-panel-body">
      {completenessNote(minimumContributingSites(forecastPoints), context.siteCount)}
      {actualsNote(data.actuals, context.onRetryActuals)}
      {overlayNote(context.overlay, context.onRetryOverlay)}
      {fleetChart(
        joinFleetSeries(forecastPoints, aggregateFleetActuals(readingsOf(data.actuals))),
        context,
      )}
    </div>
  );
};

const fleetBody = (
  state: QueryState<FleetSeries>,
  context: FleetChartContext,
  onRetry: () => void,
): ReactElement => {
  if (state.status === 'loading') {
    return <PanelPending label={LOADING_FLEET_FORECAST_LABEL} />;
  }
  if (state.status === 'failed') {
    // The sentence is `state-copy.ts`'s; what this panel decides is the retry,
    // which is offered because the fan-out is the one request a transient
    // failure genuinely can outlive.
    return (
      <PanelError message={fleetForecastFailureMessage(state.error.message)} onRetry={onRetry} />
    );
  }
  return readyBody(state.data, context);
};

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
}

export const FleetPanel = ({
  dataSource,
  sites,
  selectedSite,
  selectionReady,
  refreshToken,
}: FleetPanelProps): ReactElement => {
  const headingId = useId();
  const [range, setRange] = useState<RangeHours>(DEFAULT_RANGE);
  /*
   * Retrying is a new question, so it is a new query key rather than an
   * imperative refetch: `useFleetQuery` re-runs on key change and nothing else,
   * and a counter is the smallest honest way to say "ask again".
   *
   * Three counters, not one, and the split is about cost. The forecast's retry
   * re-spends a paced per-site fan-out; the actuals' re-asks one metered
   * `/v1/fleet/actuals` request; the overlay's re-asks a single site for a single
   * window. A shared counter makes every cheap recourse buy the expensive request
   * too — a reader pressing "try again" on one missing series would silently
   * re-sum sixty sites — and makes the expensive one refetch series that never
   * failed. The actuals got their own in #264's review: they had been keyed on
   * `fleetAttempt` alongside the fan-out, so the one button offered for the
   * cheapest failure on the panel was spending the most expensive request on it.
   */
  const [fleetAttempt, setFleetAttempt] = useState(0);
  const [actualsAttempt, setActualsAttempt] = useState(0);
  const [overlayAttempt, setOverlayAttempt] = useState(0);

  /*
   * An empty fleet has nothing to sum, so it asks nothing. That is the whole of
   * the gate now: this panel is on screen in every state of the page, so there
   * is no longer a reader who might never look at it and no reveal to defer the
   * first fan-out to (#178, retired with the context region in #265 — the
   * docblock above states the trade).
   *
   * It still matters on a deep link, for a different reason than it used to: the
   * listing is briefly in flight with `sites` empty, and a fan-out fired then
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
  // Derived during render: what the selection contributes is exactly a function
  // of the site and the answer about it, and mirroring that into state would be
  // a second copy of a fact the two values already carry (`react.md` rule 1).
  const overlay = overlayState(selectedSite, overlayForecasts);

  return (
    <section className="fleet-panel" aria-labelledby={headingId}>
      <header className="fleet-panel-header">
        <div className="fleet-panel-titles">
          <h2 className="fleet-panel-title" id={headingId}>
            Fleet
          </h2>
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
        </div>
        <p className="fleet-panel-stats">{fleetStatsLine(sites)}</p>
      </header>
      {sites.length === 0 ? (
        // The empty fleet is the demo's invitation, so it gets the panel to
        // itself: no picker over nothing, and no failed query reported for a
        // sum the reader never asked for.
        <PanelEmpty message={EMPTY_FLEET_MESSAGE} />
      ) : (
        <>
          {/*
           * No add-a-site hint here any more. The map carries a labelled
           * control for that now (`map/MapControls.tsx`), and a paragraph
           * explaining a visible button is both redundant and the half most
           * likely to be left describing an interaction that has moved on
           * — which is exactly what it was doing.
           */}
          {/*
           * A control on one arm, a description on the other — and only the
           * description moved behind an (i). The picker stays inline because it
           * is something the reader *does*: an affordance nobody can see is an
           * affordance nobody uses, which is the whole reason the add-a-site
           * hint above became a labelled control on the map rather than more
           * prose. The horizon caption is the opposite — it answers "which hours
           * am I looking at" for a reader who thought to ask.
           */}
          {fleetLookback ? (
            <RangePicker range={range} ariaLabel="Aggregation range" onSelect={setRange} />
          ) : (
            <InfoTip label="About this window">
              {fleetActuals ? WINDOW_CAPTION_WITH_ACTUALS : HORIZON_CAPTION}
            </InfoTip>
          )}
          {fleetBody(
            combineFleetQueries(forecasts, actuals),
            {
              siteCount: sites.length,
              chart: chartCopy(windowLabel(range, fleetLookback, fleetActuals), fleetActuals),
              overlay,
              onRetryOverlay: retryOverlay,
              onRetryActuals: retryActuals,
            },
            retryFleet,
          )}
        </>
      )}
    </section>
  );
};
