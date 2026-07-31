import {
  canonicalFleetSeed,
  generateFleet,
  utcIsoTimestampSchema,
  type Forecast,
  type GenerationReading,
  type Site,
  type UtcIsoTimestamp,
} from '@cumulo/shared';

import type { DataResult, FleetDataProvider, RangeHours } from './provider';

/**
 * A deterministic `FleetDataProvider` over synthetic data — the demo's data source until the
 * Fleet API (#14) exists.
 *
 * Determinism is the point: no clock, no randomness, no environment. "Now" is pinned to
 * {@link FIXTURE_NOW}, so the same call always yields the same bytes and a chart test can assert
 * exact numbers. Every irregular-looking value comes from {@link seededUnit}, keyed by site and
 * hour, so the series is reproducible in Node, the browser and CI alike.
 *
 * Exported as a plain object of standalone arrows rather than a `createFixtureProvider()` factory:
 * the provider holds no state, so a factory would be the closure shape `docs/standards/structure.md`
 * rule 2 bans, and a class would put a `this.` marker on state that does not exist. Every function
 * below is top-level and context-free; the object literal at the bottom is only the composition
 * step.
 */

/** The instant this fixture calls "now". Actuals stop here; forecasts continue past it. */
const FIXTURE_NOW = '2026-07-30T12:00:00Z';
const FIXTURE_NOW_MS = Date.parse(FIXTURE_NOW);
const FIXTURE_ISSUED_AT = utcIsoTimestampSchema.parse(FIXTURE_NOW);

const MILLISECONDS_PER_HOUR = 3_600_000;
const MILLISECONDS_PER_DAY = 86_400_000;

/** How far past `FIXTURE_NOW` the forecast series runs, in hours — the same for every range. */
const FORECAST_HORIZON_HOURS = 24;

/** Power values are recorded to watt precision; the underlying model claims nothing finer. */
const POWER_DECIMALS = 3;

/** Mirrors `forecastSchema`'s residential sanity cap, so a wide band cannot forge an invalid p90. */
const SITE_POWER_CAP_KW = 50;

/**
 * A seeded draw in `[0, 1)` — mulberry32's step arithmetic applied once, keyed by `seed`.
 *
 * Deliberately a local copy of the arithmetic in `packages/shared/src/fleet.ts` rather than an
 * import of it (`docs/standards/structure.md` rule 7): that one is a *stream* whose draw order is
 * the canonical fleet's contract, this one is a pure hash called in arbitrary order for cosmetic
 * weather. They have different intents and must be free to diverge — retuning the demo's cloud
 * cover must not move a single site.
 */
