import type { ReactElement } from 'react';

/**
 * The chart's legend: fixed in draw order and always present, because three
 * series are on the plot and identity is never carried by colour alone
 * (`docs/design/chart-treatment.md`). Legend text wears text tokens, never the
 * series colour — the swatch beside it is what names the series.
 *
 * A constant rather than a component: it takes no input and never varies, so
 * there is nothing to parameterise and nothing to re-render.
 */

/**
 * The band swatch is the one place the bound stroke does double duty — at
 * swatch size a bare 10% wash is nearly invisible, and the edges are what make
 * it read as a band.
 */
export const FORECAST_CHART_LEGEND: ReactElement = (
  <ul className="forecast-chart-legend">
    <li>
      <svg className="forecast-chart-legend-key" viewBox="0 0 28 14" aria-hidden="true">
        <rect className="forecast-chart-band" x="0" y="2" width="28" height="10" />
        <line className="forecast-chart-band-bound" x1="0" x2="28" y1="2.5" y2="2.5" />
        <line className="forecast-chart-band-bound" x1="0" x2="28" y1="11.5" y2="11.5" />
      </svg>
      Forecast (P10–P90)
    </li>
    <li>
      <svg className="forecast-chart-legend-key" viewBox="0 0 28 14" aria-hidden="true">
        <line className="forecast-chart-median" x1="0" x2="28" y1="7" y2="7" />
      </svg>
      Forecast (median)
    </li>
    <li>
      <svg className="forecast-chart-legend-key" viewBox="0 0 28 14" aria-hidden="true">
        <line className="forecast-chart-actuals" x1="0" x2="28" y1="7" y2="7" />
      </svg>
      Actuals
    </li>
  </ul>
);
