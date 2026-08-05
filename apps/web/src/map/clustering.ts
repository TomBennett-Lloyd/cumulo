import type { Site } from '@cumulo/shared';
import Supercluster from 'supercluster';

/*
 * What the map draws at a given viewport: sixty sites resolved into markers and
 * cluster bubbles.
 *
 * This module is pure (architecture.md rule 3) and imports no maplibre: it maps
 * a fleet plus a viewport onto a list of things to paint, and nothing here
 * touches the DOM, a clock or the network. That is deliberate — clustering is
 * the one part of the map with real decisions in it, and it is exactly the part
 * WebGL would otherwise make untestable.
 *
 * Clustering itself is supercluster: a KD-tree per zoom level, which is the
 * same algorithm maplibre's own GeoJSON source uses, without giving up the DOM
 * markers the treatment needs (a marker has to be a real focusable `<button>`,
 * and a symbol layer painted into the WebGL canvas can never be one).
 */

/** Coarse cluster sizes. The count label is the precise channel — see below. */
export type ClusterSizeBand = 'small' | 'medium' | 'large';

/** A position on the map, in the domain's vocabulary rather than GL's. */
export interface MapPosition {
  readonly longitude: number;
  readonly latitude: number;
}

/**
 * One thing to paint on the map.
 *
 * A discriminated union rather than a marker with optional cluster fields
 * (typing.md rule 4): a cluster has no site and a site has no count, and
 * neither renderer should have to ask.
 */
export type MapPoint =
  | { readonly kind: 'site'; readonly site: Site; readonly selected: boolean }
  | {
      readonly kind: 'cluster';
      readonly clusterId: number;
      readonly position: MapPosition;
      readonly count: number;
      readonly sizeBand: ClusterSizeBand;
      readonly containsSelected: boolean;
      /** The zoom at which this cluster breaks apart — where clicking it flies. */
      readonly expansionZoom: number;
    };

/** What the map is currently showing: `bounds` is `[west, south, east, north]`. */
export interface MapViewport {
  readonly zoom: number;
  readonly bounds: readonly [number, number, number, number];
}

/**
 * What we hang off each clustered point: the site itself, and its position in
 * the fleet list.
 *
 * `order` is what makes focus order deterministic. Supercluster returns
 * features in tree order, which changes as the reader pans; markers ordered
 * that way would reshuffle the tab sequence under a reader who only moved the
 * map. Carrying the fleet index through the index and sorting on it at the end
 * gives the treatment's "focusable in the site's own order" for free, and a
 * cluster inherits the smallest order among its members.
 *
 */
interface SitePointProperties {
  readonly site: Site;
  readonly order: number;
}

/** We add nothing to supercluster's own cluster properties. */
type ClusterAccumulator = Record<never, never>;

/** A loaded, immutable clustering of one fleet. Build it once per site list. */
export type ClusterIndex = Supercluster<SitePointProperties, ClusterAccumulator>;

/** Either a cluster bubble or one of our own site points, as supercluster hands it back. */
type ViewportFeature = ReturnType<ClusterIndex['getClusters']>[number];

/** A point plus the fleet position it sorts by; the order is dropped on the way out. */
interface OrderedMapPoint {
  readonly order: number;
  readonly point: MapPoint;
}

/*
 * Cluster radius, in pixels, at supercluster's default 512-unit extent — which
 * is maplibre's tile size, so a supercluster zoom is a maplibre zoom with no
 * conversion.
 *
 * 12px is an empirical number, and the honest justification is the test rather
 * than a token: it is the radius at which the fleet's twelve seeded centres
 * still read as twelve knots at the zoom the map opens on
 * (`framing.ts`'s `INITIAL_CAMERA.zoom`, floored to level 4). The pair that decides it
 * is Bristol and Cardiff, about 40km apart — at supercluster's default 40px
 * they stay merged until zoom 6, and at 24px until zoom 5, either of which
 * shows a reader ten knots on a map `map-treatment.md` promises has twelve.
 *
 * An earlier version of this comment argued 24px from `--space-6`, the marker
 * hit target: two knots closer together than one bubble cannot read as two
 * things. That reasoning is appealing and was wrong in the direction that
 * matters — it fixed the radius to a rendered length while the thing being
 * promised is a *count* at a *specific zoom*, and the two only coincide by
 * luck. Cluster bubbles can therefore overlap slightly at some zooms, which is
 * the accepted cost of the count being right on the frame every visitor sees
 * first. `clustering.test.ts` reads both shipped constants, so a change to
 * either that breaks the twelve fails there.
 */
