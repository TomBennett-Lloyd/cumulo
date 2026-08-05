import type { MapLibreMap } from 'maplibre-gl';
import { Marker } from 'maplibre-gl';
import type { ReactElement, ReactNode } from 'react';
import { useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import type { MapPosition } from './clustering';

export interface MapMarkerAnchorProps {
  readonly map: MapLibreMap;
  readonly position: MapPosition;
  readonly children: ReactNode;
}

/**
 * One maplibre marker, holding one React subtree at one coordinate.
 *
 * The split matters: because each anchor owns exactly one marker and React
 * owns the list of anchors, a change that leaves a marker's key alone — the
 * reader selecting a site, say — leaves its DOM element in place. A version
 * that tore down every marker whenever the point list changed would look
 * identical and quietly drop keyboard focus on every click, since the focused
 * button would be removed from the document mid-interaction.
 *
 * The element is made once per anchor in a lazy initialiser rather than in the
 * effect, because it is also the portal target this component returns during
 * render.
 *
 * A module of its own since #265, when a second caller arrived. It was private
 * to `SiteMarkers.tsx` while the fleet's markers were the only thing anchored to
 * a coordinate; the selected site's card is now anchored the same way
 * (`SitePopover.tsx`), and "put this subtree at this longitude and latitude" is
 * a statement about the map rather than about the fleet. Anything mounted
 * through here also inherits `isMarkerClick`'s exclusion (`map-click.ts`) for
 * free, because maplibre stamps `.maplibregl-marker` on every element it wraps —
 * so a click inside the subtree is never also read as a click on the basemap.
 */
export const MapMarkerAnchor = ({
  map,
  position,
  children,
}: MapMarkerAnchorProps): ReactElement => {
  const [element] = useState(() => document.createElement('div'));

  /*
   * The marker's lifetime on the map is the external system here (react.md
   * rule 1); its contents are React's business and go through the portal.
   *
   * A **layout** effect, and that is a correctness requirement rather than a
   * paint optimisation. Passive effects flush child-first, so anything mounted
   * through this portal runs its own `useEffect` *before* the line below puts
   * this element in the document — the subtree is real, rendered, and detached.
   * A child that only reads props never notices; a child that touches the DOM
   * does, and `focus()` on a detached element is a silent no-op. That is exactly
   * how the selected site's card (`SitePopoverCard.tsx`) came to focus its
   * heading into nothing, which no jsdom test could see because the suites mount
   * that card directly and only the browser lane assembles it through here.
   * Layout effects flush for the whole commit before any passive effect, so
   * attaching here is what makes "the portal's target is in the document" true
   * by the time a child's effect runs.
   */
  useLayoutEffect(() => {
    const marker = new Marker({ element })
      .setLngLat([position.longitude, position.latitude])
      .addTo(map);

    return () => {
      marker.remove();
    };
  }, [map, element, position.longitude, position.latitude]);

  return createPortal(children, element);
};
