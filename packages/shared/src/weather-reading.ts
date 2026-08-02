import { z } from 'zod';

import { utcIsoTimestampSchema } from './timestamp';
import { weatherSourceSchema } from './weather-source';

/**
 * The sanity ceiling for a single irradiance reading, in watts per square metre —
 * the upper bound on all four irradiance fields of {@link weatherReadingSchema}
 * (`shortwaveRadiationWm2`, `directRadiationWm2`, `diffuseRadiationWm2`,
 * `directNormalIrradianceWm2`).
 *
 * The value sits deliberately above the ~1361 W/m² solar constant: cloud
 * enhancement produces genuine readings above the clear-sky maximum, and those
 * must pass. What the cap catches is an order-of-magnitude unit error, which
 * lands nowhere near it. One number covers all four fields because they are the
 * same physical quantity resolved onto different geometries — a single
 * implausibility threshold governs them all, and lowering it narrows all four
 * bounds in step, which is the point.
 *
 * The tests deliberately pin `1500` and `1501` as *literals* rather than deriving
 * them from this constant. Probe values derived from the constant would move with
 * it, so a typo'd `15000` would leave every test green; the literals make any
 * change to this value go red. The pins are `weather-reading.test.ts` — four
 * `1501` rejection rows in `outOfRangeCases` and four `1500` boundary-acceptance
 * rows in `boundaryCases` — and, across the package boundary,
 * `apps/forecast/src/consume-message.test.ts`, whose at-cap fixture in the
 * "converts a physics invariant violation into a failed outcome" test needs
 * readings that are schema-valid at exactly the cap. If you are changing this
 * value, that double-touch is the intended friction, not a failure — update the
 * pins deliberately.
 */
export const MAX_PLAUSIBLE_IRRADIANCE_WM2 = 1500;

/**
 * One hour of weather for one location — the input the PV physics model runs on.
 *
 * Field names are the Open-Meteo hourly variable names, camel-cased and suffixed
 * with their unit: `shortwave_radiation` → `shortwaveRadiationWm2`,
 * `temperature_2m` → `temperature2mC`, `wind_speed_10m` → `windSpeed10mMs`,
 * `cloud_cover` → `cloudCoverPct`. Keeping the provider's names visible means the
 * mapping in ingestion (#11) is a rename, not a translation nobody can check.
 *
 * Time semantics differ per field, and conflating them is a real forecasting bug:
 * - radiation (`shortwaveRadiationWm2`, `directRadiationWm2`,
 *   `diffuseRadiationWm2`, `directNormalIrradianceWm2`) are Open-Meteo
 *   *preceding-hour means* — the average over the hour **ending** at `validTime`,
 *   not an instantaneous value at it
 * - `temperature2mC`, `windSpeed10mMs` and `cloudCoverPct` are instantaneous
 *   conditions **at** `validTime`
 *
 * Open-Meteo returns designator-less local-format times (`2026-07-30T00:00`),
 * local to the requested timezone. Ingestion normalizes those to this schema's
 * fixed-width UTC form (`2026-07-30T00:00:00Z`) before parsing; nothing
 * downstream ever sees the provider's format.
 *
 * Location is carried as coordinates. ADR 0002's `cumulo-weather` partition key
 * `locationId` (latitude/longitude rounded to 2 dp) is derived from them by the
 * storage adapter — no key attribute is a schema field.
 */
export const weatherReadingSchema = z.object({
  latitude: z.number().gte(-90).lte(90),
  longitude: z.number().gte(-180).lte(180),
  validTime: utcIsoTimestampSchema,
  /**
   * Predicted vs historical-archive reading. This is the distinction ADR 0002
   * calls "source" in the `cumulo-weather` sort key (`FORECAST#T#…` /
   * `ARCHIVE#T#…`); here `source` means provenance, so the axis is named `kind`
   * and the adapter maps `kind` → that sort-key segment.
   */
  kind: z.enum(['forecast', 'archive']),
  source: weatherSourceSchema,
  // Irradiance, W/m²; ceiling owned by {@link MAX_PLAUSIBLE_IRRADIANCE_WM2}.
  shortwaveRadiationWm2: z.number().gte(0).lte(MAX_PLAUSIBLE_IRRADIANCE_WM2),
  directRadiationWm2: z.number().gte(0).lte(MAX_PLAUSIBLE_IRRADIANCE_WM2),
  diffuseRadiationWm2: z.number().gte(0).lte(MAX_PLAUSIBLE_IRRADIANCE_WM2),
  directNormalIrradianceWm2: z.number().gte(0).lte(MAX_PLAUSIBLE_IRRADIANCE_WM2),
  // Degrees Celsius; the bounds bracket recorded terrestrial extremes
  // (~-89 °C Vostok, ~57 °C Furnace Creek) with a little headroom.
  temperature2mC: z.number().gte(-90).lte(60),
  // Metres per second. The 120 cap is a sanity ceiling only — above any recorded
  // surface gust — and explicitly does NOT catch a unit mistake: Open-Meteo
  // defaults to km/h, and ordinary wind (5–40 km/h) parses cleanly as 5–40 m/s,
  // feeding the Faiman cell-temperature term a silent ~3.6× error. The cap only
  // bites above 120 km/h. The actual defence is ingestion (#11) pinning
  // `wind_speed_unit=ms` in the request, proven by an adapter fixture test.
  windSpeed10mMs: z.number().gte(0).lte(120),
  // Total cloud cover, percent. The physics core does not use it — irradiance
  // already carries the cloud effect — but the ML correction layer (#20) and the
  // UI do, and it is unrecoverable for past live cycles if not stored now.
  cloudCoverPct: z.number().gte(0).lte(100),
});

export type WeatherReading = z.infer<typeof weatherReadingSchema>;

/**
 * The two halves of the `kind` axis, each fixed to one literal — the shape a
 * module produces or consumes when it only ever deals in one of them: ingestion's
 * forecast adapter, the hindcast's archive adapter, and the storage adapter's two
 * write paths, which use different sort-key prefixes and different TTLs.
 *
 * They live here, beside the schema they narrow, because they are the same domain
 * concept (`architecture.md` rule 2) — a narrowing restated per consumer would be
 * three definitions to keep in step. Types are inferred rather than written, so
 * the schema stays the single source of truth (`typing.md` rule 3).
 *
 * The narrowing is a compile-time obligation, not a runtime branch: handing a
 * forecast writer archive readings should be a type error rather than a `kind`
 * check nobody exercises.
 */
export const forecastWeatherReadingSchema = weatherReadingSchema.extend({
  kind: z.literal('forecast'),
});
export type ForecastWeatherReading = z.infer<typeof forecastWeatherReadingSchema>;

export const archiveWeatherReadingSchema = weatherReadingSchema.extend({
  kind: z.literal('archive'),
});
export type ArchiveWeatherReading = z.infer<typeof archiveWeatherReadingSchema>;