const CLUSTER_RADIUS_PIXELS = 12;

/** Bands step rather than scale — people compare circle areas badly. */
const MEDIUM_BAND_MIN_COUNT = 10;
const LARGE_BAND_MIN_COUNT = 30;

/**
 * The size band for a cluster of `count` sites: small below 10, medium to 29,
 * large from 30.
 *
 * Three sizes, not a continuous ramp. The number inside the bubble is the
 * precise channel; the diameter is only a coarse "more than that one".
 */
export const clusterSizeBand = (count: number): ClusterSizeBand => {
  if (count >= LARGE_BAND_MIN_COUNT) {
    return 'large';
  }

  if (count >= MEDIUM_BAND_MIN_COUNT) {
    return 'medium';
  }

  return 'small';
};

/**
 * A GeoJSON position is a bare `number[]`, so a longitude/latitude pair has to
 * be proven rather than assumed under `noUncheckedIndexedAccess`.
 *
 * A point with fewer than two coordinates is not an expected failure this map
 * could render around — it would mean the index we just built is corrupt — so
 * it throws (error-handling.md rule 1) instead of returning a value.
 */
const positionOf = (coordinates: readonly number[]): MapPosition => {
  const [longitude, latitude] = coordinates;

  if (longitude === undefined || latitude === undefined) {
    throw new Error(
      `Clustered point has ${String(coordinates.length)} coordinates, expected longitude and latitude.`,
    );
  }

  return { longitude, latitude };
};

/**
 * Turn one supercluster feature into the point the map paints.
 *
 * The leaves lookup is what keeps selection visible when the selected site
 * collapses into a cluster — the treatment's "selection must never disappear
 * inside a collapsed cluster". It costs one tree walk per cluster per viewport
 * change; at fleet scale (twelve clusters of five) that is nothing, and the
 * alternative — caching leaves per cluster id — would buy microseconds at the
 * price of a cache to invalidate.
 */
const toOrderedPoint = (
  index: ClusterIndex,
  feature: ViewportFeature,
  selectedSiteId: Site['id'] | null,
): OrderedMapPoint => {
  if (!('cluster' in feature.properties)) {
    const { site, order } = feature.properties;

    return { order, point: { kind: 'site', site, selected: site.id === selectedSiteId } };
  }

  const clusterId = feature.properties.cluster_id;
  const count = feature.properties.point_count;
  const leaves = index.getLeaves(clusterId, Infinity);
  const orders = leaves.map((leaf) => leaf.properties.order);

  return {
    order: Math.min(...orders),
    point: {
      kind: 'cluster',
      clusterId,
      position: positionOf(feature.geometry.coordinates),
      count,
      sizeBand: clusterSizeBand(count),
      containsSelected:
        selectedSiteId !== null &&
        leaves.some((leaf) => leaf.properties.site.id === selectedSiteId),
      expansionZoom: index.getClusterExpansionZoom(clusterId),
    },
  };
};

/**
 * Index a fleet for clustering. Immutable once built, so rebuild it when the
 * site list changes rather than mutating it.
 */
export const buildClusterIndex = (sites: readonly Site[]): ClusterIndex =>
  new Supercluster<SitePointProperties, ClusterAccumulator>({
    radius: CLUSTER_RADIUS_PIXELS,
  }).load(
    sites.map((site, order) => ({
      type: 'Feature',
      properties: { site, order },
      geometry: { type: 'Point', coordinates: [site.longitude, site.latitude] },
    })),
  );

/**
 * What to paint for a viewport: individual sites where they separate, cluster
 * bubbles where they do not, in fleet order.
 *
 * Note what is *not* here: nothing depends on how many points came back, on
 * their draw order, or on which sites were filtered out. A site is `selected`
 * because its id is the selected one; a cluster is `containsSelected` because
 * it holds that site. Filtering the fleet therefore cannot repaint a survivor
 * (map-treatment.md, "identity never depends on position in a list").
 */
export const pointsForViewport = (
  index: ClusterIndex,
  viewport: MapViewport,
  selectedSiteId: Site['id'] | null,
): readonly MapPoint[] =>
  index
    .getClusters([...viewport.bounds], viewport.zoom)
    .map((feature) => toOrderedPoint(index, feature, selectedSiteId))
    .toSorted((left, right) => left.order - right.order)
    .map((ordered) => ordered.point);
