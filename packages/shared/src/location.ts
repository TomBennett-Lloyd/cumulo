/**
 * Number of decimal places a coordinate keeps in a location id. Two places is
 * ~1.1 km at the equator — close enough that co-located rooftops share one
 * weather fetch, fine enough that genuinely different towns do not.
 */
const DECIMAL_PLACES = 2;

const POSITIVE_ZERO = (0).toFixed(DECIMAL_PLACES);
// Built by hand rather than as `(-0).toFixed(2)`, which is `"0.00"`: negative
// zero the *number* formats without its sign, while a small negative magnitude
// like -0.001 does not. The latter is the case this constant has to match.
const NEGATIVE_ZERO = `-${POSITIVE_ZERO}`;
const ANTIMERIDIAN_EAST = (180).toFixed(DECIMAL_PLACES);
const ANTIMERIDIAN_WEST = (-180).toFixed(DECIMAL_PLACES);

/**
 * Rounds one axis to the bucket width and removes the two spellings of zero
 * that IEEE-754 leaves behind: `(-0.001).toFixed(2)` is `"-0.00"`, which is a
 * different partition key from `"0.00"` for the same point on the planet.
 */
function roundAxis(value: number): string {
  const formatted = value.toFixed(DECIMAL_PLACES);
  return formatted === NEGATIVE_ZERO ? POSITIVE_ZERO : formatted;
}

/**
 * The de-duplication identity of a geographic location: `"<lat>,<lon>"` with
 * both axes rounded to two decimal places, e.g. `"53.35,-6.26"`.
 *
 * This one function is simultaneously the `cumulo-weather` partition key and
 * ingestion (#11)'s weather de-duplication key (ADR 0002, "Key design" §3).
 * Those are deliberately the same call rather than two implementations of the
 * same rule, because a drift between them would silently double the fetch
 * volume against a quota this project is built to respect — or, worse, write
 * readings into a partition nothing reads back.
 *
 * Canonicalization, in the order it has to happen:
 * - 180°E and 180°W are one meridian, so `longitude === 180` collapses to
 *   `-180` **before** rounding;
 * - each axis is rounded with `toFixed(2)`, which fixes the width so
 *   lexicographic order stays meaningful and the id is a stable string;
 * - `"-0.00"` becomes `"0.00"` on both axes, and a longitude that _rounds up
 *   onto_ the antimeridian (179.996 → `"180.00"`) becomes `"-180.00"`, so the
 *   collapse holds for coordinates near it as well as exactly on it.
 *
 * The parameter is an object, not two positional numbers, because latitude and
 * longitude are same-shaped numbers that structural typing would let a caller
 * swap in silence. This is the interim swap guard only; branded coordinate
 * types are #50.
 */
export function locationId(coords: { latitude: number; longitude: number }): string {
  // 180°E and 180°W name one meridian. Stated twice on purpose: once here on the
  // number, where the domain rule lives, and once below on the rounded string,
  // which is what catches coordinates that only *round* onto the antimeridian.
  // The second subsumes the first behaviourally — no input distinguishes them,
  // and no test can — so the first is kept as the statement of the invariant,
  // not as a reachable branch a mutation would expose.
  const longitude = coords.longitude === 180 ? -180 : coords.longitude;
  const roundedLongitude = roundAxis(longitude);
  const canonicalLongitude =
    roundedLongitude === ANTIMERIDIAN_EAST ? ANTIMERIDIAN_WEST : roundedLongitude;

  return `${roundAxis(coords.latitude)},${canonicalLongitude}`;
}
