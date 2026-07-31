import { OpenMeteoAttribution, tokens } from '@cumulo/ui';
import type { ReactElement } from 'react';

/**
 * The rendered proof of the design system: every token in `@cumulo/ui`, on
 * screen, in whichever theme the shell has selected.
 *
 * Two rules shape everything below.
 *
 * 1. **The token list is derived, never retyped.** Sections iterate the `tokens`
 *    export, so a token added to `tokens.css` shows up here without anyone
 *    remembering to add it. What a swatch *looks* like still comes from
 *    `preview.css`, keyed by `[data-token='--name']` — the selector is the token
 *    name, so there is no second name to keep in sync.
 * 2. **No literal values.** No hex, no pixel sizes, no `style` prop — the same
 *    gate the rest of the frontend is held to (eslint.config.mjs,
 *    stylelint.config.mjs). Labels show token *names*; the browser supplies the
 *    values.
 */

/** `'var(--color-bg)'` → `'--color-bg'`. */
function customPropertyName(reference: string): string {
  return reference.replace(/^var\(|\)$/g, '');
}

const colorTokens = Object.values(tokens.color).map(customPropertyName);
const spaceTokens = Object.values(tokens.space).map(customPropertyName);
const textTokens = Object.values(tokens.text).map(customPropertyName);
const fontTokens = Object.values(tokens.font).map(customPropertyName);
const radiusTokens = Object.values(tokens.radius).map(customPropertyName);

const chartColorTokens = colorTokens.filter((name) => name.startsWith('--color-chart-'));
const mapColorTokens = colorTokens.filter((name) => name.startsWith('--color-map-'));
const baseColorTokens = colorTokens.filter(
  (name) => !name.startsWith('--color-chart-') && !name.startsWith('--color-map-'),
);

const fontWeightTokens = fontTokens.filter((name) => name.startsWith('--font-weight-'));
const lineHeightTokens = fontTokens.filter((name) => name.startsWith('--leading-'));
const typefaceTokens = fontTokens.filter(
  (name) => !fontWeightTokens.includes(name) && !lineHeightTokens.includes(name),
);

/* ── Chart sample ──────────────────────────────────────────────────────────
 *
 * A single site's day, drawn to `docs/design/chart-treatment.md`: P10–P90 band
 * as a 10% wash with hairline bounds, median on top, actuals in near-ink last,
 * and a horizon rule where the measurements stop. Plain numbers, no data layer
 * — this is a swatch of the treatment, not a chart component. The real chart,
 * with the crosshair and tooltip layer the treatment also specifies, arrives
 * with the dashboard in #19.
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

function xForIndex(index: number): number {
  return PLOT.left + ((PLOT.right - PLOT.left) * index) / (SAMPLE_FORECAST.length - 1);
}

function yForKilowatts(kilowatts: number): number {
  return PLOT.bottom - ((PLOT.bottom - PLOT.top) * kilowatts) / AXIS_MAX_KW;
}

function svgPoint(x: number, y: number): string {
  return `${x.toFixed(1)},${y.toFixed(1)}`;
}

function pointsAt(bound: (point: ForecastPoint) => number): string {
  return SAMPLE_FORECAST.map((point, index) =>
    svgPoint(xForIndex(index), yForKilowatts(bound(point))),
  ).join(' ');
}

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

/* ── Map marker states ──────────────────────────────────────────────────── */

interface MarkerState {
  readonly label: string;
  readonly token: string;
  readonly className: string;
}

const MARKER_STATES: readonly MarkerState[] = [
  { label: 'Default', token: '--color-map-marker', className: 'map-marker' },
  { label: 'Hover', token: '--color-map-marker-hover', className: 'map-marker map-marker-hover' },
  {
    label: 'Selected',
    token: '--color-map-marker-selected',
    className: 'map-marker map-marker-selected',
  },
];

/* ── Sections ──────────────────────────────────────────────────────────── */

function ColorSwatches({ names }: { readonly names: readonly string[] }): ReactElement {
  return (
    <ul className="swatch-grid">
      {names.map((name) => (
        <li key={name} className="swatch">
          <span className="swatch-chip" data-token={name} aria-hidden="true" />
          <code className="token-name">{name}</code>
        </li>
      ))}
    </ul>
  );
}

