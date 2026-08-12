import type { ErrorInfo, ReactElement, ReactNode } from 'react';
import { Component, lazy, Suspense } from 'react';

import { MapSurface } from '../map/MapSurface';
import type { MapRegionProps } from './MapRegion';
import { LOADING_MAP_LABEL, MAP_LOAD_FAILURE_MESSAGE } from './state-copy';

/*
 * The line the map engine starts at.
 *
 * Below this boundary sits maplibre: ~949 kB of minified WebGL renderer plus its
 * own stylesheet, none of which the first paint needs — the fleet chart and the
 * header's search are both reachable before a tile is drawn. (A selected site's
 * own card is *not*, since #265 anchored it to the site's marker; that is the
 * price of the card being on the map, and it is paid only by a `?site=` link
 * that arrives while the chunk is still in flight. Since the site table left the
 * page on 2026-08-12 the search is also the only way to *reach* a site while the
 * chunk is in flight, which raises the stakes on it being in the entry chunk —
 * it is, being ordinary React beside the dashboard rather than behind this
 * boundary.)
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
 *
 * One file rather than three because this is one concern: what the map region's
 * arrival does in each of its states — pending, arrived, and never arriving.
 */
const MapRegionImpl = lazy(async () => ({ default: (await import('./MapRegion')).MapRegion }));

/**
 * What stands in the map's place while its chunk is in flight.
 *
 * `MapSurface` is the shell rather than a hand-written copy of it, which settles
 * both of the things this state has to get right. It occupies the identical flex
 * column inside `.dashboard-map`'s fixed box, so the swap to the real map
 * shifts nothing on the page — the two are the same markup, not two spellings
 * agreeing today. And it carries `MapAttributionStrip` unconditionally: the
 * Open-Meteo credit is a licence obligation wherever weather-derived data
 * renders, and a fallback that dropped it would put the app out of compliance
 * for exactly as long as the network is slow. The shell depends only on
 * `@cumulo/ui`, so rendering it here costs the entry chunk nothing.
 *
 * Exported so it can be rendered on its own (`react.md` rule 4) — a source
 * contract can prove this markup is written, never that it renders.
 */
export const MapRegionFallback = (): ReactElement => (
  <MapSurface canvas={{ kind: 'placeholder', label: LOADING_MAP_LABEL }} />
);

/**
 * What stands in the map's place when its chunk is never going to arrive.
 *
 * Same shell, same credits, and an honest account of the state instead of a
 * perpetual "Loading map…" (`error-handling.md` rule 5). It offers a reload
 * rather than an in-page retry because `lazy` caches the rejected promise: once
 * this import has failed, every later render of `MapRegionImpl` re-throws the
 * same error, so a retry button would be a control that cannot work.
 */
const MapRegionFailure = (): ReactElement => (
  <MapSurface canvas={{ kind: 'failure', message: MAP_LOAD_FAILURE_MESSAGE }} />
);

/** What the boundary knows: whether the region below it has already thrown. */
interface MapRegionBoundaryState {
  readonly failed: boolean;
}

/**
 * Containment for a failed map chunk, and nothing wider.
 *
 * Without it a rejected `import()` throws during render with no boundary
 * anywhere above it, and React answers an uncaught render error by unmounting
 * the whole root: the fleet chart, the header's search, the theme toggle and the
 * attribution strip all disappear because one 949 kB fetch blipped. That is
 * reachable in production without any bug of ours — an `index.html` cached from
 * before a redeploy points at a hashed chunk that no longer exists, and every
 * visitor holding that HTML hits it.
 *
 * A class because React offers no hook form of an error boundary;
 * `structure.md` rule 3's arrow-constant rule and `architecture.md` rule 7's
 * functions-by-default both bend here for the one API that requires it, and for
 * nothing else in this file. It is deliberately local and deliberately small:
 * the app-wide question — one labelled boundary for every async surface in
 * `apps/web`, decided once — is the standing tech-debt entry "No error boundary
 * above the dashboard's async work", and this contains one seam rather than
 * answering it.
 *
 * `componentDidCatch` logs rather than swallows (`error-handling.md` rule 2c):
 * this is the boundary handler, so the error stops here, but it stops *visibly*
 * — a chunk failing for everyone should be findable in a console rather than
 * inferred from a screenshot.
 */
class MapRegionBoundary extends Component<
  { readonly children: ReactNode },
  MapRegionBoundaryState
> {
  override state: MapRegionBoundaryState = { failed: false };

  static getDerivedStateFromError(): MapRegionBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('The map region failed to load', {
      message: error.message,
      componentStack: info.componentStack,
    });
  }

  override render(): ReactNode {
    return this.state.failed ? <MapRegionFailure /> : this.props.children;
  }
}

/**
 * The dashboard's default map half: the real `MapRegion`, fetched on demand.
 *
 * Props pass straight through, so this is substitutable for `MapRegion` itself
 * — `MapRegionComponent` is satisfied by both, and the tests that pass their
 * own stand-in are unaffected.
 */
export const LazyMapRegion = (props: MapRegionProps): ReactElement => (
  <MapRegionBoundary>
    <Suspense fallback={<MapRegionFallback />}>
      <MapRegionImpl {...props} />
    </Suspense>
  </MapRegionBoundary>
);
