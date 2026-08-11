import type { ReactElement } from 'react';

/**
 * The chart sample, drawn to `docs/design/chart-treatment.md`: P10–P90 band as a
 * 10% wash with hairline bounds, median on top, actuals in near-ink last, and a
 * horizon rule where the measurements stop. Plain numbers, no data layer — this
 * is a swatch of the treatment, not a chart component. The real chart, with the
 * crosshair and tooltip layer the treatment also specifies, arrives with the
 * dashboard in #19.
 *
 * The same two rules as the rest of the preview apply: no literal colours or
 * sizes, and every visual value comes from a CSS class consuming a token. The
 * numbers below are geometry — SVG user units and kW — not styling.
 */

interface ForecastPoint {
  readonly hour: string;
  readonly p10: number;
  readonly median: number;
  readonly p90: number;
  /** `null` past the forecast horizon: no measurement exists there yet. */
  readonly actual: number | null;
}

const SAMPLE_FORECAST: readonly ForecastPoint[] = [
  { hour: '06:00', p10: 0.1, median: 0.4, p90: 0.8, actual: 0.5 },
  { hour: '08:00', p10: 1.2, median: 2.1, p90: 3.0, actual: 2.4 },
  { hour: '10:00', p10: 3.0, median: 4.6, p90: 6.0, actual: 4.2 },
  { hour: '12:00', p10: 4.1, median: 6.2, p90: 7.6, actual: 5.9 },
  { hour: '14:00', p10: 3.3, median: 5.4, p90: 7.0, actual: null },
  { hour: '16:00', p10: 1.4, median: 2.8, p90: 4.1, actual: null },
  { hour: '18:00', p10: 0.2, median: 0.6, p90: 1.1, actual: null },
];

/** SVG user units. Geometry is not styling: these are coordinates, not sizes. */
const PLOT = { left: 46, right: 452, top: 16, bottom: 164 } as const;
const AXIS_MAX_KW = 8;
const AXIS_TICKS_KW: readonly number[] = [0, 2, 4, 6, 8];

const xForIndex = (index: number): number =>
  PLOT.left + ((PLOT.right - PLOT.left) * index) / (SAMPLE_FORECAST.length - 1);

const yForKilowatts = (kilowatts: number): number =>
  PLOT.bottom - ((PLOT.bottom - PLOT.top) * kilowatts) / AXIS_MAX_KW;

const svgPoint = (x: number, y: number): string => `${x.toFixed(1)},${y.toFixed(1)}`;

const pointsAt = (bound: (point: ForecastPoint) => number): string =>
  SAMPLE_FORECAST.map((point, index) =>
    svgPoint(xForIndex(index), yForKilowatts(bound(point))),
  ).join(' ');

const upperBoundPoints = pointsAt((point) => point.p90);
const lowerBoundPoints = pointsAt((point) => point.p10);
const medianPoints = pointsAt((point) => point.median);

// The band is one closed shape: the P90 bounds left to right, then the P10
// bounds back again. It is filled and never stroked, so the vertical closing
// edges — plot boundaries, not data — stay invisible while the two bounds get
// their own stroked polylines below.
const bandPoints = `${upperBoundPoints} ${lowerBoundPoints.split(' ').reverse().join(' ')}`;

const measuredPoints = SAMPLE_FORECAST.flatMap((point, index) =>
  point.actual === null ? [] : [svgPoint(xForIndex(index), yForKilowatts(point.actual))],
);
const actualsPoints = measuredPoints.join(' ');
const lastMeasuredIndex = SAMPLE_FORECAST.reduce(
  (latest, point, index) => (point.actual === null ? latest : index),
  0,
);
const horizonX = xForIndex(lastMeasuredIndex);

export const TokensPreviewChart = (): ReactElement => (
  <figure className="chart-figure">
    <svg
      className="chart"
      viewBox="0 0 480 194"
      role="img"
      aria-label="Sample day for one site: a P10 to P90 forecast band with its median, and measured actuals up to the forecast horizon. The same numbers are in the table below."
    >
      {AXIS_TICKS_KW.map((kilowatts) => (
        <g key={kilowatts}>
          <line
            className="chart-grid"
            x1={PLOT.left}
            x2={PLOT.right}
            y1={yForKilowatts(kilowatts)}
            y2={yForKilowatts(kilowatts)}
          />
          <text
            className="chart-axis-label"
            x={PLOT.left - 10}
            y={yForKilowatts(kilowatts)}
            textAnchor="end"
            dominantBaseline="middle"
          >
            {kilowatts}
          </text>
        </g>
      ))}

      <polygon className="chart-band" points={bandPoints} />
      <polyline className="chart-band-bound" points={upperBoundPoints} />
      <polyline className="chart-band-bound" points={lowerBoundPoints} />

      <line className="chart-horizon" x1={horizonX} x2={horizonX} y1={PLOT.top} y2={PLOT.bottom} />

      <polyline className="chart-median" points={medianPoints} />
      <polyline className="chart-actuals" points={actualsPoints} />
      <circle
        className="chart-actuals-marker"
        cx={horizonX}
        cy={yForKilowatts(SAMPLE_FORECAST[lastMeasuredIndex]?.actual ?? 0)}
        r={4}
      />

      {SAMPLE_FORECAST.map((point, index) => (
        <text
          key={point.hour}
          className="chart-axis-label"
          x={xForIndex(index)}
          y={PLOT.bottom + 18}
          textAnchor="middle"
        >
          {point.hour}
        </text>
      ))}

      <text className="chart-axis-title" x={0} y={10}>
        kW
      </text>
    </svg>

    <ul className="chart-legend">
      <li>
        <svg className="legend-key" viewBox="0 0 28 14" aria-hidden="true">
          <rect className="chart-band" x="0" y="2" width="28" height="10" />
          <line className="chart-band-bound" x1="0" x2="28" y1="2.5" y2="2.5" />
          <line className="chart-band-bound" x1="0" x2="28" y1="11.5" y2="11.5" />
        </svg>
        Forecast (P10–P90)
      </li>
      <li>
        <svg className="legend-key" viewBox="0 0 28 14" aria-hidden="true">
          <line className="chart-median" x1="0" x2="28" y1="7" y2="7" />
        </svg>
        Forecast (median)
      </li>
      <li>
        <svg className="legend-key" viewBox="0 0 28 14" aria-hidden="true">
          <line className="chart-actuals" x1="0" x2="28" y1="7" y2="7" />
        </svg>
        Actuals
      </li>
    </ul>

    <table className="chart-table">
      <caption>Table view — the same sample, in kW</caption>
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
        {SAMPLE_FORECAST.map((point) => (
          <tr key={point.hour}>
            <th scope="row">{point.hour}</th>
            <td>{point.p10.toFixed(1)}</td>
            <td>{point.median.toFixed(1)}</td>
            <td>{point.p90.toFixed(1)}</td>
            <td>{point.actual === null ? '—' : point.actual.toFixed(1)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </figure>
);
