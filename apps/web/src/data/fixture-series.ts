import {
  utcIsoTimestampSchema,
  type Forecast,
  type GenerationReading,
  type Site,
} from '@cumulo/shared';

import type { RangeHours } from './fleet-data-source';

/**
 * Deterministic synthetic series for the chart views — the arithmetic behind
 * `DemoFleetDataSource`'s window-scoped reads.
 *
 * Determinism is the point: no clock, no randomness, no environment. "Now" is
 * pinned to {@link FIXTURE_NOW}, so the same call always yields the same bytes
 * and a chart test can assert exact numbers. Every irregular-looking value comes
 * from {@link seededUnit}, keyed by site and hour, so the series is reproducible
 * in Node, the browser and CI alike.
 *
 * Kept apart from the demo source's *other* generator — the clock-relative one
 * behind `getSiteForecast` — deliberately (`structure.md` rule 7). The two look
 * alike and mean different things: that one exists so a site created seconds ago
 * has no forecast and then does, which requires a real clock, while this one
 * exists so a chart's numbers can be asserted, which forbids one. Changing
 * either would not make the other wrong.
 *
 * Top-level arrows over a state-holding object: nothing here is stateful, so
 * there is no `this.` to justify and no captured scope to trace
 * (`structure.md` rules 1 and 2).
 */

/** The instant this fixture calls "now". Actuals stop here; forecasts continue past it. */
export const FIXTURE_NOW = '2026-07-30T12:00:00Z';

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

const toTimestamp = (epochMs: number) =>
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

/**
 * One site's forecast series over the window, hourly and ascending.
 *
 * `siteIndex` is the site's position in the fleet it was drawn from, and it is
 * what keys the weather: two sites with identical hardware still get different
 * days, and the same site gets the same day every time it is asked.
 */
export const fixtureForecasts = (
  site: Site,
  siteIndex: number,
  range: RangeHours,
): readonly Forecast[] =>
  hoursInRange(range).map((epochMs) => forecastAt({ site, siteIndex, epochMs }));

/** Measurements exist only for hours that have already happened — the forecast horizon has none. */
export const fixtureActuals = (
  site: Site,
  siteIndex: number,
  range: RangeHours,
): readonly GenerationReading[] =>
  hoursInRange(range)
    .filter((epochMs) => epochMs <= FIXTURE_NOW_MS)
    .map((epochMs) => actualAt({ site, siteIndex, epochMs }));
