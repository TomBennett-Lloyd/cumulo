import type { Forecast, GenerationReading, Site } from '@cumulo/shared';
import { OpenMeteoAttribution } from '@cumulo/ui';
import type { ReactElement } from 'react';
import { useId, useState } from 'react';

import { ForecastChart, type ForecastChartPoint } from '../charts/ForecastChart';
import type { DataResult, FleetDataProvider, RangeHours } from '../data/provider';
import { useProviderQuery, type QueryState } from '../data/use-provider-query';

/**
 * One site's forecast against its measured generation, over a chosen window.
 *
 * The view owns three things and nothing else: which site, which window, and
 * which of the data layer's states is on screen. All arithmetic above the
 * provider is the display join in {@link joinSiteSeries}; drawing belongs to
 * `ForecastChart`, and fetching to `FleetDataProvider`, so this file has no
 * opinion about either.
 *
 * **Nothing here ever renders blank.** Loading, failed, no-forecast and
 * no-measurements are four different statements about the data and each gets
 * its own words — a chart that quietly renders nothing is indistinguishable
 * from a chart of zeros (`error-handling.md` rules 4 and 5).
 *
 * The Open-Meteo credit sits at the foot of *every* state, not just the ones
 * with a chart in them: the forecast series is weather-derived, so the credit
 * is owed the moment the view claims to be showing it (CLAUDE.md, hard
 * constraints).
 */

export interface SiteDetailViewProps {
  readonly provider: FleetDataProvider;
}

/** Both series for one site and window, fetched together so they share a state. */
interface SiteSeries {
  readonly forecasts: readonly Forecast[];
  readonly actuals: readonly GenerationReading[];
}

interface RangeOption {
  readonly hours: RangeHours;
  readonly label: string;
}

const RANGE_OPTIONS: readonly RangeOption[] = [
  { hours: 24, label: '24 h' },
  { hours: 48, label: '48 h' },
  { hours: 168, label: '7 d' },
];

const DEFAULT_RANGE: RangeHours = 24;

/**
 * One forecast plus its measurement, if an hour with that exact `validTime` was
 * measured. The `band` key is built conditionally rather than assigned
 * `undefined`: under `exactOptionalPropertyTypes` an absent band and a band of
 * `undefined` are different values, and the chart draws only the former as a
 * point estimate.
 */
const toChartPoint = (
  forecast: Forecast,
  actualByTime: ReadonlyMap<string, number>,
): ForecastChartPoint => {
  const measured = actualByTime.get(forecast.validTime);
  const point = {
    validTimeIso: forecast.validTime,
    medianKw: forecast.acPowerKw,
    actualKw: measured ?? null,
  };
  return forecast.uncertainty === undefined
    ? point
    : {
        ...point,
        band: {
          p10Kw: forecast.uncertainty.p10AcPowerKw,
          p90Kw: forecast.uncertainty.p90AcPowerKw,
        },
      };
};

/**
 * The display join: one chart point per forecast, ascending by time.
 *
 * The forecast series defines the x-domain, so a measurement whose hour was
 * never forecast is dropped rather than appended. Adding it would put a sample
 * on the axis with no forecast beneath it, which reads as a forecast of zero —
 * and the honest fix for a gap in the forecast series is a gap, not an actual
 * standing in for one. Sorting is lexicographic because `UtcIsoTimestamp` is
 * fixed-width UTC, where string order *is* chronological order.
 */
export const joinSiteSeries = (
  forecasts: readonly Forecast[],
  actuals: readonly GenerationReading[],
): readonly ForecastChartPoint[] => {
  const actualByTime = new Map<string, number>(
    actuals.map((actual) => [actual.validTime, actual.acPowerKw]),
  );
  return [...forecasts]
    .sort((left, right) => left.validTime.localeCompare(right.validTime))
    .map((forecast) => toChartPoint(forecast, actualByTime));
};

/**
 * Both provider calls as one result: either series failing makes the pair
 * failed, because a chart of forecasts with the measurements silently missing
 * would claim the horizon is now.
 */
const loadSiteSeries = async (
  provider: FleetDataProvider,
  siteId: string,
  range: RangeHours,
): Promise<DataResult<SiteSeries>> => {
  const [forecasts, actuals] = await Promise.all([
    provider.siteForecasts(siteId, range),
    provider.siteActuals(siteId, range),
  ]);
  if (forecasts.status === 'failed') {
    return forecasts;
  }
  if (actuals.status === 'failed') {
    return actuals;
  }
  return { status: 'ready', data: { forecasts: forecasts.data, actuals: actuals.data } };
};

interface RangePickerProps {
  readonly range: RangeHours;
  readonly onSelect: (range: RangeHours) => void;
}

