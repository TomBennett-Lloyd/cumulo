import type { ReactElement, ReactNode, Ref } from 'react';

import { MapAttributionStrip } from './MapAttributionStrip';

/*
 * The map's shell, written once.
 *
 * Before this module there were four copies of `<div className="map-view">` —
 * the real map, the loading placeholder, the load failure, and a test stand-in —
 * each restating the same shell and each free to drop the credit or spell the
 * pending state differently. They did both: the placeholder announced itself
 * with `role="status"` while nothing else did, and the fourth copy carried no
 * canvas at all.
 *
 * `MapSurface` imports nothing from maplibre and nothing from `MapRegion`, so it
 * costs the entry chunk only itself and the attribution strip. That is load
 * bearing rather than incidental: `dashboard/LazyMapRegion.tsx` renders this
 * shell on the *pending* path, and a value edge from here into the map engine
 * would fuse the 949 kB chunk back into the entry bundle
 * (`dashboard/map-region-split-contract.test.ts` is the ratchet).
 */

/**
 * What fills the map's box: the live canvas, or a message standing in its place.
 *
 * A discriminated union rather than three optional props (`typing.md` rule 4) —
 * the three are mutually exclusive by construction, and a `containerRef` beside
 * a failure message would be a state no caller can mean.
 */
export type MapCanvasSlot =
  | { readonly kind: 'map'; readonly containerRef: Ref<HTMLDivElement> }
  | { readonly kind: 'placeholder'; readonly label: string }
  | { readonly kind: 'failure'; readonly message: string };

export interface MapSurfaceProps {
  readonly canvas: MapCanvasSlot;
  /** Overlays — markers, clusters — drawn between the canvas and the strip. */
  readonly children?: ReactNode;
}

/**
 * The element that occupies the map's box for a given slot.
 *
 * All three wear `.map-canvas`, so they inherit the same sizing inside
 * `.dashboard-map`'s fixed box and swapping one for another shifts nothing on
 * the page.
 *
 * The roles follow `react.md`'s async surface convention, and the placeholder is
 * the case worth reading slowly: `aria-busy="true"` with a visible label and
 * deliberately **no** `role="status"`. A live region that is mounted with its
 * text already inside it has no change to report, so it announces nothing and
 * merely looks accessible (the #161 finding). The failure is `role="alert"`
 * because it genuinely mounts into a tree that is already on screen — the reader
 * was looking at the pending shell a moment ago — so its text does arrive as a
 * change.
 */
const mapCanvasElement = (canvas: MapCanvasSlot): ReactElement => {
  switch (canvas.kind) {
    case 'map':
      return <div className="map-canvas" ref={canvas.containerRef} />;
    case 'placeholder':
      return (
        <div className="map-canvas map-placeholder" aria-busy="true">
          {canvas.label}
        </div>
      );
    case 'failure':
      return (
        <div className="map-canvas map-failure" role="alert">
          {canvas.message}
        </div>
      );
  }
};

/**
 * The map's box: a canvas, whatever is drawn over it, and the credits over
 * its bottom edge.
 *
 * `MapAttributionStrip` is unconditional and has no prop that could remove it.
 * The Open-Meteo credit is a licence obligation wherever weather-derived data
 * renders (CC BY 4.0, a CLAUDE.md hard constraint), and it is owed while the map
 * is loading and while it has failed exactly as much as while it is drawing
 * tiles. Concentrating the shell here makes that structural: there is one place
 * the credit could be dropped from instead of four, and dropping it there fails
 * every shell's tests at once.
 *
 * Presentational and total — props in, one element out (`react.md` rule 4).
 */
export const MapSurface = ({ canvas, children }: MapSurfaceProps): ReactElement => (
  <div className="map-view">
    {mapCanvasElement(canvas)}
    {children}
    <MapAttributionStrip />
  </div>
);
