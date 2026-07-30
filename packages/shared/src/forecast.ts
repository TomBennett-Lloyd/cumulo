import { z } from 'zod';

import { utcIsoTimestampSchema } from './timestamp';
import { weatherSourceSchema } from './weather-source';

/**
 * Which model produced a forecast.
 *
 * ADR 0002 makes this a discriminator rather than a separate schema per model:
 * one `forecastSchema` serves both variants, and the same value later appears in
 * series identifiers and error-metric keys, so physics and ML results stay
 * directly comparable instead of living in parallel shapes.
 */
export const forecastModelSchema = z.enum(['physics', 'ml']);

export type ForecastModel = z.infer<typeof forecastModelSchema>;

/**
 * An uncertainty band around a forecast's point estimate.
 *
 * The refine sits on this nested object rather than on the forecast as a whole,
 * so `forecastSchema` stays a plain `ZodObject` and remains extensible via
 * `.extend()` / `.pick()` (a top-level `.refine()` would erase those).
 */
const uncertaintyBandSchema = z
  .object({
    p10AcPowerKw: z.number().gte(0),
    p90AcPowerKw: z.number().gte(0),
  })
  .refine((band) => band.p10AcPowerKw <= band.p90AcPowerKw, {
    message: 'p10AcPowerKw must not exceed p90AcPowerKw',
    path: ['p10AcPowerKw'],
  });

/**
 * A single-hour PV output forecast for one site, from one model.
 *
 * Conventions:
 * - `validTime` is the hour-ending instant: `acPowerKw` and `poaIrradianceWm2`
 *   are means over the preceding hour, matching the radiation semantics of the
 *   weather readings the forecast is derived from
 * - `issuedAt` records the forecast vintage. ADR 0002 collapses the issue-time
 *   axis — a later cycle overwrites the point for the same site/model/validTime,
 *   and `issuedAt` is what tells you which cycle you are looking at
 * - no ordering constraint holds between `issuedAt` and `validTime`: hindcast
 *   replays legitimately issue forecasts for instants already in the past
 * - `acPowerKw`'s 50 kW cap mirrors `siteSchema.capacityKw`'s residential sanity
 *   cap, because output is clipped at nameplate (ADR 0003)
 * - `poaIrradianceWm2` is plane-of-array irradiance in W/m²; 2000 is a sanity
 *   ceiling well above terrestrial peak including edge-of-cloud enhancement
 * - `weatherSource` propagates provenance from the weather input so the UI can
 *   render the mandatory Open-Meteo credit on forecast displays too
 * - `uncertainty` is optional because physics v1 (#12) emits point estimates.
 *   When present it carries both quantiles: a half-band is not representable.
 */
export const forecastSchema = z.object({
  siteId: z.uuid(),
  model: forecastModelSchema,
  validTime: utcIsoTimestampSchema,
  issuedAt: utcIsoTimestampSchema,
  weatherSource: weatherSourceSchema,
  poaIrradianceWm2: z.number().gte(0).lte(2000),
  acPowerKw: z.number().gte(0).lte(50),
  uncertainty: uncertaintyBandSchema.optional(),
});

export type Forecast = z.infer<typeof forecastSchema>;
