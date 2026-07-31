/**
 * NREL Solar Position Algorithm (SPA) — apparent solar zenith and azimuth for an
 * observer at an instant.
 *
 * Hand-ported to TypeScript per ADR 0003: the physics runs in one language, and pvlib
 * stays the correctness authority offline, through committed golden fixtures.
 *
 * Algorithm: I. Reda and A. Andreas, "Solar position algorithm for solar radiation
 * applications", NREL/TP-560-34302; Solar Energy 76(5), 577–589 (2004), with the 2007
 * corrigendum. The periodic-term tables (L0–L5, B0–B1, R0–R4), the 63-row nutation
 * table, and the order of the steps below are transcribed from pvlib-python v0.15.2,
 * `pvlib/spa.py` (BSD-3-Clause), so that this port and the fixture generator are the
 * same algorithm rather than two readings of the same paper.
 *
 * Defaults match pvlib's `solarposition.spa_python`: sea level, 101325 Pa, 12 °C,
 * ΔT = 67.0 s.
 *
 * Angles are degrees unless a name says otherwise. Azimuth is measured clockwise from
 * true north in [0, 360), the same convention as `siteSchema.azimuthDegrees`.
 */

/** One row of a periodic-term table: the paper's `A`, `B`, `C` for that term. */
type PeriodicTerm = readonly [number, number, number];

/**
 * One row of the nutation table: pvlib's `NUTATION_ABCD_ARRAY` row (`a`, `b`, `c`, `d`)
 * followed by the matching `NUTATION_YTERM_ARRAY` row (`Y0`…`Y4`). pvlib keeps the two
 * as parallel arrays and pairs them by index; merging them row-wise preserves every
 * value and its order while letting a row be destructured without an index lookup.
 */
type NutationTerm = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

const L0: readonly PeriodicTerm[] = [
  [175347046.0, 0.0, 0.0],
  [3341656.0, 4.6692568, 6283.07585],
  [34894.0, 4.6261, 12566.1517],
  [3497.0, 2.7441, 5753.3849],
  [3418.0, 2.8289, 3.5231],
  [3136.0, 3.6277, 77713.7715],
  [2676.0, 4.4181, 7860.4194],
  [2343.0, 6.1352, 3930.2097],
  [1324.0, 0.7425, 11506.7698],
  [1273.0, 2.0371, 529.691],
  [1199.0, 1.1096, 1577.3435],
  [990.0, 5.233, 5884.927],
  [902.0, 2.045, 26.298],
  [857.0, 3.508, 398.149],
  [780.0, 1.179, 5223.694],
  [753.0, 2.533, 5507.553],
  [505.0, 4.583, 18849.228],
  [492.0, 4.205, 775.523],
  [357.0, 2.92, 0.067],
  [317.0, 5.849, 11790.629],
  [284.0, 1.899, 796.298],
  [271.0, 0.315, 10977.079],
  [243.0, 0.345, 5486.778],
  [206.0, 4.806, 2544.314],
  [205.0, 1.869, 5573.143],
  [202.0, 2.458, 6069.777],
  [156.0, 0.833, 213.299],
  [132.0, 3.411, 2942.463],
  [126.0, 1.083, 20.775],
  [115.0, 0.645, 0.98],
  [103.0, 0.636, 4694.003],
  [102.0, 0.976, 15720.839],
  [102.0, 4.267, 7.114],
  [99.0, 6.21, 2146.17],
  [98.0, 0.68, 155.42],
  [86.0, 5.98, 161000.69],
  [85.0, 1.3, 6275.96],
  [85.0, 3.67, 71430.7],
  [80.0, 1.81, 17260.15],
  [79.0, 3.04, 12036.46],
  [75.0, 1.76, 5088.63],
  [74.0, 3.5, 3154.69],
  [74.0, 4.68, 801.82],
  [70.0, 0.83, 9437.76],
  [62.0, 3.98, 8827.39],
  [61.0, 1.82, 7084.9],
  [57.0, 2.78, 6286.6],
  [56.0, 4.39, 14143.5],
  [56.0, 3.47, 6279.55],
  [52.0, 0.19, 12139.55],
  [52.0, 1.33, 1748.02],
  [51.0, 0.28, 5856.48],
  [49.0, 0.49, 1194.45],
  [41.0, 5.37, 8429.24],
  [41.0, 2.4, 19651.05],
  [39.0, 6.17, 10447.39],
  [37.0, 6.04, 10213.29],
  [37.0, 2.57, 1059.38],
  [36.0, 1.71, 2352.87],
  [36.0, 1.78, 6812.77],
  [33.0, 0.59, 17789.85],
  [30.0, 0.44, 83996.85],
  [30.0, 2.74, 1349.87],
  [25.0, 3.16, 4690.48],
];

