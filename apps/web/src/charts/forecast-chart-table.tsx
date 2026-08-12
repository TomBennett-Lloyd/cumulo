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
 *
 * **Folded away by default** (#284 D3). Every row of a 193-hour window under the
 * plot pushed the rest of the page out of sight, and the chart itself was held
 * to a measure narrower than its panel to leave the table somewhere to sit. So
 * the twin lives behind a closed `<details>`, a native disclosure rather than a
 * button toggling state of ours: the platform owns the open/closed semantics,
 * the keyboard operation and the announcement, and none of it is ours to get
 * wrong. A closed `<details>` keeps its children in the
 * *document* but not in the *accessibility tree* — a browser does not render
 * them, and unrendered content is excluded — so a screen reader meets the
 * collapsed disclosure, not the table behind it. The treatment's "reachable from
 * the chart container" is discharged by reachability rather than by presence:
 * the twin is one press on a named, keyboard-operable control away, and a route
 * one press away is a route. (`dashboard/dashboard-test-fixture.tsx` queries the
 * table without opening anything, which works because jsdom omits the
 * `<details>` shadow-tree styles — a fact about that environment, not a claim
 * about readers.)
 *
 * The `<caption>` stays inside the table rather than being folded into the
 * summary: it is the table's accessible name, it says which window and which
 * units the numbers are in, and a summary is a name for the *disclosure*.
 *
 * **The P10 and P90 columns exist only where some hour has a band** (#295), the
 * same honesty rule the legend's band row keeps. Two columns of em dashes down
 * every row are not a partial result — they are the table advertising a
 * quantity the series never carried. A *mixed* series is the case that keeps
 * them: there the em dash is doing its ordinary job of saying "this hour has no
 * value", against neighbours that do, so the columns stay exactly as they were.
 * Computed here rather than taken as a parameter because it is a fact about
 * `points`, and a caller free to disagree with the points it passed is a way for
 * the headers and the cells to end up saying different things.
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
}: ForecastChartTableParams): ReactElement => {
  const hasBand = points.some((point) => point.band !== undefined);

  return (
    <details className="forecast-chart-details">
      <summary className="forecast-chart-summary">Raw data</summary>

      <table className="forecast-chart-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{TIME_COLUMN_HEADER}</th>
            {hasBand ? <th scope="col">P10</th> : null}
            <th scope="col">Median</th>
            {hasBand ? <th scope="col">P90</th> : null}
            <th scope="col">Actual</th>
            {overlay === undefined ? null : <th scope="col">{overlay.label}</th>}
          </tr>
        </thead>
        <tbody>
          {points.map((point, index) => (
            <tr key={point.validTimeIso}>
              <th scope="row">
                <time dateTime={point.validTimeIso}>
                  {tickLabelFor(point.validTimeIso, spanHours)}
                </time>
              </th>
              {hasBand ? <td>{formatKw(point.band?.p10Kw)}</td> : null}
              <td>{formatKw(point.medianKw)}</td>
              {hasBand ? <td>{formatKw(point.band?.p90Kw)}</td> : null}
              <td>{formatKw(point.actualKw)}</td>
              {overlay === undefined ? null : <td>{formatKw(overlay.values[index])}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
};
