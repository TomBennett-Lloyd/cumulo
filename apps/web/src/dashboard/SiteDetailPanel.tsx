import type { Forecast, Site } from '@cumulo/shared';
import { OpenMeteoAttribution } from '@cumulo/ui';
import type { ReactElement } from 'react';
import { useId } from 'react';

import './site-panels.css';
import type { ForecastViewState } from './forecast-view-state';
import {
  acPowerLabel,
  angleLabel,
  capacityLabel,
  coordinatesLabel,
  hourLabel,
  uncertaintyRangeLabel,
} from './site-format';

export interface ForecastTableProps {
  readonly forecasts: readonly Forecast[];
}

/**
 * The forecast as a table, deliberately — not a chart.
 *
 * Charting lands with #19, and `chart-treatment.md` requires a table view
 * beside any chart anyway, so this is the accessible form built first rather
 * than retrofitted. The uncertainty column exists only when some hour actually
 * carries a band: physics v1 (#12) emits point estimates, and an always-present
 * column of em dashes would read as missing data rather than as a model that
 * does not produce quantiles.
 */
const ForecastTable = ({ forecasts }: ForecastTableProps): ReactElement => {
  const showRange = forecasts.some((entry) => entry.uncertainty !== undefined);

  return (
    <table className="forecast-table">
      <caption className="forecast-caption">Forecast AC output by hour</caption>
      <thead>
        <tr>
          <th scope="col">Hour (UTC)</th>
          <th scope="col">Output (kW)</th>
          {showRange ? <th scope="col">P10–P90 (kW)</th> : null}
        </tr>
      </thead>
      <tbody>
        {forecasts.map((entry) => (
          <tr key={entry.validTime}>
            <th scope="row">
              <time dateTime={entry.validTime}>{hourLabel(entry.validTime)}</time>
            </th>
            <td>{acPowerLabel(entry.acPowerKw)}</td>
            {showRange ? <td>{uncertaintyRangeLabel(entry.uncertainty)}</td> : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
};

export interface ForecastSectionProps {
  readonly forecast: ForecastViewState;
  readonly onRetry: () => void;
}

/**
 * One arm of {@link ForecastViewState}, rendered.
 *
 * The waiting and failed states are labelled text, not a bare spinner: a site
 * created seconds ago has no forecast for an ordinary reason, and the visitor
 * watching the demo's headline minute is owed the elapsed time and, when it
 * stops being worth waiting for, the reason and a way to try again
 * (`error-handling.md` — degrade honestly rather than spin forever).
 */
const ForecastSection = ({ forecast, onRetry }: ForecastSectionProps): ReactElement => {
  switch (forecast.status) {
    case 'pending':
      return (
        <p className="forecast-status" role="status">
          Generating first forecast… {String(forecast.elapsedSeconds)}s
        </p>
      );
    case 'failed':
      return (
        <div className="forecast-failure" role="alert">
          <p className="forecast-failure-message">Forecast unavailable: {forecast.message}</p>
          <button type="button" className="forecast-retry" onClick={onRetry}>
            Try again
          </button>
        </div>
      );
    case 'ready':
      return <ForecastTable forecasts={forecast.forecasts} />;
  }
};

export interface SiteDetailPanelProps {
  readonly site: Site;
  readonly forecast: ForecastViewState;
  readonly onClose: () => void;
  readonly onRetry: () => void;
}

/**
 * Everything known about one site, beside the map.
 *
 * Selection has to lead somewhere a reader can read — the marker's own change
 * of size and fill is a pointer, not an answer — so this panel is the other
 * half of `map-treatment.md`'s relief rule, in the same way the site list is.
 *
 * The Open-Meteo credit is unconditional here rather than tied to the `ready`
 * arm. Every number this panel can show is derived from Open-Meteo weather,
 * the credit is a CC BY 4.0 licence condition (CLAUDE.md, hard constraints),
 * and a credit that appears and disappears with a polling state is a credit
 * that will eventually be missing when it matters.
 */
export const SiteDetailPanel = ({
  site,
  forecast,
  onClose,
  onRetry,
}: SiteDetailPanelProps): ReactElement => {
  const titleId = useId();

  return (
    <section className="site-panel" aria-labelledby={titleId}>
      <header className="site-panel-header">
        <h2 className="site-panel-title" id={titleId}>
          {site.name}
        </h2>
        <button type="button" className="site-panel-close" onClick={onClose}>
          Close
        </button>
      </header>

      <dl className="site-facts">
        <div className="site-fact">
          <dt>Coordinates</dt>
          <dd>{coordinatesLabel(site)}</dd>
        </div>
        <div className="site-fact">
          <dt>Tilt</dt>
          <dd>{angleLabel(site.tiltDegrees)}</dd>
        </div>
        <div className="site-fact">
          <dt>Azimuth</dt>
          <dd>{angleLabel(site.azimuthDegrees)}</dd>
        </div>
        <div className="site-fact">
          <dt>Capacity</dt>
          <dd>{capacityLabel(site.capacityKw)}</dd>
        </div>
      </dl>

      <section className="forecast-section" aria-label="Forecast">
        <ForecastSection forecast={forecast} onRetry={onRetry} />
        <OpenMeteoAttribution />
      </section>
    </section>
  );
};