const L1: readonly PeriodicTerm[] = [
  [628331966747.0, 0.0, 0.0],
  [206059.0, 2.678235, 6283.07585],
  [4303.0, 2.6351, 12566.1517],
  [425.0, 1.59, 3.523],
  [119.0, 5.796, 26.298],
  [109.0, 2.966, 1577.344],
  [93.0, 2.59, 18849.23],
  [72.0, 1.14, 529.69],
  [68.0, 1.87, 398.15],
  [67.0, 4.41, 5507.55],
  [59.0, 2.89, 5223.69],
  [56.0, 2.17, 155.42],
  [45.0, 0.4, 796.3],
  [36.0, 0.47, 775.52],
  [29.0, 2.65, 7.11],
  [21.0, 5.34, 0.98],
  [19.0, 1.85, 5486.78],
  [19.0, 4.97, 213.3],
  [17.0, 2.99, 6275.96],
  [16.0, 0.03, 2544.31],
  [16.0, 1.43, 2146.17],
  [15.0, 1.21, 10977.08],
  [12.0, 2.83, 1748.02],
  [12.0, 3.26, 5088.63],
  [12.0, 5.27, 1194.45],
  [12.0, 2.08, 4694.0],
  [11.0, 0.77, 553.57],
  [10.0, 1.3, 6286.6],
  [10.0, 4.24, 1349.87],
  [9.0, 2.7, 242.73],
  [9.0, 5.64, 951.72],
  [8.0, 5.3, 2352.87],
  [6.0, 2.65, 9437.76],
  [6.0, 4.67, 4690.48],
];

const L2: readonly PeriodicTerm[] = [
  [52919.0, 0.0, 0.0],
  [8720.0, 1.0721, 6283.0758],
  [309.0, 0.867, 12566.152],
  [27.0, 0.05, 3.52],
  [16.0, 5.19, 26.3],
  [16.0, 3.68, 155.42],
  [10.0, 0.76, 18849.23],
  [9.0, 2.06, 77713.77],
  [7.0, 0.83, 775.52],
  [5.0, 4.66, 1577.34],
  [4.0, 1.03, 7.11],
  [4.0, 3.44, 5573.14],
  [3.0, 5.14, 796.3],
  [3.0, 6.05, 5507.55],
  [3.0, 1.19, 242.73],
  [3.0, 6.12, 529.69],
  [3.0, 0.31, 398.15],
  [3.0, 2.28, 553.57],
  [2.0, 4.38, 5223.69],
  [2.0, 3.75, 0.98],
];

const L3: readonly PeriodicTerm[] = [
  [289.0, 5.844, 6283.076],
  [35.0, 0.0, 0.0],
  [17.0, 5.49, 12566.15],
  [3.0, 5.2, 155.42],
  [1.0, 4.72, 3.52],
  [1.0, 5.3, 18849.23],
  [1.0, 5.97, 242.73],
];

const L4: readonly PeriodicTerm[] = [
  [114.0, 3.142, 0.0],
  [8.0, 4.13, 6283.08],
  [1.0, 3.84, 12566.15],
];

const L5: readonly PeriodicTerm[] = [[1.0, 3.14, 0.0]];

