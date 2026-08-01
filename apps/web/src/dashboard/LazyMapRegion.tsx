import type { ReactElement } from 'react';
import { lazy, Suspense } from 'react';

import { MapAttributionStrip } from '../map/MapAttributionStrip';
import type { MapRegionProps } from './MapRegion';

/*
 * The line the map engine starts at.
 *
 * Below this boundary sits maplibre: ~936 kB of minified WebGL renderer plus
 * its own stylesheet, none of which the first paint needs — the fleet list, the
 * detail panel and the add-site form are all reachable before a tile is drawn.
 * Statically imported it was 75% of a 1,254 kB entry chunk that every visitor
 * downloaded before anything rendered; behind `import()` it is a chunk the
 * browser fetches while the rest of the dashboard is already interactive.
 *
 * The seam is `MapRegion` rather than anything deeper because it is already the
 * substitutable one (see `MapRegion.tsx`): the dashboard takes the map half as a
 * component, so making it lazy is a change of default, not a change of shape.
 * `MapView.tsx` is deliberately untouched — the worker wiring and the ratchet
 * over it in `map-worker-contract.test.ts` are load-bearing for whether the map
 * paints at all, and a code-splitting change has no business near them.
 *
 * Only the type crosses the boundary statically: `import type` is erased at
 * compile time, so it leaves no edge from the entry chunk to maplibre.
 * `map-region-split-contract.test.ts` is what keeps that true, because a static
 * import re-fusing the two is invisible to every other gate in CI.
 */
const MapRegionImpl = lazy(async () => ({ default: (await import('./MapRegion')).MapRegion }));

/**
 * What stands in the map's place while its chunk is in flight.
 *
 * Two things it must do, both structural rather than decorative. It reuses
 * `.map-view` and `.map-canvas`, so it occupies the identical flex column
 * inside `.dashboard-map`'s fixed 70vh box and the swap to the real map shifts
 * nothing on the page. And it carries `MapAttributionStrip`: the Open-Meteo
 * credit is a licence obligation wherever weather-derived data renders, and a
 * fallback that dropped it would put the app out of compliance for exactly as
 * long as the network is slow. The strip depends only on `@cumulo/ui`, so
 * rendering it here costs the entry chunk nothing.
 */
const MapRegionFallback = (): ReactElement => (
  <div className="map-view">
    <div className="map-canvas map-placeholder" role="status">
      Loading map…
    </div>
    <MapAttributionStrip />
  </div>
);

/**
 * The dashboard's default map half: the real `MapRegion`, fetched on demand.
 *
 * Props pass straight through, so this is substitutable for `MapRegion` itself
 * — `MapRegionComponent` is satisfied by both, and the tests that pass their
 * own stand-in are unaffected.
 */
export const LazyMapRegion = (props: MapRegionProps): ReactElement => (
  <Suspense fallback={<MapRegionFallback />}>
    <MapRegionImpl {...props} />
  </Suspense>
);
