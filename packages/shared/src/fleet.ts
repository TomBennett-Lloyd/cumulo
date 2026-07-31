import type { Site } from './site';

/**
 * Deterministic synthetic fleet generation.
 *
 * The demo fleet must be identical everywhere it is materialized — API, web app, tests, docs —
 * so nothing here may touch ambient state: no platform randomness, no clock, no environment.
 * Every value derives from the caller's seed via an explicit PRNG, and the draw order below is
 * part of the contract: changing it changes the fleet.
 *
 * @see docs/design/fleet-simulation.md — the rationale behind every constant below.
 */

/** The seed that defines *the* Cumulo demo fleet. Changing it changes every documented figure. */
export const canonicalFleetSeed = 20260730;

interface FleetLocation {
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
}

/**
 * Cluster centres for the demo fleet — real population centres, each snapped to the centre of its
 * `locationId` bucket, i.e. exact at 2 decimal places (see `location.ts`).
 *
 * That snapping is half of a structural invariant: **every site in a cluster produces the same
 * `locationId`, so a whole cluster is one weather fetch.** The other half is `jitterDegrees`
 * below, whose half-width is strictly less than half a bucket — a site offset from a
 * bucket-centred point by less than 0.005° cannot round into a neighbouring bucket. Co-location
 * therefore holds by construction rather than by luck, which is what makes the fleet's 12-fetch
 * weather budget a property of the data instead of a hope about it.
 *
 * Before #78 the centres carried their real 4 dp coordinates and the jitter box was wider than a
 * bucket, so the canonical fleet spread across 58 buckets rather than 12 — the de-duplication
 * lever the design claimed did not exist. The API-frugality constraint is a design input, so the
 * generator now enforces it.
 */
const fleetLocations = [
  { name: 'Dublin', latitude: 53.35, longitude: -6.26 },
  { name: 'Cork', latitude: 51.9, longitude: -8.48 },
  { name: 'Galway', latitude: 53.27, longitude: -9.06 },
  { name: 'Limerick', latitude: 52.66, longitude: -8.63 },
  { name: 'Belfast', latitude: 54.6, longitude: -5.93 },
  { name: 'London', latitude: 51.51, longitude: -0.13 },
  { name: 'Manchester', latitude: 53.48, longitude: -2.24 },
  { name: 'Birmingham', latitude: 52.49, longitude: -1.89 },
  { name: 'Bristol', latitude: 51.45, longitude: -2.59 },
  { name: 'Leeds', latitude: 53.8, longitude: -1.55 },
  { name: 'Edinburgh', latitude: 55.95, longitude: -3.19 },
  { name: 'Cardiff', latitude: 51.48, longitude: -3.18 },
] as const satisfies readonly FleetLocation[];

const sitesPerLocation = 5;

/**
 * Half-width of the uniform offset applied to each site around its cluster centre, both axes.
 *
 * Bounded by the de-duplication bucket rather than by taste: `locationId` rounds to 2 decimal
 * places, so a site keeps its centre's bucket only while it stays within half a bucket — 0.005° —
 * of that centre. 0.004° leaves margin for the 5 dp coordinate rounding below (up to 0.000005°)
 * and for float representation. Widening it past 0.005 would silently multiply the fleet's
 * Open-Meteo call volume; `fleet.test.ts` fails if it does.
 *
 * The two axes share one half-width for the same reason: the constraint is expressed in degrees
 * of the bucket grid, which is square, not in kilometres on the ground.
 */
const jitterDegrees = 0.004;

/**
 * Coordinates are recorded to 5 decimal places — about a metre, far finer than the jitter box and
 * still distinct per site, without claiming survey accuracy a synthetic site cannot have.
 */
const coordinateDecimals = 5;

/** A triangular distribution: `mode` is the peak, `min`/`max` the support. */
interface TriangularRange {
  readonly min: number;
  readonly mode: number;
  readonly max: number;
}