const B0: readonly PeriodicTerm[] = [
  [280.0, 3.199, 84334.662],
  [102.0, 5.422, 5507.553],
  [80.0, 3.88, 5223.69],
  [44.0, 3.7, 2352.87],
  [32.0, 4.0, 1577.34],
];

const B1: readonly PeriodicTerm[] = [
  [9.0, 3.9, 5507.55],
  [6.0, 1.73, 5223.69],
];

const R0: readonly PeriodicTerm[] = [
  [100013989.0, 0.0, 0.0],
  [1670700.0, 3.0984635, 6283.07585],
  [13956.0, 3.05525, 12566.1517],
  [3084.0, 5.1985, 77713.7715],
  [1628.0, 1.1739, 5753.3849],
  [1576.0, 2.8469, 7860.4194],
  [925.0, 5.453, 11506.77],
  [542.0, 4.564, 3930.21],
  [472.0, 3.661, 5884.927],
  [346.0, 0.964, 5507.553],
  [329.0, 5.9, 5223.694],
  [307.0, 0.299, 5573.143],
  [243.0, 4.273, 11790.629],
  [212.0, 5.847, 1577.344],
  [186.0, 5.022, 10977.079],
  [175.0, 3.012, 18849.228],
  [110.0, 5.055, 5486.778],
  [98.0, 0.89, 6069.78],
  [86.0, 5.69, 15720.84],
  [86.0, 1.27, 161000.69],
  [65.0, 0.27, 17260.15],
  [63.0, 0.92, 529.69],
  [57.0, 2.01, 83996.85],
  [56.0, 5.24, 71430.7],
  [49.0, 3.25, 2544.31],
  [47.0, 2.58, 775.52],
  [45.0, 5.54, 9437.76],
  [43.0, 6.01, 6275.96],
  [39.0, 5.36, 4694.0],
  [38.0, 2.39, 8827.39],
  [37.0, 0.83, 19651.05],
  [37.0, 4.9, 12139.55],
  [36.0, 1.67, 12036.46],
  [35.0, 1.84, 2942.46],
  [33.0, 0.24, 7084.9],
  [32.0, 0.18, 5088.63],
  [32.0, 1.78, 398.15],
  [28.0, 1.21, 6286.6],
  [28.0, 1.9, 6279.55],
  [26.0, 4.59, 10447.39],
];

const R1: readonly PeriodicTerm[] = [
  [103019.0, 1.10749, 6283.07585],
  [1721.0, 1.0644, 12566.1517],
  [702.0, 3.142, 0.0],
  [32.0, 1.02, 18849.23],
  [31.0, 2.84, 5507.55],
  [25.0, 1.32, 5223.69],
  [18.0, 1.42, 1577.34],
  [10.0, 5.91, 10977.08],
  [9.0, 1.42, 6275.96],
  [9.0, 0.27, 5486.78],
];

const R2: readonly PeriodicTerm[] = [
  [4359.0, 5.7846, 6283.0758],
  [124.0, 5.579, 12566.152],
  [12.0, 3.14, 0.0],
  [9.0, 3.63, 77713.77],
  [6.0, 1.87, 5573.14],
  [3.0, 5.47, 18849.23],
];

const R3: readonly PeriodicTerm[] = [
  [145.0, 4.273, 6283.076],
  [7.0, 3.92, 12566.15],
];

const R4: readonly PeriodicTerm[] = [[4.0, 2.56, 6283.08]];