const RangePicker = (props: RangePickerProps): ReactElement => (
  <div className="view-range" role="group" aria-label="Forecast range">
    {RANGE_OPTIONS.map((option) => (
      <button
        key={option.hours}
        type="button"
        className="view-range-button"
        aria-pressed={option.hours === props.range}
        onClick={() => {
          props.onSelect(option.hours);
        }}
      >
        {option.label}
      </button>
    ))}
  </div>
);

interface SitePickerProps {
  readonly sites: readonly Site[];
  readonly selectedSiteId: string;
  readonly onSelect: (siteId: string) => void;
}

const SitePicker = (props: SitePickerProps): ReactElement => {
  const selectId = useId();

  return (
    <div className="view-field">
      <label htmlFor={selectId}>Site</label>
      <select
        id={selectId}
        className="view-select"
        value={props.selectedSiteId}
        onChange={(event) => {
          props.onSelect(event.target.value);
        }}
      >
        {props.sites.map((site) => (
          <option key={site.id} value={site.id}>
            {site.name}
          </option>
        ))}
      </select>
    </div>
  );
};

interface SiteSeriesPanelProps {
  readonly provider: FleetDataProvider;
  readonly site: Site;
  readonly range: RangeHours;
}

const SiteSeriesPanel = (props: SiteSeriesPanelProps): ReactElement => {
  const { provider, site, range } = props;
  // The key names every input the query reads, which is `useProviderQuery`'s
  // contract: changing site or window is a different request, and a superseded
  // one is dropped rather than allowed to overwrite the current chart.
  const state = useProviderQuery(
    () => loadSiteSeries(provider, site.id, range),
    ['site-series', site.id, range],
  );

  if (state.status === 'loading') {
    return <p className="view-status">Loading the forecast for {site.name}…</p>;
  }
  if (state.status === 'failed') {
    return (
      <p className="view-error" role="alert">
        Could not load the forecast for {site.name}: {state.error}
      </p>
    );
  }

  const points = joinSiteSeries(state.data.forecasts, state.data.actuals);
  if (points.length === 0) {
    return <p className="view-empty">No forecast available for this site yet</p>;
  }

  return (
    <div className="view-panel">
      {points.some((point) => point.actualKw !== null) ? null : (
        <p className="view-notice">No measurements recorded in this range</p>
      )}
      <ForecastChart
        points={points}
        ariaLabel={`${site.name}: forecast and measured generation`}
        tableCaption={`Table view — ${site.name}, kW`}
      />
    </div>
  );
};

interface SiteDetailBodyProps {
  readonly provider: FleetDataProvider;
  readonly sitesState: QueryState<readonly Site[]>;
  readonly selectedSiteId: string | null;
  readonly onSelectSite: (siteId: string) => void;
  readonly range: RangeHours;
  readonly onSelectRange: (range: RangeHours) => void;
}

const SiteDetailBody = (props: SiteDetailBodyProps): ReactElement => {
  const { sitesState } = props;

  if (sitesState.status === 'loading') {
    return <p className="view-status">Loading the site list…</p>;
  }
  if (sitesState.status === 'failed') {
    return (
      <p className="view-error" role="alert">
        Could not load the site list: {sitesState.error}
      </p>
    );
  }

  // The selection is derived, not synchronised: before anyone touches the
  // select there is no chosen site, and the first one stands in. An effect that
  // wrote the default into state would render once with nothing selected and
  // make the same fact true in two places (react.md rule 1).
  const sites = sitesState.data;
  const site = sites.find((candidate) => candidate.id === props.selectedSiteId) ?? sites[0];
  if (site === undefined) {
    return <p className="view-empty">No sites in the fleet yet</p>;
  }

  return (
    <>
      <div className="view-controls">
        <SitePicker sites={sites} selectedSiteId={site.id} onSelect={props.onSelectSite} />
        <RangePicker range={props.range} onSelect={props.onSelectRange} />
      </div>
      <SiteSeriesPanel provider={props.provider} site={site} range={props.range} />
    </>
  );
};

export const SiteDetailView = (props: SiteDetailViewProps): ReactElement => {
  const { provider } = props;
  const sitesState = useProviderQuery(provider.listSites, ['site-list']);
  const [selectedSiteId, setSelectedSiteId] = useState<string | null>(null);
  const [range, setRange] = useState<RangeHours>(DEFAULT_RANGE);

  return (
    <section className="view">
      <header className="view-header">
        <h2 className="view-title">Site forecast</h2>
        <p className="view-subtitle">
          One site&rsquo;s modelled output with its P10–P90 band, against what the site actually
          generated. Measurements stop at the forecast horizon.
        </p>
      </header>

      <SiteDetailBody
        provider={provider}
        sitesState={sitesState}
        selectedSiteId={selectedSiteId}
        onSelectSite={setSelectedSiteId}
        range={range}
        onSelectRange={setRange}
      />

      <footer className="view-footer">
        <OpenMeteoAttribution />
      </footer>
    </section>
  );
};