/** Nameplate DC kilowatts — typical Irish/UK domestic arrays cluster around 4 kW. */
const capacityKwRange = { min: 2, mode: 4, max: 10 } as const satisfies TriangularRange;
/** Degrees from horizontal — most pitched roofs sit near 35°. */
const tiltDegreesRange = { min: 20, mode: 35, max: 50 } as const satisfies TriangularRange;
/** Degrees clockwise from true north — 180 is due south, the ideal in the northern hemisphere. */
const azimuthDegreesRange = { min: 90, mode: 180, max: 270 } as const satisfies TriangularRange;

/**
 * mulberry32 — a 32-bit PRNG chosen for being tiny, dependency-free and byte-identical across
 * JS engines, so a seed means the same fleet in Node, the browser and CI.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Inverse-CDF sample from a triangular distribution, consuming exactly one uniform draw so the
 * draw sequence stays predictable.
 */
function sampleTriangular(rng: () => number, range: TriangularRange): number {
  const { min, mode, max } = range;
  const u = rng();
  const modeFraction = (mode - min) / (max - min);
  return u < modeFraction
    ? min + Math.sqrt(u * (max - min) * (mode - min))
    : max - Math.sqrt((1 - u) * (max - min) * (max - mode));
}

/** Uniform offset in `[-halfWidth, +halfWidth]`, one draw. */
function sampleJitter(rng: () => number, halfWidth: number): number {
  return (rng() * 2 - 1) * halfWidth;
}

const uuidByteCount = 16;
/** Byte indices that a canonical 8-4-4-4-12 UUID string prefixes with a dash. */
const uuidDashByteIndices = new Set([4, 6, 8, 10]);
const uuidVersionByteIndex = 6;
const uuidVariantByteIndex = 8;

/**
 * A seeded stand-in for the platform UUID generator: same RFC 4122 v4 shape (so `siteSchema`
 * accepts it), but reproducible. The hex string is built in one pass rather than via an
 * intermediate byte array, which keeps every access checked.
 */
function nextUuidV4(rng: () => number): string {
  let uuid = '';
  for (let index = 0; index < uuidByteCount; index += 1) {
    let byte = Math.floor(rng() * 256);
    if (index === uuidVersionByteIndex) {
      byte = (byte & 0x0f) | 0x40;
    } else if (index === uuidVariantByteIndex) {
      byte = (byte & 0x3f) | 0x80;
    }
    if (uuidDashByteIndices.has(index)) {
      uuid += '-';
    }
    uuid += byte.toString(16).padStart(2, '0');
  }
  return uuid;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Build the demo fleet for `seed`: 5 sites around each of the 12 cluster centres, 60 in total.
 *
 * Pure and deterministic — equal seeds always yield deeply equal fleets.
 */
export function generateFleet(seed: number): readonly Site[] {
  const rng = mulberry32(seed);
  const sites: Site[] = [];

  for (const location of fleetLocations) {
    for (let index = 0; index < sitesPerLocation; index += 1) {
      // Draw order is the contract — id bytes, latitude, longitude, tilt, azimuth, capacity.
      const id = nextUuidV4(rng);
      const latitude = roundTo(
        location.latitude + sampleJitter(rng, jitterDegrees),
        coordinateDecimals,
      );
      const longitude = roundTo(
        location.longitude + sampleJitter(rng, jitterDegrees),
        coordinateDecimals,
      );
      const tiltDegrees = Math.round(sampleTriangular(rng, tiltDegreesRange));
      const azimuthDegrees = Math.round(sampleTriangular(rng, azimuthDegreesRange));
      const capacityKw = roundTo(sampleTriangular(rng, capacityKwRange), 1);

      sites.push({
        id,
        name: `${location.name} rooftop ${String(index + 1)}`,
        latitude,
        longitude,
        tiltDegrees,
        azimuthDegrees,
        capacityKw,
      });
    }
  }

  return sites;
}