const NUTATION_TERMS: readonly NutationTerm[] = [
  [-171996, -174.2, 92025, 8.9, 0, 0, 0, 0, 1],
  [-13187, -1.6, 5736, -3.1, -2, 0, 0, 2, 2],
  [-2274, -0.2, 977, -0.5, 0, 0, 0, 2, 2],
  [2062, 0.2, -895, 0.5, 0, 0, 0, 0, 2],
  [1426, -3.4, 54, -0.1, 0, 1, 0, 0, 0],
  [712, 0.1, -7, 0, 0, 0, 1, 0, 0],
  [-517, 1.2, 224, -0.6, -2, 1, 0, 2, 2],
  [-386, -0.4, 200, 0, 0, 0, 0, 2, 1],
  [-301, 0, 129, -0.1, 0, 0, 1, 2, 2],
  [217, -0.5, -95, 0.3, -2, -1, 0, 2, 2],
  [-158, 0, 0, 0, -2, 0, 1, 0, 0],
  [129, 0.1, -70, 0, -2, 0, 0, 2, 1],
  [123, 0, -53, 0, 0, 0, -1, 2, 2],
  [63, 0, 0, 0, 2, 0, 0, 0, 0],
  [63, 0.1, -33, 0, 0, 0, 1, 0, 1],
  [-59, 0, 26, 0, 2, 0, -1, 2, 2],
  [-58, -0.1, 32, 0, 0, 0, -1, 0, 1],
  [-51, 0, 27, 0, 0, 0, 1, 2, 1],
  [48, 0, 0, 0, -2, 0, 2, 0, 0],
  [46, 0, -24, 0, 0, 0, -2, 2, 1],
  [-38, 0, 16, 0, 2, 0, 0, 2, 2],
  [-31, 0, 13, 0, 0, 0, 2, 2, 2],
  [29, 0, 0, 0, 0, 0, 2, 0, 0],
  [29, 0, -12, 0, -2, 0, 1, 2, 2],
  [26, 0, 0, 0, 0, 0, 0, 2, 0],
  [-22, 0, 0, 0, -2, 0, 0, 2, 0],
  [21, 0, -10, 0, 0, 0, -1, 2, 1],
  [17, -0.1, 0, 0, 0, 2, 0, 0, 0],
  [16, 0, -8, 0, 2, 0, -1, 0, 1],
  [-16, 0.1, 7, 0, -2, 2, 0, 2, 2],
  [-15, 0, 9, 0, 0, 1, 0, 0, 1],
  [-13, 0, 7, 0, -2, 0, 1, 0, 1],
  [-12, 0, 6, 0, 0, -1, 0, 0, 1],
  [11, 0, 0, 0, 0, 0, 2, -2, 0],
  [-10, 0, 5, 0, 2, 0, -1, 2, 1],
  [-8, 0, 3, 0, 2, 0, 1, 2, 2],
  [7, 0, -3, 0, 0, 1, 0, 2, 2],
  [-7, 0, 0, 0, -2, 1, 1, 0, 0],
  [-7, 0, 3, 0, 0, -1, 0, 2, 2],
  [-7, 0, 3, 0, 2, 0, 0, 2, 1],
  [6, 0, 0, 0, 2, 0, 1, 0, 0],
  [6, 0, -3, 0, -2, 0, 2, 2, 2],
  [6, 0, -3, 0, -2, 0, 1, 2, 1],
  [-6, 0, 3, 0, 2, 0, -2, 0, 1],
  [-6, 0, 3, 0, 2, 0, 0, 0, 1],
  [5, 0, 0, 0, 0, -1, 1, 0, 0],
  [-5, 0, 3, 0, -2, -1, 0, 2, 1],
  [-5, 0, 3, 0, -2, 0, 0, 0, 1],
  [-5, 0, 3, 0, 0, 0, 2, 2, 1],
  [4, 0, 0, 0, -2, 0, 2, 0, 1],
  [4, 0, 0, 0, -2, 1, 0, 2, 1],
  [4, 0, 0, 0, 0, 0, 1, -2, 0],
  [-4, 0, 0, 0, -1, 0, 1, 0, 0],
  [-4, 0, 0, 0, -2, 1, 0, 0, 0],
  [-4, 0, 0, 0, 1, 0, 0, 0, 0],
  [3, 0, 0, 0, 0, 0, 1, 2, 0],
  [-3, 0, 0, 0, 0, 0, -2, 2, 2],
  [-3, 0, 0, 0, -1, -1, 1, 0, 0],
  [-3, 0, 0, 0, 0, 1, 1, 0, 0],
  [-3, 0, 0, 0, 0, -1, 1, 2, 2],
  [-3, 0, 0, 0, 2, -1, -1, 2, 2],
  [-3, 0, 0, 0, 0, 0, 3, 2, 2],
  [-3, 0, 0, 0, 2, -1, 0, 2, 2],
];

