import type { Site } from '@cumulo/shared';
import { canonicalFleetSeed, generateFleet } from '@cumulo/shared';
import { describe, expect, it } from 'vitest';
import type { MapPoint, MapViewport } from './clustering';
import { buildClusterIndex, clusterSizeBand, pointsForViewport } from './clustering';
import { INITIAL_ZOOM } from './framing';

const fleet = generateFleet(canonicalFleetSeed);

/**
 * The clustering level the map actually opens on.
 *
 * Read off the shipped constant rather than written as a number: the twelve
 * knots below are a promise about what a visitor sees on first paint, so a test
 * that pinned its own zoom could stay green while the map opened on a zoom that
 * shows something else entirely (`testing.md` rule 7). Floored because
 * supercluster indexes one tree per integer zoom.
 */
const OPENING_ZOOM = Math.floor(INITIAL_ZOOM);

/**
 * Ireland and the UK on screen together — the framing `MapView` opens on, and
 * the one `map-treatment.md` describes as "twelve knots of five".
 *
 * The bounds are wider than any real window at this zoom, deliberately: what
 * this fixture is for is the zoom-and-radius pair that decides how the fleet
 * collapses, and bounds only decide what is cropped out of view. The real
 * viewport at this zoom was measured in a browser at roughly
 * [-16.3, 50.5, 7.3, 58.4] — inside these bounds, with the whole fleet in frame.
 */
const ISLANDS: MapViewport = { zoom: OPENING_ZOOM, bounds: [-20, 48, 10, 60] };

/**
 * Zoomed onto the Dublin cluster centre, close enough for its five to separate.
 *
 * The zoom tracks the fleet's jitter, not taste. #78 tightened that jitter to
 * ±0.004° so every site in a cluster shares one weather bucket, which put the
 * five Dublin roofs inside a box roughly a seventh the width of the old one —
 * and a zoom that separated them before now shows a cluster. If a future change
 * to `jitterDegrees` breaks these tests, this constant is what follows it.
 */
const DUBLIN: MapViewport = { zoom: 15, bounds: [-6.28, 53.34, -6.24, 53.36] };

/** The first five sites the generator emits are Dublin's; see `fleet.ts`. */
const dublinSites = fleet.slice(0, 5);
const corkSites = fleet.slice(5, 10);

const siteId = (site: Site | undefined): Site['id'] => {
  if (site === undefined) {
    throw new Error('The canonical fleet is missing a site the test names.');
  }

  return site.id;
};

/**
 * What a reader sees of a cluster, with the two identifiers that are allowed to
 * change stripped out.
 *
 * `clusterId` and `expansionZoom` are properties of the index that produced the
 * cluster, not of the cluster's appearance: rebuild the index over a different
 * fleet and supercluster numbers its trees differently. Comparing what is left
 * is what makes the "never repaints the survivors" test about repainting.
 */
const appearanceOf = (point: MapPoint): unknown =>
  point.kind === 'site'
    ? { kind: point.kind, name: point.site.name, selected: point.selected }
    : {
        kind: point.kind,
        count: point.count,
        sizeBand: point.sizeBand,
        containsSelected: point.containsSelected,
        position: point.position,
      };

describe('clusterSizeBand', () => {
  it('steps from small to medium at ten sites, and to large at thirty', () => {
    expect(clusterSizeBand(9)).toBe('small');
    expect(clusterSizeBand(10)).toBe('medium');
    expect(clusterSizeBand(29)).toBe('medium');
    expect(clusterSizeBand(30)).toBe('large');
  });
});

