import 'maplibre-gl/dist/maplibre-gl.css';

import type { MapMouseEvent } from 'maplibre-gl';
import { MapLibreMap, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { ReactElement, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { Theme } from '../theme';
import { basemapStyleUrl } from './basemap';
import type { MapPosition } from './clustering';
import { INITIAL_CENTER, INITIAL_ZOOM } from './framing';
import { MapContext } from './MapContext';
import { MapSurface } from './MapSurface';
import { isMarkerClick } from './map-click';

/*
 * Tell maplibre where its worker is, once, before any map exists.
 *
 * Left alone, maplibre v6 derives the worker URL from its own `import.meta.url`
 * — `new URL('./maplibre-gl-worker.mjs', <this module's url>)`. That address is
 * a lie under any bundler: in dev the library is pre-bundled into
 * `node_modules/.vite/deps/`, where no worker file is ever emitted, so the
 * request hangs, the worker never starts, and the map paints a black rectangle
 * with not one tile request issued. Vite's own error text suggests
 * `optimizeDeps.exclude`, which silences dev and leaves `vite build` shipping
 * the same dead map — the derived URL is dynamic, so rollup cannot emit the
 * file there either.
 *
 * So this is maplibre's documented per-bundler fix rather than a workaround.
 * `?worker&url` and not `?url`: the dist worker imports its sibling
 * `maplibre-gl-shared.mjs`, and `?url` would emit the worker verbatim without
 * it, failing on its first import in production only. `?worker&url` routes it
 * through Vite's worker pipeline, which emits a self-contained chunk.
 *
 * `map-worker-contract.test.ts` is the only observer this wiring has: a source
 * contract that bites in `verify`, with no build and no browser binary. The
 * failure itself only exists in a browser, and the browser lane now exists —
 * `apps/web/e2e/`, `testing.md` rule 10 — but no spec in it would see a hung
 * worker today. maplibre creates and sizes `.maplibregl-canvas` without its
 * worker, so `composition.spec.ts`'s laid-out-canvas assertion stays green with
 * the worker request hanging; and the lane's hermetic basemap serves a style
 * with no sources and no layers, so no tile is ever handed to the worker to
 * parse. Seeing this failure in the lane would take a spec that asserts on
 * something drawn *from* tile data.
 */
setWorkerUrl(workerUrl);

/*
 * A position on the map, named in the domain's vocabulary rather than GL's.
 *
 * Declared by `clustering.ts` and re-exported here rather than restated: it is
 * one concept, and two structurally identical copies would be the same bug as
 * two schemas for one domain type — agreeing today, free to drift tomorrow.
 * `clustering.ts` owns it because that module is pure and this one is the
 * adapter; the re-export keeps `MapView`'s public surface complete for callers
 * who reach for the map's own vocabulary.
 */
export type { MapPosition };

export interface MapViewProps {
  readonly theme: Theme;
  /**
   * Fired for clicks on the basemap itself.
   *
   * Overlay clicks are excluded here rather than by each overlay: maplibre
   * mounts markers inside the very container this handler is bound to, so
   * without that filter a marker press would arrive as a map click too — see
   * `isMarkerClick`.
   */
  readonly onMapClick?: (position: MapPosition) => void;
  /** Overlays — markers, clusters — which reach the map through `MapContext`. */
  readonly children?: ReactNode;
}

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

    /*
     * Keep the canvas the size of its container, ourselves.
     *
     * maplibre already watches the container — and throws away the first thing
     * it sees. `Map._setupResizeObserver` guards its callback with
     * `if (!initialResizeEventCaptured) { initialResizeEventCaptured = true;
     * return; }`, reasoning that the delivery the spec fires on `observe()`
     * merely restates the size measured at construction. That holds only while
     * the container's size is settled by then. When the layout resolves a frame
     * later — a grid column that has not been distributed yet, a pane or window
     * that resizes just after load — the corrected size arrives *as* that first
     * delivery, is discarded, and nothing further is ever emitted. The canvas
     * then keeps a size the container has not had since first paint, and the
     * map paints into a corner of itself.
     *
     * Measured here, not theorised: the dashboard opened with a 400×183 canvas
     * inside an 816×469 container, and every marker crowded into the top-left
     * eighth of the map. A bare `instance.resize()` after construction does not
     * fix it — at that moment the container still measures 400×183, and the
     * growth that follows is exactly the delivery maplibre drops. Only an
     * observer of our own sees it.
     */
    const resizeObserver = new ResizeObserver(() => {
      instance.resize();
    });

    resizeObserver.observe(container);

    setMap(instance);

    return () => {
      // Observer first: a delivery arriving after `remove()` would resize a map
      // that no longer has a canvas to resize.
      resizeObserver.disconnect();
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
      // A marker press reaches this handler too — maplibre mounts markers inside
      // the container it binds to — and answering it here would open "add a site
      // here" on top of the site the visitor just selected.
      if (isMarkerClick(event.originalEvent.target)) {
        return;
      }

      onMapClickRef.current?.({ longitude: event.lngLat.lng, latitude: event.lngLat.lat });
    };

    map.on('click', handleClick);

    return () => {
      map.off('click', handleClick);
    };
  }, [map]);

  return (
    <MapSurface canvas={{ kind: 'map', containerRef }}>
      <MapContext value={map}>{children}</MapContext>
    </MapSurface>
  );
};