/**
 * Approximate atmospheric refraction at sunrise/sunset, degrees. pvlib's
 * `spa_python` substitutes this whenever `atmos_refract` is left unset, and it is the
 * only value the fixture generator uses, so it is pinned here rather than exposed.
 */
const ATMOSPHERIC_REFRACTION_AT_HORIZON_DEG = 0.5667;

/** Earth's equatorial radius in metres, as used by the SPA parallax terms. */
const EARTH_EQUATORIAL_RADIUS_M = 6378140;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

const toDegrees = (radians: number): number => (radians * 180) / Math.PI;

/**
 * Python's `%` with a positive modulus, which always returns a non-negative result.
 * JavaScript's `%` keeps the sign of the dividend, so every `% 360` in the reference
 * implementation goes through this instead.
 */
const mod360 = (degrees: number): number => ((degrees % 360) + 360) % 360;

/** pvlib's `sum_mult_cos_add_mult`: Σ A·cos(B + C·x) over a periodic-term table. */
const sumPeriodicTerms = (terms: readonly PeriodicTerm[], x: number): number => {
  let sum = 0;
  for (const [a, b, c] of terms) {
    sum += a * Math.cos(b + c * x);
  }
  return sum;
};

/** Earth heliocentric longitude L, degrees, from the Julian ephemeris millennium. */
const heliocentricLongitudeDeg = (jme: number): number => {
  const l0 = sumPeriodicTerms(L0, jme);
  const l1 = sumPeriodicTerms(L1, jme);
  const l2 = sumPeriodicTerms(L2, jme);
  const l3 = sumPeriodicTerms(L3, jme);
  const l4 = sumPeriodicTerms(L4, jme);
  const l5 = sumPeriodicTerms(L5, jme);

  const lRad =
    (l0 + l1 * jme + l2 * jme ** 2 + l3 * jme ** 3 + l4 * jme ** 4 + l5 * jme ** 5) / 1e8;

  return mod360(toDegrees(lRad));
};

/** Earth heliocentric latitude B, degrees. */
const heliocentricLatitudeDeg = (jme: number): number => {
  const b0 = sumPeriodicTerms(B0, jme);
  const b1 = sumPeriodicTerms(B1, jme);

  return toDegrees((b0 + b1 * jme) / 1e8);
};

/** Earth–Sun distance R, astronomical units. */
const heliocentricRadiusVectorAu = (jme: number): number => {
  const r0 = sumPeriodicTerms(R0, jme);
  const r1 = sumPeriodicTerms(R1, jme);
  const r2 = sumPeriodicTerms(R2, jme);
  const r3 = sumPeriodicTerms(R3, jme);
  const r4 = sumPeriodicTerms(R4, jme);

  return (r0 + r1 * jme + r2 * jme ** 2 + r3 * jme ** 3 + r4 * jme ** 4) / 1e8;
};

/** The five lunar/solar arguments the nutation series is evaluated over, degrees. */
interface NutationArguments {
  readonly meanElongationDeg: number;
  readonly meanAnomalySunDeg: number;
  readonly meanAnomalyMoonDeg: number;
  readonly moonArgumentLatitudeDeg: number;
  readonly moonAscendingLongitudeDeg: number;
}

