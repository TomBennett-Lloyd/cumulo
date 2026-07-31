import type { Site } from '@cumulo/shared';
import type { MapLibreMap } from 'maplibre-gl';
import { Marker } from 'maplibre-gl';
import type { ReactElement, ReactNode } from 'react';
import { useContext, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MapPosition, MapViewport } from './clustering';
import { buildClusterIndex, pointsForViewport } from './clustering';
import { ClusterButton } from './ClusterButton';
import { MapContext } from './MapContext';
import { MarkerButton } from './MarkerButton';

/** What the map is showing right now, in the clustering module's vocabulary. */
const viewportOf = (map: MapLibreMap): MapViewport => {
  const bounds = map.getBounds();

  return {
    zoom: map.getZoom(),
    bounds: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
  };
};

interface MapMarkerAnchorProps {
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
 */
const MapMarkerAnchor = ({ map, position, children }: MapMarkerAnchorProps): ReactElement => {
  const [element] = useState(() => {
    const anchor = document.createElement('div');

    /*
     * Claim the shell's semantics before maplibre can.
     *
     * `Marker.addTo` in maplibre 6.0.0 stamps `role="button"` and
     * `aria-label="Map marker"` onto any marker element that has neither — the
     * two `hasAttribute` guards are its whole condition, and 6.0.0 applies them
     * to supplied elements as well as its own. Left alone, that wraps the real
     * `<button>` inside a second interactive element and gives all sixty
     * markers the same accessible name, so the fleet reads to a screen reader
     * as sixty things called "Map marker".
     *
     * Declaring a role first satisfies the role guard: this div positions
     * something, it is not itself a control. The label guard only takes
     * `hasAttribute` for an answer, so that half is undone after the fact
     * rather than pre-empted with a placeholder — an `aria-label` on a
     * presentational element is prohibited by ARIA, and leaving an empty one
     * behind would trade a wrong name for a malformed one.
     *
     * Fixed upstream in 6.1.0, which leaves custom elements alone; this stays
     * until the dependency moves.
     */
    anchor.setAttribute('role', 'presentation');

    return anchor;
  });

  // The marker's lifetime on the map is the external system here (react.md
  // rule 1); its contents are React's business and go through the portal.
  useEffect(() => {
    const marker = new Marker({ element })
      .setLngLat([position.longitude, position.latitude])
      .addTo(map);

    element.removeAttribute('aria-label');

    return () => {
      marker.remove();
    };
  }, [map, element, position.longitude, position.latitude]);

  return createPortal(children, element);
};

interface FleetMarkersProps {
  readonly map: MapLibreMap;
  readonly sites: readonly Site[];
  readonly selectedSiteId: Site['id'] | null;
  readonly onSelectSite: (siteId: Site['id']) => void;
}

const FleetMarkers = ({
  map,
  sites,
  selectedSiteId,
  onSelectSite,
}: FleetMarkersProps): ReactElement => {
  const [viewport, setViewport] = useState<MapViewport>(() => viewportOf(map));

  // The camera is an external system that changes without telling React
  // (react.md rule 1): subscribe, and mirror it into state. `moveend`/`zoomend`
  // rather than `move`/`zoom` — reclustering on every animation frame of a
  // flyTo would rebuild every marker sixty times a second for no visual gain.
  useEffect(() => {
    const sync = (): void => {
      setViewport(viewportOf(map));
    };

    sync();
    map.on('moveend', sync);
    map.on('zoomend', sync);

    return () => {
      map.off('moveend', sync);
      map.off('zoomend', sync);
    };
  }, [map]);

  // Derived, so it is computed during render rather than pushed into state by
  // an effect. The memo is for identity, not speed: the index is what every
  // point below is read out of, and rebuilding it per render would also
  // rebuild it per keystroke of an unrelated parent's state.
  const index = useMemo(() => buildClusterIndex(sites), [sites]);
  const points = pointsForViewport(index, viewport, selectedSiteId);

  return (
    <>
      {points.map((point) =>
        point.kind === 'site' ? (
          <MapMarkerAnchor
            key={`site:${point.site.id}`}
            map={map}
            position={{ longitude: point.site.longitude, latitude: point.site.latitude }}
          >
            <MarkerButton site={point.site} selected={point.selected} onSelect={onSelectSite} />
          </MapMarkerAnchor>
        ) : (
          <MapMarkerAnchor
            key={`cluster:${String(point.clusterId)}`}
            map={map}
            position={point.position}
          >
            <ClusterButton
              count={point.count}
              sizeBand={point.sizeBand}
              containsSelected={point.containsSelected}
              onActivate={() => {
                map.easeTo({
                  center: [point.position.longitude, point.position.latitude],
                  zoom: point.expansionZoom,
                });
              }}
            />
          </MapMarkerAnchor>
        ),
      )}
    </>
  );
};

export interface SiteMarkersProps {
  readonly sites: readonly Site[];
  readonly selectedSiteId: Site['id'] | null;
  readonly onSelectSite: (siteId: Site['id']) => void;
}

/**
 * The fleet, drawn on the map: a marker per site where sites separate, a bubble
 * per knot where they do not.
 *
 * Like `MapView`, this is adapter code and deliberately untested (testing.md
 * rule 3) — WebGL does not run in jsdom, and a suite that mocked maplibre would
 * only prove the mock was called. Everything with a decision in it was moved
 * out: which points exist is `clustering.ts`, what they look like is
 * `MarkerButton`/`ClusterButton` and `map.css`, and all three are tested
 * directly.
 *
 * Two behaviours to know about. Points arrive in fleet order, and each anchor
 * appends its element as it mounts, so tab order follows the site list exactly
 * whenever the visible set is replaced wholesale — which is what zooming,
 * selecting and adding a site all do. A pan that keeps some markers and adds
 * others appends the newcomers after the survivors, so the sequence can drift
 * from fleet order until the next reclustering; the alternative, reordering the
 * DOM on every camera move, buys a rare case at the cost of machinery no test
 * in this repo could cover.
 *
 * It renders nothing before the map exists — `MapContext` is `null` for the
 * frame between `MapView` mounting and its map instance being created, and
 * markers with nowhere to go are not a state worth modelling.
 */
export const SiteMarkers = ({
  sites,
  selectedSiteId,
  onSelectSite,
}: SiteMarkersProps): ReactElement | null => {
  const map = useContext(MapContext);

  if (map === null) {
    return null;
  }

  return (
    <FleetMarkers
      map={map}
      sites={sites}
      selectedSiteId={selectedSiteId}
      onSelectSite={onSelectSite}
    />
  );
};
