import { z } from 'zod';

import { utcIsoTimestampSchema } from './timestamp';
import { weatherSourceSchema } from './weather-source';

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
  // Irradiance, W/m². The 1500 cap sits above the ~1361 W/m² solar constant so
  // that cloud-enhancement spikes — genuine readings above clear-sky maximum —
  // pass, while an order-of-magnitude unit error does not.
  shortwaveRadiationWm2: z.number().gte(0).lte(1500),
  directRadiationWm2: z.number().gte(0).lte(1500),
  diffuseRadiationWm2: z.number().gte(0).lte(1500),
  directNormalIrradianceWm2: z.number().gte(0).lte(1500),
  // Degrees Celsius; the bounds bracket recorded terrestrial extremes
  // (~-89 °C Vostok, ~57 °C Furnace Creek) with a little headroom.
  temperature2mC: z.number().gte(-90).lte(60),
  // Metres per second. Open-Meteo defaults to km/h, so ingestion (#11) must
  // request `wind_speed_unit=ms`; the 120 m/s cap is above any recorded surface
  // gust, so a km/h response would fail here rather than silently model as wind.
  windSpeed10mMs: z.number().gte(0).lte(120),
  // Total cloud cover, percent. The physics core does not use it — irradiance
  // already carries the cloud effect — but the ML correction layer (#20) and the
  // UI do, and it is unrecoverable for past live cycles if not stored now.
  cloudCoverPct: z.number().gte(0).lte(100),
});

export type WeatherReading = z.infer<typeof weatherReadingSchema>;