const nutationArguments = (jce: number): NutationArguments => ({
  meanElongationDeg: 297.85036 + 445267.11148 * jce - 0.0019142 * jce ** 2 + jce ** 3 / 189474,
  meanAnomalySunDeg: 357.52772 + 35999.05034 * jce - 0.0001603 * jce ** 2 - jce ** 3 / 300000,
  meanAnomalyMoonDeg: 134.96298 + 477198.867398 * jce + 0.0086972 * jce ** 2 + jce ** 3 / 56250,
  moonArgumentLatitudeDeg:
    93.27191 + 483202.017538 * jce - 0.0036825 * jce ** 2 + jce ** 3 / 327270,
  moonAscendingLongitudeDeg:
    125.04452 - 1934.136261 * jce + 0.0020708 * jce ** 2 + jce ** 3 / 450000,
});

/** Nutation in longitude (Δψ) and in obliquity (Δε), degrees. */
interface Nutation {
  readonly longitudeDeg: number;
  readonly obliquityDeg: number;
}

const nutation = (jce: number, args: NutationArguments): Nutation => {
  let longitudeSum = 0;
  let obliquitySum = 0;

  for (const [a, b, c, d, y0, y1, y2, y3, y4] of NUTATION_TERMS) {
    const argumentRad = toRadians(
      y0 * args.meanElongationDeg +
        y1 * args.meanAnomalySunDeg +
        y2 * args.meanAnomalyMoonDeg +
        y3 * args.moonArgumentLatitudeDeg +
        y4 * args.moonAscendingLongitudeDeg,
    );
    longitudeSum += (a + b * jce) * Math.sin(argumentRad);
    obliquitySum += (c + d * jce) * Math.cos(argumentRad);
  }

  return { longitudeDeg: longitudeSum / 36000000, obliquityDeg: obliquitySum / 36000000 };
};

/** Mean obliquity of the ecliptic ε₀, arcseconds. */
const meanEclipticObliquityArcsec = (jme: number): number => {
  const u = jme / 10;

  return (
    84381.448 -
    4680.93 * u -
    1.55 * u ** 2 +
    1999.25 * u ** 3 -
    51.38 * u ** 4 -
    249.67 * u ** 5 -
    39.05 * u ** 6 +
    7.12 * u ** 7 +
    27.87 * u ** 8 +
    5.79 * u ** 9 +
    2.45 * u ** 10
  );
};

/** Geocentric sun right ascension α, degrees. */
const geocentricRightAscensionDeg = (
  apparentSunLongitudeDeg: number,
  trueEclipticObliquityDeg: number,
  geocentricLatitudeDeg: number,
): number => {
  const obliquityRad = toRadians(trueEclipticObliquityDeg);
  const sunLongitudeRad = toRadians(apparentSunLongitudeDeg);

  const numerator =
    Math.sin(sunLongitudeRad) * Math.cos(obliquityRad) -
    Math.tan(toRadians(geocentricLatitudeDeg)) * Math.sin(obliquityRad);

  return mod360(toDegrees(Math.atan2(numerator, Math.cos(sunLongitudeRad))));
};

/** Geocentric sun declination δ, degrees. */
const geocentricDeclinationDeg = (
  apparentSunLongitudeDeg: number,
  trueEclipticObliquityDeg: number,
  geocentricLatitudeDeg: number,
): number => {
  const latitudeRad = toRadians(geocentricLatitudeDeg);
  const obliquityRad = toRadians(trueEclipticObliquityDeg);

  return toDegrees(
    Math.asin(
      Math.sin(latitudeRad) * Math.cos(obliquityRad) +
        Math.cos(latitudeRad) *
          Math.sin(obliquityRad) *
          Math.sin(toRadians(apparentSunLongitudeDeg)),
    ),
  );
};

/**
 * The observer's position relative to Earth's centre, as the SPA's `x` and `y` terms:
 * the flattened-Earth projections that carry latitude and elevation into the parallax
 * correction.
 */
interface ObserverTerms {
  readonly x: number;
  readonly y: number;
}

