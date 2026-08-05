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
import type { FleetDataSource, RangeHours } from '../data/fleet-data-source';
import { useFleetQuery, type QueryState } from '../data/use-fleet-query';
import { joinFleetSeries, minimumContributingSites } from './fleet-series';
import { PanelEmpty, PanelError, PanelPending } from './panel-states';
import { RangePicker, rangeLabel } from './range-picker';
import { capacityLabel } from './site-format';
import {
  aggregatedFromCaption,
  EMPTY_FLEET_MESSAGE,
  fleetForecastFailureMessage,
  LOADING_FLEET_FORECAST_LABEL,
  NO_FLEET_FORECAST_MESSAGE,
  partialAggregateNotice,
} from './state-copy';

/*
 * The fleet's story, in the content column's resting state.
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
 * ## Hidden means empty, not merely invisible
 *
 * The column hides this panel rather than unmounting it so the queries and the
 * chosen range survive a context swap — so the hooks below run in every state,
 * hidden included. The *children* are a different question. A `role="alert"`
 * that mounts inside `display: none` has nothing to announce: it was never on
 * screen, and the later reveal is an attribute change rather than a DOM change,
 * so assistive technology reports nothing at either moment (#161). Rendering the
 * children only while visible means any failure mounts fresh into a visible tree
 * on reveal, which is a change and is announced.
 *
 * The state that matters is held by the hooks, not by the markup, so dropping
 * the subtree costs nothing: no refetch on reveal, and the range the reader
 * picked is still the range. What a reveal does cost is the *first* fan-out,
 * and that is deferred until one happens — so a `?site=` deep link that never
 * shows the fleet never spends it (#178).
 *
 * ## Attribution
 *
 * There is deliberately no Open-Meteo credit inside this panel. The column
 * carries one persistent credit in its footer, which stays on screen through
 * every state and every context swap; a second one here would be the same
 * obligation discharged twice in the same column.
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

const readyBody = (data: FleetSeries, siteCount: number, chart: ChartCopy): ReactElement => {
  const forecastPoints = aggregateFleetForecast(data.forecasts);
  if (forecastPoints.length === 0) {
    return <PanelEmpty message={NO_FLEET_FORECAST_MESSAGE} />;
  }

  return (
    <div className="fleet-panel-body">
      {completenessNote(minimumContributingSites(forecastPoints), siteCount)}
      <ForecastChart
        points={joinFleetSeries(forecastPoints, aggregateFleetActuals(data.actuals))}
        ariaLabel={chart.ariaLabel}
        tableCaption={chart.tableCaption}
      />
    </div>
  );
};

const fleetBody = (
  state: QueryState<FleetSeries>,
  siteCount: number,
  chart: ChartCopy,
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
  return readyBody(state.data, siteCount, chart);
};

export interface FleetPanelProps {
  readonly dataSource: FleetDataSource;
  /** The dashboard's one site list — listing plus session-created sites. */
  readonly sites: readonly Site[];
  /** Kept mounted but hidden while a site panel occupies the context region. */
  readonly hidden: boolean;
  /** Bumped by the dashboard when a site is created, to re-sum the fleet. */
  readonly refreshToken: number;
}

export const FleetPanel = ({
  dataSource,
  sites,
  hidden,
  refreshToken,
}: FleetPanelProps): ReactElement => {
  const headingId = useId();
  const [range, setRange] = useState<RangeHours>(DEFAULT_RANGE);
  // Retrying is a new question, so it is a new query key rather than an
  // imperative refetch: `useFleetQuery` re-runs on key change and nothing
  // else, and a counter is the smallest honest way to say "ask again".
  const [attempt, setAttempt] = useState(0);

  /*
   * Both hooks below run unconditionally — hooks are not a place for `if` — but
   * the *requests* they make are value-gated until the panel has been looked at
   * once. In live mode a fleet read is a paced per-site fan-out, so a `?site=`
   * deep link that never shows the fleet must never spend one (#178).
   *
   * `revealed` needs the `sites.length > 0` conjunct because of that same deep
   * link: the panel is briefly un-hidden while the listing is still in flight,
   * so there is a window with `hidden` false over an empty `sites`. That window
   * is a loading state, not a reveal, and requiring a fleet to show is what
   * stops it counting as one. (A live fleet that really is empty then never
   * spends the fan-out either — there is nothing to sum.)
   *
   * The latch is monotonic, so `enabled` never returns to false once set: hide
   * and re-reveal keep #161's spent-once-and-kept property, where a raw
   * `revealed` would make every re-reveal a false→true flip that refetches.
   */
  const [everRevealed, setEverRevealed] = useState(false);
  const revealed = !hidden && sites.length > 0;
  if (revealed && !everRevealed) {
    // Adjusting state during render — react.dev's own pattern for state derived
    // from the props of this very render, and guarded so it sets at most once
    // ever, which is what makes it terminate. An effect would be the wrong tool:
    // there is no external system to synchronize with (`react.md` rule 1).
    setEverRevealed(true);
  }
  const enabled = revealed || everRevealed;

  const forecasts = useFleetQuery(
    () => dataSource.fleetForecasts(range),
    ['fleet-forecasts', range, refreshToken, attempt],
    { enabled },
  );
  const actuals = useFleetQuery(
    () => dataSource.fleetActuals(range),
    ['fleet-actuals', range, refreshToken, attempt],
    { enabled },
  );

  const { fleetLookback, fleetActuals } = dataSource.capabilities;
  const retry = (): void => {
    setAttempt((previous) => previous + 1);
  };

  return (
    <section className="fleet-panel" hidden={hidden} aria-labelledby={headingId}>
      {hidden ? null : (
        <>
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
                sites.length,
                chartCopy(windowLabel(range, fleetLookback), fleetActuals),
                retry,
              )}
            </>
          )}
        </>
      )}
    </section>
  );
};
