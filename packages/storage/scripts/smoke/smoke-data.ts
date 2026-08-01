import {
  fleetSiteSchema,
  forecastSchema,
  generationReadingSchema,
  utcIsoTimestampSchema,
  weatherReadingSchema,
} from '@cumulo/shared';
import type {
  ArchiveWeatherReading,
  FleetSite,
  Forecast,
  ForecastModel,
  ForecastWeatherReading,
  GenerationReading,
  UtcIsoTimestamp,
  WeatherReading,
} from '@cumulo/shared';

/**
 * The values a smoke run writes to the live tables.
 *
 * *Where* it writes them is `../storage-environment`'s `ENVIRONMENT`, which
 * moved out of this module when the seed script became a second caller.
 */

/**
 * Null Island, and a day two decades before this project existed.
 *
 * Both are chosen to be unreachable by real data. The fleet is a
 * British-and-Irish rooftop simulation, so no site rounds to `0.00,0.00`, and
 * nothing ever asks Open-Meteo for 1999 — so a smoke run cannot collide with,
 * or accidentally delete, anything the platform wrote. The 1999 timestamps
 * carry a second benefit: series and forecast-weather items get
 * `expiresAt = validTime + 90 days`, long past, so anything a crashed run
 * leaves behind is swept by DynamoDB's TTL rather than living forever.
 */
export const SMOKE_LOCATION = { latitude: 0, longitude: 0 };
export const SMOKE_DAY = '1999-01-01';
export const UNFETCHED_DAY = '1999-01-02';

const timestamp = (value: string): UtcIsoTimestamp => utcIsoTimestampSchema.parse(value);

export const HOUR_0 = timestamp(`${SMOKE_DAY}T00:00:00Z`);
export const HOUR_1 = timestamp(`${SMOKE_DAY}T01:00:00Z`);
export const HOUR_2 = timestamp(`${SMOKE_DAY}T02:00:00Z`);

export const smokeSite = (siteId: string): FleetSite =>
  fleetSiteSchema.parse({
    id: siteId,
    name: 'storage smoke test site',
    ...SMOKE_LOCATION,
    tiltDegrees: 35,
    azimuthDegrees: 180,
    capacityKw: 4,
    origin: 'user',
    createdAt: HOUR_0,
    active: true,
  });

export const smokeForecast = (
  siteId: string,
  validTime: UtcIsoTimestamp,
  model: ForecastModel,
): Forecast =>
  forecastSchema.parse({
    siteId,
    model,
    validTime,
    issuedAt: HOUR_0,
    weatherSource: 'open-meteo',
    poaIrradianceWm2: 120,
    acPowerKw: 1.5,
  });

export const smokeGeneration = (siteId: string, validTime: UtcIsoTimestamp): GenerationReading =>
  generationReadingSchema.parse({ siteId, validTime, acPowerKw: 1.2 });

const smokeWeather = (validTime: UtcIsoTimestamp, kind: WeatherReading['kind']): WeatherReading =>
  weatherReadingSchema.parse({
    ...SMOKE_LOCATION,
    validTime,
    kind,
    source: 'open-meteo',
    shortwaveRadiationWm2: 100,
    directRadiationWm2: 60,
    diffuseRadiationWm2: 40,
    directNormalIrradianceWm2: 80,
    temperature2mC: 12,
    windSpeed10mMs: 3,
    cloudCoverPct: 50,
  });

// `kind` is restated after the parse purely to narrow the type: the adapters
// take `kind`-narrowed readings so that a forecast reading cannot be handed to
// the archive writer, and a schema parse widens back to the union. Restating the
// literal is how that narrowing is recovered without a type assertion.
export const smokeArchiveReading = (validTime: UtcIsoTimestamp): ArchiveWeatherReading => ({
  ...smokeWeather(validTime, 'archive'),
  kind: 'archive',
});

export const smokeForecastReading = (validTime: UtcIsoTimestamp): ForecastWeatherReading => ({
  ...smokeWeather(validTime, 'forecast'),
  kind: 'forecast',
});