const observerTerms = (latitudeDeg: number, elevationM: number): ObserverTerms => {
  const u = Math.atan(0.99664719 * Math.tan(toRadians(latitudeDeg)));
  const radiusFraction = elevationM / EARTH_EQUATORIAL_RADIUS_M;

  return {
    x: Math.cos(u) + radiusFraction * Math.cos(toRadians(latitudeDeg)),
    y: 0.99664719 * Math.sin(u) + radiusFraction * Math.sin(toRadians(latitudeDeg)),
  };
};

/**
 * Atmospheric refraction correction Δe, degrees, added to the true elevation angle.
 *
 * pvlib's above-horizon guard: below `-(0.26667 + atmos_refract)` degrees of elevation
 * the sun is far enough under the horizon that the refraction term is switched off
 * entirely (the naive formula would otherwise turn over and give nonsense there).
 */
const refractionCorrectionDeg = (
  elevationWithoutRefractionDeg: number,
  pressureMillibar: number,
  temperatureC: number,
): number => {
  const aboveHorizon =
    elevationWithoutRefractionDeg >= -1 * (0.26667 + ATMOSPHERIC_REFRACTION_AT_HORIZON_DEG);

  if (!aboveHorizon) {
    return 0;
  }

  return (
    (pressureMillibar / 1010) *
    (283 / (273 + temperatureC)) *
    (1.02 /
      (60 *
        Math.tan(
          toRadians(elevationWithoutRefractionDeg + 10.3 / (elevationWithoutRefractionDeg + 5.11)),
        )))
  );
};

/** Observer and atmosphere for a single solar-position evaluation. */
export interface SolarPositionInput {
  /** Degrees north of the equator, negative south. */
  readonly latitudeDeg: number;
  /** Degrees east of the prime meridian, negative west. */
  readonly longitudeDeg: number;
  /** The instant to evaluate, milliseconds since the Unix epoch (UTC). */
  readonly timeUtcMs: number;
  /** Observer height above sea level, metres. Feeds the topocentric parallax terms. */
  readonly elevationM?: number;
  /** Local air pressure, pascals. Only affects the refraction correction. */
  readonly pressurePa?: number;
  /** Local air temperature, °C. Only affects the refraction correction. */
  readonly temperatureC?: number;
  /** ΔT, seconds: the difference between terrestrial time and UT1. */
  readonly deltaTSeconds?: number;
}

/** Where the sun is, as seen from the observer. */
export interface SolarPosition {
  /** Zenith angle including atmospheric refraction, degrees from vertical. */
  readonly apparentZenithDeg: number;
  /** Degrees clockwise from true north, in [0, 360). */
  readonly azimuthDeg: number;
}

/**
 * Apparent solar zenith and azimuth at an instant, by the NREL SPA.
 *
 * Pure: the instant is a parameter, never a clock read, so the same input always gives
 * the same output (architecture rule 3).
 */