describe('pointsForViewport', () => {
  it('collapses the sixty-site fleet into twelve clusters of five on the opening frame', () => {
    const points = pointsForViewport(buildClusterIndex(fleet), ISLANDS, null);

    expect(points).toHaveLength(12);
    expect(points.map((point) => point.kind === 'cluster' && point.count)).toEqual(
      Array.from({ length: 12 }, () => 5),
    );
  });

  it('gives every cluster of five the small size band', () => {
    const points = pointsForViewport(buildClusterIndex(fleet), ISLANDS, null);

    expect(points.every((point) => point.kind === 'cluster' && point.sizeBand === 'small')).toBe(
      true,
    );
  });

  it('resolves a cluster into its own five sites once zoomed onto its centre', () => {
    const points = pointsForViewport(buildClusterIndex(fleet), DUBLIN, null);

    expect(points.map((point) => (point.kind === 'site' ? point.site.name : 'cluster'))).toEqual([
      'Dublin rooftop 1',
      'Dublin rooftop 2',
      'Dublin rooftop 3',
      'Dublin rooftop 4',
      'Dublin rooftop 5',
    ]);
  });

  it('marks the selected site itself, and no other, when the sites are separate', () => {
    const selected = siteId(dublinSites[2]);
    const points = pointsForViewport(buildClusterIndex(fleet), DUBLIN, selected);
    const selectedNames = points
      .filter((point) => point.kind === 'site' && point.selected)
      .map((point) => (point.kind === 'site' ? point.site.name : ''));

    expect(selectedNames).toEqual(['Dublin rooftop 3']);
  });

  it('marks only the cluster that holds the selected site, so selection survives collapsing', () => {
    const selected = siteId(dublinSites[2]);
    const points = pointsForViewport(buildClusterIndex(fleet), ISLANDS, selected);
    const marked = points.filter((point) => point.kind === 'cluster' && point.containsSelected);

    expect(marked).toHaveLength(1);
    // Dublin is the first cluster centre, so its cluster sorts first.
    expect(marked[0]).toBe(points[0]);
  });

  it('marks no cluster when nothing is selected', () => {
    const points = pointsForViewport(buildClusterIndex(fleet), ISLANDS, null);

    expect(points.some((point) => point.kind === 'cluster' && point.containsSelected)).toBe(false);
  });

  it('offers each cluster a zoom at which it expands, beyond the one being viewed', () => {
    const points = pointsForViewport(buildClusterIndex(fleet), ISLANDS, null);

    expect(
      points.every((point) => point.kind === 'cluster' && point.expansionZoom > ISLANDS.zoom),
    ).toBe(true);
  });

  it('keeps markers in fleet order once the fleet outgrows the index leaf size', () => {
    // Two seeded fleets, 120 sites: past 64 points supercluster's KD-tree stops
    // being a single leaf and starts handing its contents back in tree order,
    // which has nothing to do with the fleet list. Below that size every order
    // agrees and this guarantee cannot be observed at all.
    const doubleFleet = [...fleet, ...generateFleet(canonicalFleetSeed + 1)];
    const [west, south, east, north] = DUBLIN.bounds;
    const inView = doubleFleet.filter(
      (site) =>
        site.longitude >= west &&
        site.longitude <= east &&
        site.latitude >= south &&
        site.latitude <= north,
    );
    const points = pointsForViewport(buildClusterIndex(doubleFleet), DUBLIN, null);

    expect(inView.length).toBeGreaterThan(5);
    expect(points.map((point) => (point.kind === 'site' ? point.site.id : 'cluster'))).toEqual(
      inView.map((site) => site.id),
    );
  });

  it('keeps clusters in fleet order, so panning cannot reshuffle the focus sequence', () => {
    const points = pointsForViewport(buildClusterIndex(fleet), ISLANDS, null);
    const wholeMap: MapViewport = { zoom: OPENING_ZOOM, bounds: [-180, -85, 180, 85] };
    const panned = pointsForViewport(buildClusterIndex(fleet), wholeMap, null);

    expect(panned.map(appearanceOf)).toEqual(points.map(appearanceOf));
  });

  it('leaves surviving clusters untouched when a whole cluster is removed from the fleet', () => {
    const selected = siteId(dublinSites[0]);
    const whole = pointsForViewport(buildClusterIndex(fleet), ISLANDS, selected);
    const withoutCork = fleet.filter((site) => !corkSites.includes(site));
    const reduced = pointsForViewport(buildClusterIndex(withoutCork), ISLANDS, selected);

    // Cork is the second cluster centre, so its cluster is the second point.
    const survivors = whole.filter((_point, index) => index !== 1);

    expect(reduced.map(appearanceOf)).toEqual(survivors.map(appearanceOf));
  });

  it('leaves surviving site markers untouched when their neighbours are removed', () => {
    const selected = siteId(dublinSites[4]);
    const whole = pointsForViewport(buildClusterIndex(fleet), DUBLIN, selected);
    const thinned = fleet.filter((site) => site !== dublinSites[0] && site !== dublinSites[2]);
    const reduced = pointsForViewport(buildClusterIndex(thinned), DUBLIN, selected);
    const survivors = whole.filter((_point, index) => index !== 0 && index !== 2);

    expect(reduced.map(appearanceOf)).toEqual(survivors.map(appearanceOf));
  });
});