const seededUnit = (seed: number): number => {
  const a = (seed + 0x6d2b79f5) >>> 0;
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** One seeded draw mapped onto `[min, max)`. */
const seededRange = (seed: number, min: number, max: number): number =>
  min + seededUnit(seed) * (max - min);

const roundTo = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

const toTimestamp = (epochMs: number): UtcIsoTimestamp =>
  utcIsoTimestampSchema.parse(new Date(epochMs).toISOString().replace(/\.\d{3}Z$/u, 'Z'));

const SUNRISE_HOUR_UTC = 6;
const DAYLIGHT_HOURS = 12;

/**
 * A half-sine clear-sky day: zero before 06:00 and after 18:00 UTC, peaking at solar noon.
 *
 * Latitude-independent on purpose — the real geometry lives in `@cumulo/forecast`, and duplicating
 * an approximation of it here would invite someone to trust this one.
 */
const clearSkyShape = (epochMs: number): number => {
  const hourUtc = new Date(epochMs).getUTCHours();
  return Math.max(0, Math.sin((Math.PI * (hourUtc - SUNRISE_HOUR_UTC)) / DAYLIGHT_HOURS));
};

const CLOUD_FACTOR_MIN = 0.4;
const CLOUD_SITE_STRIDE = 1_000_003;

/** One cloud-cover multiplier per site per day, so a day reads as overcast or bright throughout. */
const cloudFactor = (siteIndex: number, epochMs: number): number =>
  seededRange(
    siteIndex * CLOUD_SITE_STRIDE + Math.floor(epochMs / MILLISECONDS_PER_DAY),
    CLOUD_FACTOR_MIN,
    1,
  );

const BAND_BASE_FRACTION = 0.2;
const BAND_GROWTH_PER_HOUR = 0.01;
const BAND_MAX_FRACTION = 0.5;

/** The band's half-width as a fraction of the median: ±20 % at issue, widening with lead time. */
const bandHalfWidth = (epochMs: number): number => {
  const hoursAfterNow = Math.max(0, (epochMs - FIXTURE_NOW_MS) / MILLISECONDS_PER_HOUR);
  return Math.min(BAND_MAX_FRACTION, BAND_BASE_FRACTION + BAND_GROWTH_PER_HOUR * hoursAfterNow);
};

/** One site at one hour — the coordinates every generator below needs, named once. */
interface SiteHour {
  readonly site: Site;
  readonly siteIndex: number;
  readonly epochMs: number;
}

/** The point estimate both the forecast and its actual are built from. */
const medianKwAt = ({ site, siteIndex, epochMs }: SiteHour): number =>
  roundTo(
    site.capacityKw * clearSkyShape(epochMs) * cloudFactor(siteIndex, epochMs),
    POWER_DECIMALS,
  );

/**
 * Standard-test-condition irradiance. The fixture reports plane-of-array irradiance as this
 * scaled by the same clear-sky shape and cloud factor as the power, so the two stay consistent —
 * it is a plausible companion number, not a second model.
 */
const STC_IRRADIANCE_WM2 = 1000;

const forecastAt = (siteHour: SiteHour): Forecast => {
  const { site, siteIndex, epochMs } = siteHour;
  const medianKw = medianKwAt(siteHour);
  const halfWidth = bandHalfWidth(epochMs);
  // Quantiles derive from the *rounded* median, so `p10 <= median <= p90` survives rounding.
  return {
    siteId: site.id,
    model: 'physics',
    validTime: toTimestamp(epochMs),
    issuedAt: FIXTURE_ISSUED_AT,
    weatherSource: 'open-meteo',
    poaIrradianceWm2: roundTo(
      STC_IRRADIANCE_WM2 * clearSkyShape(epochMs) * cloudFactor(siteIndex, epochMs),
      POWER_DECIMALS,
    ),
    acPowerKw: medianKw,
    uncertainty: {
      p10AcPowerKw: roundTo(medianKw * (1 - halfWidth), POWER_DECIMALS),
      p90AcPowerKw: roundTo(
        Math.min(SITE_POWER_CAP_KW, medianKw * (1 + halfWidth)),
        POWER_DECIMALS,
      ),
    },
  };
};

const ACTUAL_FACTOR_MIN = 0.85;
const ACTUAL_FACTOR_MAX = 1.15;
const ACTUAL_SITE_STRIDE = 7919;
const ACTUAL_SEED_OFFSET = 104_729;

/** A measurement is the median knocked ±15 % by a per-site-per-hour draw, clamped to the cap. */
const actualAt = (siteHour: SiteHour): GenerationReading => {
  const { site, siteIndex, epochMs } = siteHour;
  const noise = seededRange(
    siteIndex * ACTUAL_SITE_STRIDE +
      Math.floor(epochMs / MILLISECONDS_PER_HOUR) +
      ACTUAL_SEED_OFFSET,
    ACTUAL_FACTOR_MIN,
    ACTUAL_FACTOR_MAX,
  );
  return {
    siteId: site.id,
    validTime: toTimestamp(epochMs),
    acPowerKw: roundTo(
      Math.min(SITE_POWER_CAP_KW, Math.max(0, medianKwAt(siteHour) * noise)),
      POWER_DECIMALS,
    ),
  };
};

/** Hour-ending instants from `range` hours before `FIXTURE_NOW` to 24 h after it, inclusive. */
const hoursInRange = (range: RangeHours): readonly number[] => {
  const instants: number[] = [];
  for (let offset = -range; offset <= FORECAST_HORIZON_HOURS; offset += 1) {
    instants.push(FIXTURE_NOW_MS + offset * MILLISECONDS_PER_HOUR);
  }
  return instants;
};

const FIXTURE_SITES = generateFleet(canonicalFleetSeed);

const forecastsForSite = (site: Site, siteIndex: number, range: RangeHours): readonly Forecast[] =>
  hoursInRange(range).map((epochMs) => forecastAt({ site, siteIndex, epochMs }));

/** Measurements exist only for hours that have already happened — the forecast horizon has none. */
const actualsForSite = (
  site: Site,
  siteIndex: number,
  range: RangeHours,
): readonly GenerationReading[] =>
  hoursInRange(range)
    .filter((epochMs) => epochMs <= FIXTURE_NOW_MS)
    .map((epochMs) => actualAt({ site, siteIndex, epochMs }));

/**
 * Resolve a site id against the fixture fleet.
 *
 * An unknown id is an expected failure, not a bug: the caller may hold a stale id. It comes back
 * as a `failed` result naming the operation and the id (`error-handling.md` rules 1 and 4) rather
 * than as an empty series, which would read as "this site generates nothing".
 */
const findSite = (operation: string, siteId: string): DataResult<SiteHour> => {
  const siteIndex = FIXTURE_SITES.findIndex((candidate) => candidate.id === siteId);
  const site = FIXTURE_SITES[siteIndex];
  if (site === undefined) {
    return {
      status: 'failed',
      error: `${operation}: no site in the fixture fleet with id ${siteId}`,
    };
  }
  return { status: 'ready', data: { site, siteIndex, epochMs: FIXTURE_NOW_MS } };
};

const listSites = (): Promise<DataResult<readonly Site[]>> =>
  Promise.resolve({ status: 'ready', data: FIXTURE_SITES });

const siteForecasts = (
  siteId: string,
  range: RangeHours,
): Promise<DataResult<readonly Forecast[]>> => {
  const found = findSite('siteForecasts', siteId);
  if (found.status === 'failed') {
    return Promise.resolve(found);
  }
  const { site, siteIndex } = found.data;
  return Promise.resolve({ status: 'ready', data: forecastsForSite(site, siteIndex, range) });
};

const siteActuals = (
  siteId: string,
  range: RangeHours,
): Promise<DataResult<readonly GenerationReading[]>> => {
  const found = findSite('siteActuals', siteId);
  if (found.status === 'failed') {
    return Promise.resolve(found);
  }
  const { site, siteIndex } = found.data;
  return Promise.resolve({ status: 'ready', data: actualsForSite(site, siteIndex, range) });
};

const fleetForecasts = (range: RangeHours): Promise<DataResult<readonly Forecast[]>> =>
  Promise.resolve({
    status: 'ready',
    data: FIXTURE_SITES.flatMap((site, siteIndex) => forecastsForSite(site, siteIndex, range)),
  });

const fleetActuals = (range: RangeHours): Promise<DataResult<readonly GenerationReading[]>> =>
  Promise.resolve({
    status: 'ready',
    data: FIXTURE_SITES.flatMap((site, siteIndex) => actualsForSite(site, siteIndex, range)),
  });

/** The composition step: no state, no captured variables, nothing to trace. */
export const fixtureProvider: FleetDataProvider = {
  listSites,
  siteForecasts,
  siteActuals,
  fleetForecasts,
  fleetActuals,
};

/** Exported for tests and for views that want to label the fixture's pinned "now". */
export { FIXTURE_NOW };
