import 'maplibre-gl/dist/maplibre-gl.css';

import type { MapMouseEvent } from 'maplibre-gl';
import { MapLibreMap } from 'maplibre-gl';
import type { ReactElement, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { Theme } from '../theme';
import { basemapStyleUrl } from './basemap';
import { MapAttributionStrip } from './MapAttributionStrip';
import { MapContext } from './MapContext';

/** A position on the map, named in the domain's vocabulary rather than GL's. */
export interface MapPosition {
  readonly longitude: number;
  readonly latitude: number;
}

export interface MapViewProps {
  readonly theme: Theme;
  /** Fired for clicks on the map itself; overlay markers handle their own. */
  readonly onMapClick?: (position: MapPosition) => void;
  /** Overlays — markers, clusters — which reach the map through `MapContext`. */
  readonly children?: ReactNode;
}

/** Framing that puts Ireland and the UK on screen together — the seed fleet. */
const INITIAL_CENTER: [number, number] = [-4.5, 54.6];
const INITIAL_ZOOM = 4.6;

/**
 * The map surface: a maplibre instance, the overlays drawn on it, and the
 * attribution strip beneath it.
 *
 * This is the app's one adapter onto maplibre, and it is deliberately thin —
 * WebGL cannot run in jsdom, so anything that lives here cannot be unit-tested
 * without mocking the library, which would prove nothing (testing.md rule 3).
 * Everything with a decision in it — which basemap a theme gets, how sites
 * cluster, what a marker looks like — lives in modules beside this one that are
 * tested on their own terms.
 *
 * Three effects, three external systems (react.md rule 1): the map's lifetime,
 * its style, and its click subscription. They are separate because they have
 * different dependencies — folding the style into the lifetime effect would
 * make `theme` a dependency of map *creation*, and the map would be destroyed
 * and rebuilt every time the visitor flipped the toggle.
 */
export const MapView = ({ theme, onMapClick, children }: MapViewProps): ReactElement => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<MapLibreMap | null>(null);

  // The latest click handler without resubscribing when it changes: the
  // subscription belongs to the map, not to the callback identity.
  const onMapClickRef = useRef(onMapClick);
  onMapClickRef.current = onMapClick;

  useEffect(() => {
    const container = containerRef.current;

    if (container === null) {
      return;
    }

    // No `style` here on purpose — the style effect below owns it, including
    // the first one, so there is exactly one place the basemap is chosen.
    // `attributionControl: false` because maplibre's own control would be a
    // second, differently-styled copy of the credits `MapAttributionStrip`
    // already renders on the surface where they are legible.
    const instance = new MapLibreMap({
      container,
      center: INITIAL_CENTER,
      zoom: INITIAL_ZOOM,
      attributionControl: false,
    });

    setMap(instance);

    return () => {
      setMap(null);
      instance.remove();
    };
  }, []);

  useEffect(() => {
    map?.setStyle(basemapStyleUrl(theme));
  }, [map, theme]);

  useEffect(() => {
    if (map === null) {
      return;
    }

    const handleClick = (event: MapMouseEvent): void => {
      onMapClickRef.current?.({ longitude: event.lngLat.lng, latitude: event.lngLat.lat });
    };

    map.on('click', handleClick);

    return () => {
      map.off('click', handleClick);
    };
  }, [map]);

  return (
    <div className="map-view">
      <div className="map-canvas" ref={containerRef} />
      <MapContext value={map}>{children}</MapContext>
      <MapAttributionStrip />
    </div>
  );
};
