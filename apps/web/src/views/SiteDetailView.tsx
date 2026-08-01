import type { Site } from '@cumulo/shared';
import { OpenMeteoAttribution } from '@cumulo/ui';
import type { ReactElement } from 'react';
import { useId, useState } from 'react';

import { ForecastChart } from '../charts/ForecastChart';
import type { FleetDataSource, RangeHours } from '../data/fleet-data-source';
import { joinSiteSeries, loadSiteSeries } from '../dashboard/site-series';
import { useProviderQuery, type QueryState } from '../data/use-provider-query';
import { RangePicker } from './range-picker';

/**
 * One site's forecast against its measured generation, over a chosen window.
 *
 * The view owns three things and nothing else: which site, which window, and
 * which of the data layer's states is on screen. All arithmetic above the
 * data source is the display join in {@link joinSiteSeries}; drawing belongs to
 * `ForecastChart`, and fetching to `FleetDataSource`, so this file has no
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
  readonly dataSource: FleetDataSource;
}

const DEFAULT_RANGE: RangeHours = 24;

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
  readonly dataSource: FleetDataSource;
  readonly site: Site;
  readonly range: RangeHours;
}

const SiteSeriesPanel = (props: SiteSeriesPanelProps): ReactElement => {
  const { dataSource, site, range } = props;
  // The key names every input the query reads, which is `useProviderQuery`'s
  // contract: changing site or window is a different request, and a superseded
  // one is dropped rather than allowed to overwrite the current chart.
  const state = useProviderQuery(
    () => loadSiteSeries(dataSource, site.id, range),
    ['site-series', site.id, range],
  );

  if (state.status === 'loading') {
    return <p className="view-status">Loading the forecast for {site.name}…</p>;
  }
  if (state.status === 'failed') {
    return (
      <p className="view-error" role="alert">
        Could not load the forecast for {site.name}: {state.error.message}
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
  readonly dataSource: FleetDataSource;
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
        Could not load the site list: {sitesState.error.message}
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
        <RangePicker
          range={props.range}
          ariaLabel="Forecast range"
          onSelect={props.onSelectRange}
        />
      </div>
      <SiteSeriesPanel dataSource={props.dataSource} site={site} range={props.range} />
    </>
  );
};

export const SiteDetailView = (props: SiteDetailViewProps): ReactElement => {
  const { dataSource } = props;
  const sitesState = useProviderQuery(dataSource.listSites, ['site-list']);
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
        dataSource={dataSource}
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
