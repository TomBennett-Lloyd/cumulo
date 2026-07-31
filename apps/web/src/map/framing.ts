/*
 * What the map opens on.
 *
 * These live outside `MapView` so that the tests which depend on the *shipped*
 * framing can read it rather than restate it. Clustering is the case that
 * matters: how many knots the fleet reads as is a function of the opening zoom
 * and the cluster radius together, so a clustering test that pinned its own
 * zoom would be proving a configuration nobody runs (`testing.md` rule 7).
 * `MapView` imports maplibre and cannot be loaded by a node-environment test at
 * all, which is the other half of why these are here.
 */

/** Centred between Ireland and Great Britain, the two islands the seed fleet sits on. */
export const INITIAL_CENTER: [number, number] = [-4.5, 54.6];

/**
 * The opening zoom: both islands on screen at once, at the window sizes this
 * dashboard is used at.
 *
 * Fractional on purpose — it is a camera position, not a clustering level.
 * Supercluster indexes one tree per integer zoom and floors what it is given,
 * so the knots the reader sees at 4.6 are level 4's; `clustering.test.ts` floors
 * this same constant rather than hard-coding a 4.
 */
export const INITIAL_ZOOM = 4.6;
