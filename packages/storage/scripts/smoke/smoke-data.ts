import {
  errorMetricsSchema,
  fleetSiteSchema,
  forecastSchema,
  generationReadingSchema,
  utcIsoTimestampSchema,
  weatherReadingSchema,
  PERSISTENCE_24H,
} from '@cumulo/shared';
import type {
  ArchiveWeatherReading,
  ErrorMetrics,
  FleetSite,
  Forecast,
  ForecastModel,
  ForecastWeatherReading,
  GenerationReading,
  UtcIsoTimestamp,
  UtcWindow,
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
 * `expiresAt = validTime + 90 days`, long past, so what a crashed run leaves on
 * those two tables is swept by DynamoDB's TTL rather than living forever. Abuse
 * rows are swept as well — every row on that table carries an `expiresAt`, and
 * the checks set theirs minutes rather than decades ahead.
 *
 * Metrics rows are the honest exception. `cumulo-metrics` declares no TTL at
 * all (`infra/storage/tables.tf`, table 4) because metrics are the published
 * evidence the model comparison rests on and must never expire — so a crashed
 * run's metrics residue survives under that run's random `siteId` partition
 * until somebody removes it by hand. The teardown is the only thing that
 * removes it, which is why it runs in a `finally`.
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

/**
 * The client address a smoke run limits against.
 *
 * Derived from the run's own random `siteId` so two runs against one stack
 * cannot count each other's requests into the same window, and free of `#`,
 * which `requireAddress` in `src/adapters/abuse/abuse-item.ts` rejects because
 * it is the key delimiter. The `smoke-` prefix keeps it obviously not an IP, so
 * a row seen by hand in the console is identifiable as this script's.
 */
export const smokeAbuseAddress = (siteId: string): string => `smoke-${siteId}`;

/**
 * The fixed rate window a smoke run counts into.
 *
 * Derived from `HOUR_0` rather than read off the clock for the same reason
 * every other value here is a constant: the teardown has to rebuild this row's
 * key without the checks threading it there, and a window start captured at run
 * time would have to become state passed between modules.
 */
export const SMOKE_RATE_WINDOW_START_EPOCH_SECONDS = Math.floor(Date.parse(HOUR_0) / 1000);

/** The evaluation window a smoke run scores: the two smoke hours, half-open. */
export const SMOKE_METRICS_PERIOD: UtcWindow = {
  startInclusive: HOUR_0,
  endExclusive: HOUR_2,
};

/** The one baseline the metrics schema admits, named once for the checks and the teardown. */
export const SMOKE_METRICS_BASELINE = PERSISTENCE_24H;

/**
 * One evaluation result, per model.
 *
 * `maeKw` varies by model on purpose: the period query asserts both rows with a
 * deep-equal, and identical rows would let a query that returned one row twice
 * pass an assertion that is about `begins_with` returning both.
 */
export const smokeErrorMetrics = (siteId: string, model: ForecastModel): ErrorMetrics =>
  errorMetricsSchema.parse({
    siteId,
    model,
    period: SMOKE_METRICS_PERIOD,
    baseline: SMOKE_METRICS_BASELINE,
    maeKw: model === 'ml' ? 0.31 : 0.42,
    rmseKw: 0.61,
    skillScore: 0.27,
    sampleCount: 2,
    computedAt: HOUR_2,
  });
