import type { ReactElement } from 'react';
import { tickLabelFor } from './chart-geometry';
import { formatKw, type ForecastChartPoint } from './chart-series';

/**
 * The table twin: the WCAG-clean equivalent every chart owes its readers
 * (`docs/design/chart-treatment.md`). Every plotted value appears here as text,
 * which is what lets the tooltip enhance rather than gate — nothing in the
 * hover readout is reachable only with a pointer.
 */

export interface ForecastChartTableParams {
  readonly points: readonly ForecastChartPoint[];
  /** Decides the time-label form, so the table and the axis read alike. */
  readonly spanHours: number;
  readonly caption: string;
}

export const forecastChartTable = ({
  points,
  spanHours,
  caption,
}: ForecastChartTableParams): ReactElement => (
  <table className="forecast-chart-table">
    <caption>{caption}</caption>
    <thead>
      <tr>
        <th scope="col">Time</th>
        <th scope="col">P10</th>
        <th scope="col">Median</th>
        <th scope="col">P90</th>
        <th scope="col">Actual</th>
      </tr>
    </thead>
    <tbody>
      {points.map((point) => (
        <tr key={point.validTimeIso}>
          <th scope="row">
            <time dateTime={point.validTimeIso}>{tickLabelFor(point.validTimeIso, spanHours)}</time>
          </th>
          <td>{formatKw(point.band?.p10Kw)}</td>
          <td>{formatKw(point.medianKw)}</td>
          <td>{formatKw(point.band?.p90Kw)}</td>
          <td>{formatKw(point.actualKw)}</td>
        </tr>
      ))}
    </tbody>
  </table>
);
