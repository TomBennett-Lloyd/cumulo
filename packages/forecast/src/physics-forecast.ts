/**
 * The physics forecast chain: one weather reading for one site becomes one hour of
 * predicted AC power.
 *
 * This is the composition layer over the four ported modules — solar position (NREL
 * SPA), plane-of-array irradiance (Spencer + Hay-Davies), cell temperature (Faiman) and
 * power (PVWatts DC + clipped inverter). It adds no physics of its own; what it owns is
 * the wiring decisions, each of which is a pin the golden-fixture generator makes
 * identically (ADR 0003):
 *
 * **When the geometry is evaluated.** Open-Meteo's radiation fields are means over the
 * hour *ending* at `validTime` (see `weatherReadingSchema`), so the sun position that
 * belongs with them is the one at the middle of that hour, not at its edge. The chain
 * therefore evaluates all solar geometry at `validTime − 30 minutes`. Evaluating at
 * `validTime` itself would put the sun half an hour too late — visibly wrong at sunrise
 * and sunset, where the hour's mean irradiance is nonzero but the instantaneous sun is
 * below the horizon.
 *
 * **Whose coordinates govern.** Solar geometry comes from the **site's** latitude and
 * longitude. The reading's own coordinates are never read and never checked against the
 * site's: a weather reading is fetched per location and fanned out to every site near
 * it (API frugality is a hard constraint), so the two legitimately differ by the
 * rounding of the location key. Pairing a site with an appropriate reading is
 * orchestration's job (#11/#13), not the physics engine's.
 *
 * **What the physics ignores.** `cloudCoverPct` carries no information the irradiance
 * fields do not already contain — it exists for the ML correction layer (#20) and the
 * UI. `kind` (forecast vs archive) is provenance: the chain runs identically on a
 * predicted hour and a replayed historical one, which is what makes the hindcast
 * harness (#16) a straight replay.
 *
 * Pure throughout (architecture rule 3): no clock, no I/O, no env. `issuedAt` is a
 * parameter precisely because reading it from a clock here would make every forecast
 * untestable and every hindcast a lie.
 */

import {
  forecastSchema,
  type Forecast,
  type Site,
  type UtcIsoTimestamp,
  type WeatherReading,
} from '@cumulo/shared';

import { faimanCellTemperatureC } from './cell-temperature';
import {
  angleOfIncidence,
  extraterrestrialNormalIrradiance,
  poaIrradiance,
  type PoaIrradiance,
} from './irradiance';
import { acPowerKw, pvwattsDcPowerKw } from './power';
import { solarPosition, type SolarPosition } from './solar-position';

/**
 * Every tunable constant of the pinned v1 model, in one place.
 *
 * These are model pins, not preferences: the golden fixtures were generated with exactly
 * these values, so overriding one moves the chain off its reference. The knobs exist so
 * that hindcast experiments (#16) and per-site properties (albedo is genuinely
 * site-specific — snow, grass, dark roof) can vary them explicitly.
 */
export interface PhysicsParams {
  /** Ground reflectance, 0–1. Drives the ground-reflected POA component. */
  readonly albedo: number;
  /** PVWatts temperature coefficient of power, fraction per °C. */
  readonly gammaPerC: number;
  /** Faiman still-air heat-loss coefficient u0, W/m²K. */
  readonly faimanU0: number;
  /** Faiman wind-proportional heat-loss coefficient u1, W·s/m³K. */
  readonly faimanU1: number;
  /** Inverter efficiency as a fraction in (0, 1]. */
  readonly inverterEfficiency: number;
  /** ΔT, seconds: terrestrial time minus UT1, for the solar-position ephemeris. */
  readonly deltaTSeconds: number;
}

/**
 * The pinned v1 model constants (ADR 0003), matching the pvlib calls the golden-fixture
 * generator makes: albedo 0.2 (pvlib's default ground reflectance for generic ground
 * cover), γ = −0.004/°C and 96 % inverter efficiency (PVWatts defaults), u0 = 25.0 /
 * u1 = 6.84 (pvlib `temperature.faiman` defaults), ΔT = 67.0 s (pvlib `spa_python`
 * default).
 */
export const defaultPhysicsParams: PhysicsParams = {
  albedo: 0.2,
  gammaPerC: -0.004,
  faimanU0: 25.0,
  faimanU1: 6.84,
  inverterEfficiency: 0.96,
  deltaTSeconds: 67.0,
};

/**
 * Every intermediate the chain computes, not just its answer.
 *
 * The intermediates are exposed because they are what the golden fixtures assert against
 * and what makes a wrong forecast diagnosable: a bad `acPowerKw` is one of a bad sun
 * position, a bad transposition, or a bad thermal model, and only the intermediates say
 * which.
 */
export interface PhysicsChainResult {
  /** Apparent sun position at the hour's midpoint, from the site's coordinates. */
  readonly solar: SolarPosition;
  /** Angle between the sun and the module's normal, degrees. */
  readonly aoiDeg: number;
  /** Plane-of-array irradiance, split into beam, sky diffuse and ground components. */
  readonly poa: PoaIrradiance;
  /** Module cell temperature, °C. */
  readonly cellTemperatureC: number;
  /** DC power leaving the array, kW — unclipped. */
  readonly dcPowerKw: number;
  /** AC power after inverter efficiency and nameplate clipping, kW. */
  readonly acPowerKw: number;
}

/** Half an hour in milliseconds: the offset from an hour-ending mean to its midpoint. */
const HOUR_MIDPOINT_OFFSET_MS = 30 * 60 * 1000;

