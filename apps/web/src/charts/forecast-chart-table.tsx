import type { ReactElement } from 'react';
import { TIME_COLUMN_HEADER } from './chart-copy';
import { tickLabelFor } from './chart-geometry';
import { formatKw, type ChartOverlayColumn, type ForecastChartPoint } from './chart-series';

/**
 * The table twin: the WCAG-clean equivalent every chart owes its readers
 * (`docs/design/chart-treatment.md`). Every plotted value appears here as text,
 * which is what lets the tooltip enhance rather than gate — nothing in the
 * hover readout is reachable only with a pointer.
 *
 * An overlay gets a column here for the same reason it gets a legend row, and
 * one more besides. `chart-treatment.md`, "Light and dark", records that three
 * categorical slots fall below the 3:1 mark-contrast threshold on the light
 * surface, and rules that a light-mode chart reaching them must ship direct
 * labels **or the table view** — a WARN that obligates a relief channel rather
 * than one that can be dismissed. An overlay takes slot 2, which still clears
 * the threshold, so the column is not yet carrying that obligation; it is here
 * so that the next series added does not have to invent the relief, which is
 * exactly the shipping-without-it failure the treatment writes the rule against.
 */

export interface ForecastChartTableParams {
  readonly points: readonly ForecastChartPoint[];
  /** Decides the time-label form, so the table and the axis read alike. */
  readonly spanHours: number;
  readonly caption: string;
  /** `undefined` where the chart carries no overlay — the column is then absent. */
  readonly overlay: ChartOverlayColumn | undefined;
}

export const forecastChartTable = ({
  points,
  spanHours,
  caption,
  overlay,
}: ForecastChartTableParams): ReactElement => (
  <table className="forecast-chart-table">
    <caption>{caption}</caption>
    <thead>
      <tr>
        <th scope="col">{TIME_COLUMN_HEADER}</th>
        <th scope="col">P10</th>
        <th scope="col">Median</th>
        <th scope="col">P90</th>
        <th scope="col">Actual</th>
        {overlay === undefined ? null : <th scope="col">{overlay.label}</th>}
      </tr>
    </thead>
    <tbody>
      {points.map((point, index) => (
        <tr key={point.validTimeIso}>
          <th scope="row">
            <time dateTime={point.validTimeIso}>{tickLabelFor(point.validTimeIso, spanHours)}</time>
          </th>
          <td>{formatKw(point.band?.p10Kw)}</td>
          <td>{formatKw(point.medianKw)}</td>
          <td>{formatKw(point.band?.p90Kw)}</td>
          <td>{formatKw(point.actualKw)}</td>
          {overlay === undefined ? null : <td>{formatKw(overlay.values[index])}</td>}
        </tr>
      ))}
    </tbody>
  </table>
);
