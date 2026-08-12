import { OpenMeteoAttribution } from '@cumulo/ui';
import type { ReactElement } from 'react';

/**
 * The two credits every map view owes, in one persistent chip in the map's
 * bottom-right corner (`docs/design/map-treatment.md`, "Attribution"). It ran
 * the whole width of the bottom edge until #428 took it into the corner, which
 * is that document's decision to state and this file's only to compose.
 *
 * They are independent obligations and neither substitutes for the other: the
 * tile provider's credit comes from OpenFreeMap's use of OpenStreetMap data,
 * the weather credit from Open-Meteo's CC BY 4.0 licence — a hard constraint of
 * this repo. Tile credit first, weather credit second, matching the order the
 * reader is looking at: the map, then the data drawn on it.
 *
 * Both are visible without interaction. There is no "i" toggle and neither
 * credit is ever behind a control. What width changes is how much *prose* the
 * band carries: below the width at which the full row stops fitting on one line,
 * `map.css` drops the two droppable prefixes — `basemap tiles by` here,
 * `Weather data by` inside `OpenMeteoAttribution` — and the row reads
 * `© OpenStreetMap contributors · OpenFreeMap` and `Open-Meteo.com`. Both links,
 * the `©` and the `·` sit outside those wrappers and survive at every width; the
 * compact Open-Meteo form is the one CLAUDE.md sanctions where the row as
 * composed cannot hold its credits' full forms (owner-amended 2026-08-09;
 * composed-row reading owner-confirmed 2026-08-11). Which rows meet that
 * condition — and with it the decision that both prefixes go at once, at a width
 * belonging to this row rather than to either phrase — is owned by
 * `docs/design/map-treatment.md`'s Attribution section (#356, #415), which also
 * records that condition as the constraint's own wording rather than a reading
 * of it; `map.css` holds the measured width and the rule itself.
 *
 * Nothing here is conditional even so, because the two forms are one DOM: the
 * text is identical in both and only computed visibility differs. No licence
 * condition can be lost by a media query, and the wording tests beside this file
 * keep asserting the full phrase without knowing a compact form exists.
 *
 * Since #265 the band is overlaid on
 * the tiles rather than sitting in a strip under them, and what keeps the
 * treatment's contrast promise across that move is `--color-surface-veil`
 * (`map.css`): the ink still reads against a known surface colour, it is just a
 * mostly-opaque one with the map continuing behind it. Nothing here suppresses
 * pointer events — the links stay clickable, which is the licence condition,
 * not a nicety.
 *
 * The Open-Meteo credit's wording, link and styling belong to
 * `OpenMeteoAttribution`; this component composes it and, since #428, restyles
 * it in exactly one respect other than the compact-form rule the component
 * delegates to its surface: the ink, and only on the veil. That override lives
 * in `map.css` beside its reasoning — muted ink does not clear AA at the mix
 * this surface now ships on, and none of the four opaque surfaces the component
 * also serves has that problem. The wording, the size and the underline are
 * untouched, and nothing here hand-rolls the string.
 */
export const MapAttributionStrip = (): ReactElement => (
  <div className="map-attribution">
    <small className="map-attribution-tiles">
      <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
        © OpenStreetMap contributors
      </a>{' '}
      &middot; <span className="map-attribution-prefix">basemap tiles by </span>
      <a href="https://openfreemap.org/" target="_blank" rel="noreferrer">
        OpenFreeMap
      </a>
    </small>
    <OpenMeteoAttribution />
  </div>
);
