/*
 * What the map opens on.
 *
 * This lives outside `MapView` so that the tests which depend on the *shipped*
 * framing can read it rather than restate it. Clustering is the case that
 * matters: how many knots the fleet reads as is a function of the opening zoom
 * and the cluster radius together, so a clustering test that pinned its own
 * zoom would be proving a configuration nobody runs (`testing.md` rule 7).
 * `MapView` imports maplibre and cannot be loaded by a node-environment test at
 * all, which is the other half of why this is here — and why the camera is
 * described by the type below rather than by maplibre's `CameraOptions`, which
 * would drag the whole engine into every test that reads the opening zoom.
 *
 * ## One object, not four constants
 *
 * The opening camera has exactly one owner and every consumer takes the whole
 * of it (`architecture.md` rule 9). That is a correctness property rather than
 * tidiness. While `center` and `zoom` were the only named constants, both the
 * map's construction and its reset spelled out those two and said nothing about
 * bearing or pitch — so both silently inherited maplibre's defaults, and the two
 * statements of "the opening camera" agreed only by accident. They stopped
 * agreeing the moment a reader used a gesture that moves the axes nobody named:
 * `dragRotate` and `pitchWithRotate` are on by default, so a right-drag left the
 * map rotated and "Reset map view" restored the two axes it knew about and left
 * the rotation exactly where it was (#265 review cycle 1 measured the reset
 * moving markers 0.1px against a 91.5px rotation).
 *
 * Spreading one object is what makes that unrepresentable: a camera axis added
 * here reaches construction and reset together, or fails to compile in both.
 */

/**
 * Every reader-reachable axis of the map's camera, named here so that "the
 * opening camera" is one value rather than a list a caller can partially copy.
 * maplibre 6.1 also has `roll` (and `elevation`) behind options this app leaves
 * disabled — whoever enables `rollEnabled` must add the axis HERE, or the reset
 * inherits exactly the partial-restore bug this object exists to prevent.
 *
 * Structural rather than imported from maplibre on purpose — see the header. It
 * is assignable to both `MapOptions` at construction and `CameraOptions` at
 * `easeTo`, which is the whole requirement.
 */
export interface MapCamera {
  /** Centred between Ireland and Great Britain, the two islands the seed fleet sits on. */
  readonly center: [number, number];
  /**
   * The opening zoom: both islands on screen at once, at the window sizes this
   * dashboard is used at.
   *
   * Fractional on purpose — it is a camera position, not a clustering level.
   * Supercluster indexes one tree per integer zoom and floors what it is given,
   * so the knots the reader sees at 4.6 are level 4's; `clustering.test.ts`
   * floors this same value rather than hard-coding a 4.
   */
  readonly zoom: number;
  /** Degrees of rotation. North up: the fleet is read against a map reader's default. */
  readonly bearing: number;
  /** Degrees of tilt. Flat: a pitched basemap earns nothing for markers drawn as flat circles. */
  readonly pitch: number;
}

export const INITIAL_CAMERA: MapCamera = {
  center: [-4.5, 54.6],
  zoom: 4.6,
  bearing: 0,
  pitch: 0,
};
