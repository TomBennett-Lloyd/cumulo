import type { ReactElement } from 'react';
import { useContext } from 'react';

import { MapContext } from './MapContext';
import { MapMarkerAnchor } from './MapMarkerAnchor';
import { SitePopoverCard, type SitePopoverCardProps } from './SitePopoverCard';

export type SitePopoverProps = SitePopoverCardProps;

/**
 * The selected site's card, anchored to the site's own coordinate.
 *
 * The whole of this component is the anchoring: it takes the card's props
 * unchanged and puts the card where the site is. That split is deliberate and it
 * is the same one `SiteMarkers` makes — everything with a decision in it lives
 * in the presentational half (`SitePopoverCard`, tested directly in jsdom), and
 * what is left here is adapter code that cannot run without WebGL and is
 * therefore not unit-tested at all (`testing.md` rule 3). The browser lane is
 * where the assembled version is exercised (`e2e/keyboard-focus.spec.ts`,
 * `e2e/chart-surfaces.spec.ts`).
 *
 * Anchored rather than laid out beside the map, because the card is an answer
 * about a *place* and the place is on screen. The old arrangement put it in the
 * reading column under the map, which meant a selection could be written into a
 * region the reader had scrolled past — and the dashboard carried a scroll
 * effect to chase it (#148 review cycle 1, retired with this move).
 *
 * Two things come free from going through `MapMarkerAnchor`. The card rides the
 * camera, so panning and zooming keep it over its site rather than over a patch
 * of sea. And maplibre stamps `.maplibregl-marker` on the element it wraps, so
 * `isMarkerClick` (`map-click.ts`) already excludes every click inside the card
 * from the basemap's own click handler — a press on `Close` with add-site mode
 * armed cannot also drop a draft.
 *
 * Riding a marker costs one thing, which `site-popover-anchor` pays: markers are
 * siblings that stack by DOM order, so the card's own marker has to be told to
 * outrank the fleet's rather than hope it was mounted last. `site-popover.css`
 * holds the value and the argument; the class is here because the element it
 * lands on is the one this component asks for.
 *
 * It renders nothing before the map exists: `MapContext` is `null` for the frame
 * between `MapView` mounting and its instance being created, and a card with
 * nowhere to go is not a state worth modelling.
 */
export const SitePopover = (props: SitePopoverProps): ReactElement | null => {
  const map = useContext(MapContext);

  if (map === null) {
    return null;
  }

  return (
    <MapMarkerAnchor
      map={map}
      position={{ longitude: props.site.longitude, latitude: props.site.latitude }}
      className="site-popover-anchor"
    >
      <SitePopoverCard {...props} />
    </MapMarkerAnchor>
  );
};
