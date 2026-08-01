import {
  aggregateFleetActuals,
  aggregateFleetForecast,
  type Forecast,
  type GenerationReading,
  type Site,
} from '@cumulo/shared';
import { OpenMeteoAttribution } from '@cumulo/ui';
import { useState, type ReactElement } from 'react';

import { ForecastChart } from '../charts/ForecastChart';
import type { FleetDataSource, RangeHours } from '../data/fleet-data-source';
import { useProviderQuery, type QueryState } from '../data/use-provider-query';
import { joinFleetSeries, minimumContributingSites } from '../dashboard/fleet-series';
import { RangePicker, rangeLabel } from './range-picker';

/**
 * The fleet's forecast and measured output, summed hour by hour.
 *
 * The summing is not here. `aggregateFleetForecast` / `aggregateFleetActuals` in `@cumulo/shared`
 * own every kilowatt of arithmetic (`architecture.md` rule 3), including the comonotonic band
 * addition whose statistical position is stated in that module, and `dashboard/fleet-series.ts`
 * joins their output to the chart's point shape. What is left here is the decision of what to say
 * about it. There is deliberately no `+` over a power value below — if one appears, a second
 * definition of "the fleet total" has been created.
 *
 * Honesty about partial results is a rendered feature, not a log line (`error-handling.md` rule 5):
 * an hour that only some sites contributed to still draws, but the view says how many of the
 * fleet's sites are actually in it. Silently plotting a sum of three sites as "the fleet" is the
 * exact failure the accuracy features exist to detect.
 *
 * Layout classes prefixed `view-` are defined in `views.css`, which this view shares with
 * `SiteDetailView` and does not own.
 */

/** Presentational chrome only: the data source is the view's single input. */
export interface FleetAggregateViewProps {
  readonly dataSource: FleetDataSource;
}

const DEFAULT_RANGE: RangeHours = 24;

const LOADING_TEXT = 'Loading the fleet aggregate…';
const NO_SITES_TEXT = 'No active sites yet';
const NO_FORECAST_TEXT = 'No fleet forecast available for this range yet';

/** The three provider calls this view makes, once both have answered. */
interface FleetData {
  readonly sites: readonly Site[];
  readonly forecasts: readonly Forecast[];
  readonly actuals: readonly GenerationReading[];
}

/**
 * Collapse three independent queries into the one state the view renders.
 *
 * Failure wins over loading: a reader is owed the reason something is missing before they are owed
 * a spinner for the parts still arriving.
 */
const combineFleetQueries = (
  sites: QueryState<readonly Site[]>,
  forecasts: QueryState<readonly Forecast[]>,
  actuals: QueryState<readonly GenerationReading[]>,
): QueryState<FleetData> => {
  if (sites.status === 'failed') {
    return sites;
  }
  if (forecasts.status === 'failed') {
    return forecasts;
  }
  if (actuals.status === 'failed') {
    return actuals;
  }
  if (
    sites.status === 'loading' ||
    forecasts.status === 'loading' ||
    actuals.status === 'loading'
  ) {
    return { status: 'loading' };
  }
  return {
    status: 'ready',
    data: { sites: sites.data, forecasts: forecasts.data, actuals: actuals.data },
  };
};

/*
 * Three separate lines rather than one parameterized by class and role: "still working", "nothing
 * to show" and "this failed" are different statements about the fleet, and `views.css` colours the
 * third differently on purpose. Merging them behind flags would be the merge `structure.md` rule 7
 * warns about.
 */

const loadingLine = (): ReactElement => (
  <p className="view-status" role="status">
    {LOADING_TEXT}
  </p>
);

const emptyLine = (text: string): ReactElement => (
  <p className="view-empty" role="status">
    {text}
  </p>
);

const errorLine = (text: string): ReactElement => (
  <p className="view-error" role="alert">
    {text}
  </p>
);

const rangeControls = (range: RangeHours, onSelect: (next: RangeHours) => void): ReactElement => (
  <div className="view-controls">
    <RangePicker range={range} ariaLabel="Aggregation range" onSelect={onSelect} />
  </div>
);

/**
 * The completeness line, stated in both directions.
 *
 * `minContributing` and `siteCount` are both rendered because "partial" without the two numbers is
 * a shrug: the reader needs to know whether one site is missing or fifty.
 */
const completenessNote = (minContributing: number, siteCount: number): ReactElement =>
  minContributing < siteCount ? (
    <p className="view-notice">
      Partial aggregate: some hours include only {minContributing} of {siteCount} sites.
    </p>
  ) : (
    <p className="view-caption">Aggregated from {siteCount} sites</p>
  );

const readyBody = (data: FleetData, range: RangeHours): ReactElement => {
  const siteCount = data.sites.length;
  if (siteCount === 0) {
    return emptyLine(NO_SITES_TEXT);
  }

  const forecastPoints = aggregateFleetForecast(data.forecasts);
  if (forecastPoints.length === 0) {
    return emptyLine(NO_FORECAST_TEXT);
  }

  // The same words the control wears, so the chart's title and the button a
  // reader just pressed cannot name the window differently.
  const windowLabel = rangeLabel(range);
  return (
    <div className="view-panel">
      {completenessNote(minimumContributingSites(forecastPoints), siteCount)}
      <ForecastChart
        points={joinFleetSeries(forecastPoints, aggregateFleetActuals(data.actuals))}
        ariaLabel={`Fleet aggregate forecast and measured output, ${windowLabel} range`}
        tableCaption={`Table view — fleet aggregate, ${windowLabel} range, kW`}
      />
    </div>
  );
};

const viewBody = (state: QueryState<FleetData>, range: RangeHours): ReactElement => {
  if (state.status === 'loading') {
    return loadingLine();
  }
  if (state.status === 'failed') {
    // The source's message already names the operation it failed (error-handling.md rule 4);
    // this sentence supplies the surface the reader is looking at.
    return errorLine(`Could not load the fleet aggregate: ${state.error.message}`);
  }
  return readyBody(state.data, range);
};

/**
 * Query keys name the range and nothing else: `dataSource` is fixed for the view's lifetime (the
 * app shell picks one at module scope), so it is not an input that can change under a mounted view.
 */
export const FleetAggregateView = ({ dataSource }: FleetAggregateViewProps): ReactElement => {
  const [range, setRange] = useState<RangeHours>(DEFAULT_RANGE);
  const sites = useProviderQuery(dataSource.listSites, ['fleet-sites']);
  const forecasts = useProviderQuery(
    () => dataSource.fleetForecasts(range),
    ['fleet-forecasts', range],
  );
  const actuals = useProviderQuery(() => dataSource.fleetActuals(range), ['fleet-actuals', range]);

  return (
    <section className="view">
      <header className="view-header">
        <h2 className="view-title">Fleet aggregate</h2>
        <p className="view-subtitle">
          Every active site&rsquo;s forecast, summed hour by hour, with the fleet&rsquo;s
          P10&ndash;P90 band and measured output to date.
        </p>
      </header>
      {rangeControls(range, setRange)}
      {viewBody(combineFleetQueries(sites, forecasts, actuals), range)}
      <footer className="view-footer">
        <OpenMeteoAttribution />
      </footer>
    </section>
  );
};