function TokensPreviewChart(): ReactElement {
  return (
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

        <line
          className="chart-horizon"
          x1={horizonX}
          x2={horizonX}
          y1={PLOT.top}
          y2={PLOT.bottom}
        />
        <text className="chart-axis-label" x={horizonX + 6} y={PLOT.top + 8}>
          forecast horizon
        </text>

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
}

export function TokensPreview(): ReactElement {
  return (
    <main className="preview">
      <section className="section" aria-labelledby="colour-heading">
        <h2 id="colour-heading">Colour</h2>
        <p className="section-note">
          Direction B, “Meridian”. Both palettes were validated independently against their own
          surface — dark is chosen, not an inversion of light.
        </p>

        <h3>Base</h3>
        <ColorSwatches names={baseColorTokens} />

        <h3>Chart</h3>
        <ColorSwatches names={chartColorTokens} />

        <h3>Map</h3>
        <ColorSwatches names={mapColorTokens} />
      </section>

      <section className="section" aria-labelledby="spacing-heading">
        <h2 id="spacing-heading">Spacing</h2>
        <p className="section-note">A 0.25rem grid. Every gap, pad and margin in the product.</p>
        <ul className="scale-list">
          {spaceTokens.map((name) => (
            <li key={name} className="scale-row">
              <code className="token-name">{name}</code>
              <span className="space-bar" data-token={name} aria-hidden="true" />
            </li>
          ))}
        </ul>
      </section>

      <section className="section" aria-labelledby="type-heading">
        <h2 id="type-heading">Type</h2>
        <ul className="scale-list">
          {textTokens.map((name) => (
            <li key={name} className="scale-row">
              <code className="token-name">{name}</code>
              <span className="type-specimen" data-token={name}>
                Fleet output at 14:00
              </span>
            </li>
          ))}
        </ul>

        <h3>Typefaces</h3>
        <ul className="scale-list">
          {typefaceTokens.map((name) => (
            <li key={name} className="scale-row">
              <code className="token-name">{name}</code>
              <span className="type-specimen" data-token={name}>
                Fleet output 1,248 kW
              </span>
            </li>
          ))}
        </ul>

        <h3>Weights</h3>
        <ul className="scale-list">
          {fontWeightTokens.map((name) => (
            <li key={name} className="scale-row">
              <code className="token-name">{name}</code>
              <span className="type-specimen" data-token={name}>
                Fleet output at 14:00
              </span>
            </li>
          ))}
        </ul>

        <h3>Line height</h3>
        <ul className="scale-list">
          {lineHeightTokens.map((name) => (
            <li key={name} className="scale-row">
              <code className="token-name">{name}</code>
              <span className="leading-specimen" data-token={name}>
                Forecast confidence widens with horizon, so the band widens with it — the further
                out you read, the more room the distribution takes.
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="section" aria-labelledby="radius-heading">
        <h2 id="radius-heading">Radii</h2>
        <ul className="radius-list">
          {radiusTokens.map((name) => (
            <li key={name} className="scale-row">
              <code className="token-name">{name}</code>
              <span className="radius-box" data-token={name} aria-hidden="true" />
            </li>
          ))}
        </ul>
      </section>

      <section className="section" aria-labelledby="chart-heading">
        <h2 id="chart-heading">Chart treatment</h2>
        <p className="section-note">
          The uncertainty band as specified in{' '}
          <code className="token-name">chart-treatment.md</code>: a 10% wash of the forecast hue,
          hairline P10/P90 bounds, the median on top, and actuals in near-ink drawn last so the
          measurement always wins the overlap.
        </p>
        <TokensPreviewChart />
      </section>

      <section className="section" aria-labelledby="map-heading">
        <h2 id="map-heading">Map markers</h2>
        <p className="section-note">
          Three states over a desaturated basemap, per <code>map-treatment.md</code>. Size changes
          with state as well as colour — no state is carried by hue alone.
        </p>
        <ul className="marker-list">
          {MARKER_STATES.map((state) => (
            <li key={state.label} className="marker-item">
              <span className="marker-stage">
                <span className={state.className} aria-hidden="true" />
              </span>
              <span className="marker-label">{state.label}</span>
              <code className="token-name">{state.token}</code>
            </li>
          ))}
        </ul>
      </section>

      <footer className="preview-footer">
        <p className="section-note">
          The sample above is illustrative rather than live, and it still carries the credit: every
          view that shows weather-derived data composes this component.
        </p>
        <OpenMeteoAttribution />
      </footer>
    </main>
  );
}
