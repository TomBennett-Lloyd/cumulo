/**
 * NREL Solar Position Algorithm (SPA) — apparent solar zenith and azimuth for an
 * observer at an instant.
 *
 * Hand-ported to TypeScript per ADR 0003: the physics runs in one language, and pvlib
 * stays the correctness authority offline, through committed golden fixtures.
 *
 * Algorithm: I. Reda and A. Andreas, "Solar position algorithm for solar radiation
 * applications", NREL/TP-560-34302; Solar Energy 76(5), 577–589 (2004), with the 2007
 * corrigendum. The order of the steps below is transcribed from pvlib-python v0.15.2,
 * `pvlib/spa.py` (BSD-3-Clause), so that this port and the fixture generator are the
 * same algorithm rather than two readings of the same paper. The coefficient tables the
 * steps sum over — L0–L5, B0–B1, R0–R4 and the 63-row nutation table — are transcribed
 * from the same source and live in `./spa-periodic-terms`.
 *
 * Defaults match pvlib's `solarposition.spa_python`: sea level, 101325 Pa, 12 °C,
 * ΔT = 67.0 s.
 *
 * Angles are degrees unless a name says otherwise. Azimuth is measured clockwise from
 * true north in [0, 360), the same convention as `siteSchema.azimuthDegrees`.
 */

import {
  B0,
  B1,
  L0,
  L1,
  L2,
  L3,
  L4,
  L5,
  NUTATION_TERMS,
  R0,
  R1,
  R2,
  R3,
  R4,
  type PeriodicTerm,
} from './spa-periodic-terms';

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
