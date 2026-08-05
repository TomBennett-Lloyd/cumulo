import type { Site } from '@cumulo/shared';
import type { ReactElement } from 'react';

export interface MarkerButtonProps {
  readonly site: Site;
  readonly selected: boolean;
  readonly onSelect: (siteId: Site['id']) => void;
}

/**
 * One site on the map.
 *
 * A real `<button>`, which is the whole accessibility story in one decision:
 * it is focusable in DOM order, activated by Enter and Space without a line of
 * key handling here, and announced as actionable. A `<div>` with an `onClick`
 * would look identical and be unreachable without a pointer — and this map is
 * the primary way into a site's forecast.
 *
 * Nothing about hover or focus is state here (react.md rule 1): `map.css` owns
 * both through `:hover` and `:focus-visible`, so the browser's own idea of
 * "focused by keyboard" is the one that decides — a React `onFocus` handler
 * would light the marker up on a mouse click too. Selection is the one state
 * that comes in as a prop, because it is the *dashboard's* state: the list
 * under the map renders the same site from the same `selectedSiteId`.
 *
 * The tooltip is rendered always and revealed by CSS, rather than mounted on
 * hover: `aria-label` already names the marker for a screen reader, and text
 * that exists in the DOM cannot be lost to a race between pointer and paint.
 */
export const MarkerButton = ({ site, selected, onSelect }: MarkerButtonProps): ReactElement => (
  <button
    type="button"
    className={selected ? 'map-site-marker map-site-marker-selected' : 'map-site-marker'}
    aria-label={site.name}
    aria-current={selected ? true : undefined}
    onClick={() => {
      onSelect(site.id);
    }}
  >
    <span className="map-site-marker-tooltip">{site.name}</span>
  </button>
);