export const solarPosition = (input: SolarPositionInput): SolarPosition => {
  const {
    latitudeDeg,
    longitudeDeg,
    timeUtcMs,
    elevationM = 0,
    pressurePa = 101325,
    temperatureC = 12,
    deltaTSeconds = 67.0,
  } = input;

  // pvlib's `spa_python` converts pascals to millibars before the refraction step.
  const pressureMillibar = pressurePa / 100;

  const julianDay = timeUtcMs / 1000 / 86400 + 2440587.5;
  const julianEphemerisDay = julianDay + deltaTSeconds / 86400;
  const julianCentury = (julianDay - 2451545) / 36525;
  const julianEphemerisCentury = (julianEphemerisDay - 2451545) / 36525;
  const julianEphemerisMillennium = julianEphemerisCentury / 10;

  const earthRadiusAu = heliocentricRadiusVectorAu(julianEphemerisMillennium);
  const geocentricLongitudeDeg = mod360(heliocentricLongitudeDeg(julianEphemerisMillennium) + 180);
  const geocentricLatitudeDeg = -heliocentricLatitudeDeg(julianEphemerisMillennium);

  const { longitudeDeg: nutationLongitudeDeg, obliquityDeg: nutationObliquityDeg } = nutation(
    julianEphemerisCentury,
    nutationArguments(julianEphemerisCentury),
  );

  const trueEclipticObliquityDeg =
    meanEclipticObliquityArcsec(julianEphemerisMillennium) / 3600 + nutationObliquityDeg;
  const aberrationCorrectionDeg = -20.4898 / (3600 * earthRadiusAu);
  const apparentSunLongitudeDeg =
    geocentricLongitudeDeg + nutationLongitudeDeg + aberrationCorrectionDeg;

  const meanSiderealTimeDeg = mod360(
    280.46061837 +
      360.98564736629 * (julianDay - 2451545) +
      0.000387933 * julianCentury ** 2 -
      julianCentury ** 3 / 38710000,
  );
  const apparentSiderealTimeDeg =
    meanSiderealTimeDeg + nutationLongitudeDeg * Math.cos(toRadians(trueEclipticObliquityDeg));

  const rightAscensionDeg = geocentricRightAscensionDeg(
    apparentSunLongitudeDeg,
    trueEclipticObliquityDeg,
    geocentricLatitudeDeg,
  );
  const declinationDeg = geocentricDeclinationDeg(
    apparentSunLongitudeDeg,
    trueEclipticObliquityDeg,
    geocentricLatitudeDeg,
  );

  // Local hour angle H, measured westward from south.
  const localHourAngleDeg = mod360(apparentSiderealTimeDeg + longitudeDeg - rightAscensionDeg);
  const localHourAngleRad = toRadians(localHourAngleDeg);

  const equatorialHorizontalParallaxDeg = 8.794 / (3600 * earthRadiusAu);
  const parallaxRad = toRadians(equatorialHorizontalParallaxDeg);
  const { x, y } = observerTerms(latitudeDeg, elevationM);

  const parallaxRightAscensionDeg = toDegrees(
    Math.atan2(
      -x * Math.sin(parallaxRad) * Math.sin(localHourAngleRad),
      Math.cos(toRadians(declinationDeg)) - x * Math.sin(parallaxRad) * Math.cos(localHourAngleRad),
    ),
  );

  const topocentricDeclinationDeg = toDegrees(
    Math.atan2(
      (Math.sin(toRadians(declinationDeg)) - y * Math.sin(parallaxRad)) *
        Math.cos(toRadians(parallaxRightAscensionDeg)),
      Math.cos(toRadians(declinationDeg)) - x * Math.sin(parallaxRad) * Math.cos(localHourAngleRad),
    ),
  );

  const topocentricLocalHourAngleDeg = localHourAngleDeg - parallaxRightAscensionDeg;
  const topocentricLocalHourAngleRad = toRadians(topocentricLocalHourAngleDeg);
  const latitudeRad = toRadians(latitudeDeg);

  const elevationWithoutRefractionDeg = toDegrees(
    Math.asin(
      Math.sin(latitudeRad) * Math.sin(toRadians(topocentricDeclinationDeg)) +
        Math.cos(latitudeRad) *
          Math.cos(toRadians(topocentricDeclinationDeg)) *
          Math.cos(topocentricLocalHourAngleRad),
    ),
  );

  const apparentElevationDeg =
    elevationWithoutRefractionDeg +
    refractionCorrectionDeg(elevationWithoutRefractionDeg, pressureMillibar, temperatureC);

  // The paper's azimuth Γ is measured westward from south; +180 puts it clockwise
  // from north, this repo's convention everywhere.
  const astronomersAzimuthDeg = mod360(
    toDegrees(
      Math.atan2(
        Math.sin(topocentricLocalHourAngleRad),
        Math.cos(topocentricLocalHourAngleRad) * Math.sin(latitudeRad) -
          Math.tan(toRadians(topocentricDeclinationDeg)) * Math.cos(latitudeRad),
      ),
    ),
  );

  return {
    apparentZenithDeg: 90 - apparentElevationDeg,
    azimuthDeg: mod360(astronomersAzimuthDeg + 180),
  };
};
