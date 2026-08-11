import type { ReactElement } from 'react';

/**
 * The chart's legend: fixed in draw order and always present, because several
 * series are on the plot and identity is never carried by colour alone
 * (`docs/design/chart-treatment.md`). Legend text wears text tokens, never the
 * series colour — the swatch beside it is what names the series.
 *
 * A function rather than the constant this was: a series that is not on the
 * plot must not be in the legend, and two of them vary. A chart may carry one
 * overlay, whose row is appended rather than slotted in so the fixed entries
 * never reorder or repaint around it; and the band is drawn only where the
 * points carry one, so `hasBand` gates its row for the same reason (#295). A
 * legend naming a P10–P90 band over a series of point estimates is the chart
 * claiming an uncertainty nothing produced — the honesty rule the median and
 * actuals rows have always kept by being unconditional.
 *
 * The band's row says **simulated** in the same breath as the actuals' row,
 * because that is what it is: the envelope is a deterministic width attached to
 * every stored row (`@cumulo/shared`'s `simulated-uncertainty.ts`), not an
 * ensemble the physics model produced. The readout's `P10–P90` row name stays
 * bare — it labels the two values it is showing, and makes no claim about where
 * they came from.
 */

/**
 * The band swatch is the one place the bound stroke does double duty — at
 * swatch size a bare 10% wash is nearly invisible, and the edges are what make
 * it read as a band.
 */
export const forecastChartLegend = (
  overlayLabel: string | undefined,
  hasBand: boolean,
): ReactElement => (
  <ul className="forecast-chart-legend">
    {hasBand ? (
      <li>
        <svg className="forecast-chart-legend-key" viewBox="0 0 28 14" aria-hidden="true">
          <rect className="forecast-chart-band" x="0" y="2" width="28" height="10" />
          <line className="forecast-chart-band-bound" x1="0" x2="28" y1="2.5" y2="2.5" />
          <line className="forecast-chart-band-bound" x1="0" x2="28" y1="11.5" y2="11.5" />
        </svg>
        Forecast (P10–P90, simulated)
      </li>
    ) : null}
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
      Actuals (simulated)
    </li>
    {overlayLabel === undefined ? null : (
      <li>
        <svg className="forecast-chart-legend-key" viewBox="0 0 28 14" aria-hidden="true">
          <line className="forecast-chart-swatch-overlay" x1="0" x2="28" y1="7" y2="7" />
        </svg>
        {overlayLabel}
      </li>
    )}
  </ul>
);
