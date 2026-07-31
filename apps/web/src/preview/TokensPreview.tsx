import { OpenMeteoAttribution, tokens } from '@cumulo/ui';
import type { ReactElement } from 'react';
import { ColorSwatches } from './ColorSwatches';
import { MapMarkerStates } from './MapMarkerStates';
import { ScaleRow } from './ScaleRow';
import { TokensPreviewChart } from './TokensPreviewChart';

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
 *
 * The two sections that carry their own data — the chart treatment and the map
 * markers — live in their own modules beside this one; this file is the page
 * that composes them, which is what keeps it readable as a table of contents.
 */

/** `'var(--color-bg)'` → `'--color-bg'`. */
const customPropertyName = (reference: string): string => reference.replace(/^var\(|\)$/g, '');

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

export const TokensPreview = (): ReactElement => (
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
          <ScaleRow key={name} name={name}>
            <span className="space-bar" data-token={name} aria-hidden="true" />
          </ScaleRow>
        ))}
      </ul>
    </section>

    <section className="section" aria-labelledby="type-heading">
      <h2 id="type-heading">Type</h2>
      <ul className="scale-list">
        {textTokens.map((name) => (
          <ScaleRow key={name} name={name}>
            <span className="type-specimen" data-token={name}>
              Fleet output at 14:00
            </span>
          </ScaleRow>
        ))}
      </ul>

      <h3>Typefaces</h3>
      <ul className="scale-list">
        {typefaceTokens.map((name) => (
          <ScaleRow key={name} name={name}>
            <span className="type-specimen" data-token={name}>
              Fleet output 1,248 kW
            </span>
          </ScaleRow>
        ))}
      </ul>

      <h3>Weights</h3>
      <ul className="scale-list">
        {fontWeightTokens.map((name) => (
          <ScaleRow key={name} name={name}>
            <span className="type-specimen" data-token={name}>
              Fleet output at 14:00
            </span>
          </ScaleRow>
        ))}
      </ul>

      <h3>Line height</h3>
      <ul className="scale-list">
        {lineHeightTokens.map((name) => (
          <ScaleRow key={name} name={name}>
            <span className="leading-specimen" data-token={name}>
              Forecast confidence widens with horizon, so the band widens with it — the further out
              you read, the more room the distribution takes.
            </span>
          </ScaleRow>
        ))}
      </ul>
    </section>

    <section className="section" aria-labelledby="radius-heading">
      <h2 id="radius-heading">Radii</h2>
      <ul className="radius-list">
        {radiusTokens.map((name) => (
          <ScaleRow key={name} name={name}>
            <span className="radius-box" data-token={name} aria-hidden="true" />
          </ScaleRow>
        ))}
      </ul>
    </section>

    <section className="section" aria-labelledby="chart-heading">
      <h2 id="chart-heading">Chart treatment</h2>
      <p className="section-note">
        The uncertainty band as specified in <code className="token-name">chart-treatment.md</code>:
        a 10% wash of the forecast hue, hairline P10/P90 bounds, the median on top, and actuals in
        near-ink drawn last so the measurement always wins the overlap.
      </p>
      <TokensPreviewChart />
    </section>

    <section className="section" aria-labelledby="map-heading">
      <h2 id="map-heading">Map markers</h2>
      <p className="section-note">
        Three states over a desaturated basemap, per <code>map-treatment.md</code>. Size changes
        with state as well as colour — no state is carried by hue alone.
      </p>
      <MapMarkerStates />
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
