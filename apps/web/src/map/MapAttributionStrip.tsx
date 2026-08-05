import { OpenMeteoAttribution } from '@cumulo/ui';
import type { ReactElement } from 'react';

/**
 * The two credits every map view owes, in one persistent band across the bottom
 * of the map (`docs/design/map-treatment.md`, "Attribution").
 *
 * They are independent obligations and neither substitutes for the other: the
 * tile provider's credit comes from OpenFreeMap's use of OpenStreetMap data,
 * the weather credit from Open-Meteo's CC BY 4.0 licence — a hard constraint of
 * this repo. Tile credit first, weather credit second, matching the order the
 * reader is looking at: the map, then the data drawn on it.
 *
 * Both are visible without interaction. There is no "i" toggle and no
 * collapse-at-narrow-widths behaviour — the band wraps to two lines instead,
 * which is why nothing here is conditional. Since #265 the band is overlaid on
 * the tiles rather than sitting in a strip under them, and what keeps the
 * treatment's contrast promise across that move is `--color-surface-veil`
 * (`map.css`): the ink still reads against a known surface colour, it is just a
 * mostly-opaque one with the map continuing behind it. Nothing here suppresses
 * pointer events — the links stay clickable, which is the licence condition,
 * not a nicety.
 *
 * The Open-Meteo credit's wording, link and styling belong to
 * `OpenMeteoAttribution`; this component composes it and does not restyle it.
 */
export const MapAttributionStrip = (): ReactElement => (
  <div className="map-attribution">
    <small className="map-attribution-tiles">
      <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
        © OpenStreetMap contributors
      </a>{' '}
      &middot; basemap tiles by{' '}
      <a href="https://openfreemap.org/" target="_blank" rel="noreferrer">
        OpenFreeMap
      </a>
    </small>
    <OpenMeteoAttribution />
  </div>
);