/** Everything `createPhysicsForecast` needs to emit one forecast row. */
export interface CreatePhysicsForecastInput {
  /** The installation being forecast — its coordinates, geometry and nameplate. */
  readonly site: Site;
  /** The weather hour to run the chain on. */
  readonly weather: WeatherReading;
  /** Forecast vintage: which cycle produced this row. A parameter, never a clock read. */
  readonly issuedAt: UtcIsoTimestamp;
  /** Model-constant overrides; anything omitted comes from `defaultPhysicsParams`. */
  readonly params?: Partial<PhysicsParams>;
}

/**
 * Run the full physics chain for one site and one weather hour.
 *
 * Sun position and angle of incidence are evaluated at `validTime − 30 min` (the hour's
 * midpoint) from the **site's** coordinates; see the module doc comment for why on both
 * counts. The radiation fields feed the transposition, while `temperature2mC` and
 * `windSpeed10mMs` — instantaneous at `validTime` rather than hour means — feed the
 * thermal model; that mismatch is inherent to the provider's fields, not a choice made
 * here.
 */
export const runPhysicsChain = (
  site: Site,
  weather: WeatherReading,
  params: Partial<PhysicsParams> = {},
): PhysicsChainResult => {
  const { albedo, gammaPerC, faimanU0, faimanU1, inverterEfficiency, deltaTSeconds } = {
    ...defaultPhysicsParams,
    ...params,
  };

  const evaluationTimeUtcMs = Date.parse(weather.validTime) - HOUR_MIDPOINT_OFFSET_MS;

  const solar = solarPosition({
    latitudeDeg: site.latitude,
    longitudeDeg: site.longitude,
    timeUtcMs: evaluationTimeUtcMs,
    deltaTSeconds,
  });

  const geometry = {
    apparentZenithDeg: solar.apparentZenithDeg,
    solarAzimuthDeg: solar.azimuthDeg,
    tiltDegrees: site.tiltDegrees,
    azimuthDegrees: site.azimuthDegrees,
  };

  const poa = poaIrradiance({
    ...geometry,
    ghiWm2: weather.shortwaveRadiationWm2,
    dniWm2: weather.directNormalIrradianceWm2,
    dhiWm2: weather.diffuseRadiationWm2,
    dniExtraWm2: extraterrestrialNormalIrradiance(evaluationTimeUtcMs),
    albedo,
  });

  const cellTemperatureC = faimanCellTemperatureC({
    poaTotalWm2: poa.totalWm2,
    temperature2mC: weather.temperature2mC,
    windSpeed10mMs: weather.windSpeed10mMs,
    u0: faimanU0,
    u1: faimanU1,
  });

  const dcPowerKw = pvwattsDcPowerKw({
    poaTotalWm2: poa.totalWm2,
    cellTemperatureC,
    capacityKw: site.capacityKw,
    gammaPerC,
  });

  return {
    solar,
    aoiDeg: angleOfIncidence(geometry),
    poa,
    cellTemperatureC,
    dcPowerKw,
    acPowerKw: acPowerKw({ dcPowerKw, capacityKw: site.capacityKw, inverterEfficiency }),
  };
};

/**
 * The physics forecast for one site-hour, as the `Forecast` the rest of the system
 * stores, serves and compares against ML.
 *
 * No `uncertainty` key is set at all — physics v1 emits point estimates, and under
 * `exactOptionalPropertyTypes` an omitted optional field and one explicitly set to
 * `undefined` are different things. The omitted form is the honest one: it round-trips
 * through JSON and DynamoDB as "absent" rather than as a null nobody meant.
 *
 * The result is passed through `forecastSchema.parse` as a final invariant guard, and the
 * parse is deliberately not caught: a violated bound means the chain produced a number
 * nobody should store, and that must stop the cycle loudly rather than persist quietly
 * (error-handling: fail fast, never swallow).
 *
 * Those bounds are **not** unreachable from schema-valid inputs, and this comment used to
 * claim they were. The route is low-sun circumsolar amplification. Hay-Davies floors
 * cos(zenith) in the projection ratio at 0.01745 (`irradiance.ts`, pvlib GH 432), so `Rb`
 * tops out near 57; a near-grazing sun on a vertical array aimed straight at it therefore
 * multiplies DHI by ~57 rather than diverging. Feed that geometry every irradiance field
 * at its 1500 W/m² `weatherReadingSchema` cap and the chain returns POA ≈ 95 200 W/m², a
 * cell at ≈ 3870 °C and — once the PVWatts temperature factor goes negative — DC and AC
 * power around −5300 kW. Measured with a `siteSchema`-valid Dublin site (tilt 90, azimuth
 * 89.47) and a `weatherReadingSchema`-valid reading at 2026-03-20T07:00:00Z, whose
 * evaluation midpoint sits at apparent zenith 89.996°.
 *
 * So a throw here means "physically implausible input" as well as "bug in this package".
 * Both still warrant failing fast at this layer; what neither this function nor its caller
 * yet has is a policy for the first case — abort the cycle, or surface a typed expected
 * failure (error-handling rule 1). That decision belongs to #13's forecast Lambda and
 * #16's hindcast harness and is logged in `docs/tech-debt.md`, not settled here.
 */
export const createPhysicsForecast = (input: CreatePhysicsForecastInput): Forecast => {
  const { site, weather, issuedAt, params } = input;

  const chain = runPhysicsChain(site, weather, params);

  return forecastSchema.parse({
    siteId: site.id,
    model: 'physics',
    validTime: weather.validTime,
    issuedAt,
    weatherSource: weather.source,
    poaIrradianceWm2: chain.poa.totalWm2,
    acPowerKw: chain.acPowerKw,
  });
};
