import type { Site } from '@cumulo/shared';
import { useContext, useEffect } from 'react';

import { MapContext } from './MapContext';

export interface SelectionCameraProps {
  /** The site whose card is on the map, or `null` when nothing is selected. */
  readonly site: Site | null;
}

/**
 * Brings a selection into view when it is not already.
 *
 * A selection can arrive from somewhere that is not the map — a row in the list
 * below it, a `?site=` link, a creation, the search that lands later — and the
 * camera has no reason to be pointing anywhere near the site those name. Before
 * this, such a selection drew a card at a coordinate off screen: the marker
 * highlighted, the fleet chart gained a series, and the thing the reader asked
 * about was somewhere past the edge of the map with nothing saying which way.
 *
 * It moves **only when the site is outside the current bounds**, and it keeps
 * the zoom. Both halves are restraint rather than economy. Re-centring on a site
 * already on screen would shove the whole map sideways for a selection the
 * reader could see perfectly well — usually a marker they just pressed, which is
 * the worst possible thing to move. And changing the zoom would silently undo a
 * framing the reader chose, which is theirs, not the selection's.
 *
 * Renders nothing: the camera *is* the output. It synchronizes React's selection
 * with an external system that no render owns (`react.md` rule 1), which is why
 * it is an effect and not a line in each of the handlers that can select a site
 * — there are four of them and they do not all involve a click.
 *
 * Adapter code, and deliberately not unit-tested: jsdom gives maplibre no WebGL,
 * so there is no camera here to have bounds (`testing.md` rule 3). The browser
 * lane owns the criterion — selecting a site the camera cannot see brings it
 * into view — through the search case that arrives with #265's remaining chunk.
 */
export const SelectionCamera = ({ site }: SelectionCameraProps): null => {
  const map = useContext(MapContext);

  useEffect(() => {
    if (map === null || site === null) {
      return;
    }

    const center: [number, number] = [site.longitude, site.latitude];

    if (map.getBounds().contains(center)) {
      return;
    }

    map.easeTo({ center });
  }, [map, site]);

  return null;
};
