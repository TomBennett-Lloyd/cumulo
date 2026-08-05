import {
  aggregateFleetActuals,
  aggregateFleetForecast,
  fleetCapacityKw,
  type Forecast,
  type GenerationReading,
  type Site,
} from '@cumulo/shared';
import { useId, useState, type ReactElement } from 'react';

import { ForecastChart } from '../charts/ForecastChart';
import type { ChartOverlaySeries, ForecastChartPoint } from '../charts/ForecastChart';
import type { FleetDataSource, FleetSourceResult, RangeHours } from '../data/fleet-data-source';
import { useFleetQuery, type QueryState } from '../data/use-fleet-query';
import { joinFleetSeries, minimumContributingSites } from './fleet-series';
import { PanelEmpty, PanelError, PanelPending } from './panel-states';
import { RangePicker, rangeLabel } from './range-picker';
import { capacityLabel } from './site-format';
import { siteOverlaySeries } from './site-overlay';
import {
  aggregatedFromCaption,
  EMPTY_FLEET_MESSAGE,
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
 * the per-site `/forecast` route, which serves *future* hours only, and fleet
 * actuals have no producer at all — so a range control and the words "measured
 * output" are true of the demo source and false of the HTTP one. Rather than
 * carrying copy that is right half the time, the control and the clause are both
 * gated on the flags: `fleetLookback` decides whether a window can be chosen at
 * all, `fleetActuals` decides whether measurement is mentioned anywhere,
 * including in the chart's accessible name. That was #150's review finding, and
 * the fix it asked for was structural rather than a rewording.
 *
 * When `fleetLookback` is false the range is pinned to 24 by construction: the
 * picker is the only thing that ever calls `setRange`, so no picker means no
 * second value, and the caption states the horizon the reader is actually
 * looking at.
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
 * What the panel says instead of offering a window it cannot serve.
 *
 * The number is spelled out rather than derived from {@link DEFAULT_RANGE}: this
 * is a sentence about what the reader is looking at, and a caption assembled
 * from a constant would silently rewrite itself if the default ever moved.
 */
const HORIZON_CAPTION = 'Forecast horizon: next 24 hours';

/** How the chart's labels name that same horizon, in the terser register a label wants. */
const HORIZON_WINDOW_LABEL = 'next 24 h';

const SUBTITLE_WITH_ACTUALS =
  'Every site’s forecast, summed hour by hour, with the fleet’s P10–P90 band and measured output.';

const SUBTITLE_FORECAST_ONLY =
  'Every site’s forecast for the hours ahead, summed hour by hour, with the fleet’s P10–P90 band.';

/** Plural is the fleet's usual state; the singular exists so the demo's first site reads right. */
const siteCountLabel = (count: number): string =>
  `${String(count)} ${count === 1 ? 'site' : 'sites'}`;

/**
 * The fleet in one line: how many, and how much of it there is.
 *
 * Capacity comes from `@cumulo/shared` rather than a sum written here, because
 * fleet arithmetic lives there (`architecture.md` rule 3) and a second sum would
 * be a second definition of the fleet's size.
 */
const fleetStatsLine = (sites: readonly Site[]): string =>
  `${siteCountLabel(sites.length)} · ${capacityLabel(fleetCapacityKw(sites))} installed`;

/** The window the chart's labels name — a chosen look-back, or the fixed horizon. */
const windowLabel = (range: RangeHours, canLookBack: boolean): string =>
  canLookBack ? `${rangeLabel(range)} range` : HORIZON_WINDOW_LABEL;

/** The chart is named twice — for assistive technology, and above its table twin. */
interface ChartCopy {
  readonly ariaLabel: string;
  readonly tableCaption: string;
}

/**
 * Both of the chart's names, written out per capability rather than assembled
 * from a conditional clause.
 *
 * Two whole arms so the honesty rule is auditable by reading them side by side:
 * the words "measured output" appear only in the arm a source with
 * `fleetActuals` reaches. An accessible name is copy like any other, and it is
 * the copy easiest to leave promising something the data cannot show.
 */
const chartCopy = (windowText: string, hasActuals: boolean): ChartCopy =>
  hasActuals
    ? {
        ariaLabel: `Fleet forecast and measured output, ${windowText}`,
        tableCaption: `Table view — fleet forecast and measured output, ${windowText}, kW`,
      }
    : {
        ariaLabel: `Fleet forecast, ${windowText}`,
        tableCaption: `Table view — fleet forecast, ${windowText}, kW`,
      };

/** The two source calls this panel makes, once both have answered. */
interface FleetSeries {
  readonly forecasts: readonly Forecast[];
  readonly actuals: readonly GenerationReading[];
}

/**
 * Collapse the two queries into the one state the panel renders.
 *
 * Failure wins over loading: a reader is owed the reason something is missing
 * before they are owed a spinner for the parts still arriving.
 */
const combineFleetQueries = (
  forecasts: QueryState<readonly Forecast[]>,
  actuals: QueryState<readonly GenerationReading[]>,
): QueryState<FleetSeries> => {
  if (forecasts.status === 'failed') {
    return forecasts;
  }
  if (actuals.status === 'failed') {
    return actuals;
  }
  if (forecasts.status === 'loading' || actuals.status === 'loading') {
    return { status: 'loading' };
  }
  return { status: 'ready', data: { forecasts: forecasts.data, actuals: actuals.data } };
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
 * The chart is complete and the line over it is not, said out loud.
 *
 * Partial results are labelled partial (`error-handling.md` rule 5), and an
 * overlay that failed silently is the exact shape that rule refuses: the reader
 * selected a site, the chart drew a fleet, and nothing on screen distinguished
 * "this site tracks the fleet's shape closely" from "this site's line never
 * arrived".
 *
 * Deliberately **not** a live region. `react.md` budgets one per panel and this
 * panel's is the chart's own readout, which is the announcement a reader asked
 * for by moving the selection; a second region here would mean whichever won.
 * It is the same non-live treatment the completeness note above uses, for the
 * same reason — an incomplete answer is a caption on the answer, not an event.
 *
 * It carries a retry because re-asking genuinely can work: this is one request
 * for one site, not the fleet's fan-out, so the button spends what a fresh
 * selection would spend and nothing more. That is the test `react.md` sets for
 * offering one at all.
 */
const overlayNote = (overlay: OverlayState, onRetry: () => void): ReactElement | null =>
  overlay.kind === 'failed' ? (
    <p className="panel-notice">
      {siteOverlayFailureNotice(overlay.siteName)}{' '}
      <button type="button" className="panel-retry" onClick={onRetry}>
        {RETRY_ACTION_LABEL}
      </button>
    </p>
  ) : null;

const readyBody = (data: FleetSeries, context: FleetChartContext): ReactElement => {
  const forecastPoints = aggregateFleetForecast(data.forecasts);
  if (forecastPoints.length === 0) {
    return <PanelEmpty message={NO_FLEET_FORECAST_MESSAGE} />;
  }

  return (
    <div className="fleet-panel-body">
      {completenessNote(minimumContributingSites(forecastPoints), context.siteCount)}
      {overlayNote(context.overlay, context.onRetryOverlay)}
      {fleetChart(joinFleetSeries(forecastPoints, aggregateFleetActuals(data.actuals)), context)}
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
   * Two counters, not one, and the split is about cost. The fleet's retry
   * re-spends a paced per-site fan-out; the overlay's re-asks a single site for
   * a single window. A shared counter would make the cheap recourse buy the
   * expensive request as well — a reader pressing "try again" on one missing
   * line would silently re-sum sixty sites — and would make the expensive one
   * refetch a line that never failed.
   */
  const [fleetAttempt, setFleetAttempt] = useState(0);
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
    ['fleet-actuals', range, refreshToken, fleetAttempt],
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
        <h2 className="fleet-panel-title" id={headingId}>
          Fleet
        </h2>
        <p className="fleet-panel-stats">{fleetStatsLine(sites)}</p>
        <p className="fleet-panel-subtitle">
          {fleetActuals ? SUBTITLE_WITH_ACTUALS : SUBTITLE_FORECAST_ONLY}
        </p>
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
          {fleetLookback ? (
            <RangePicker range={range} ariaLabel="Aggregation range" onSelect={setRange} />
          ) : (
            <p className="panel-caption">{HORIZON_CAPTION}</p>
          )}
          {fleetBody(
            combineFleetQueries(forecasts, actuals),
            {
              siteCount: sites.length,
              chart: chartCopy(windowLabel(range, fleetLookback), fleetActuals),
              overlay,
              onRetryOverlay: retryOverlay,
            },
            retryFleet,
          )}
        </>
      )}
    </section>
  );
};
