import { z } from 'zod';

import { MAX_PLAUSIBLE_RESIDENTIAL_KW } from './site';
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
 *
 * Both quantiles carry the same `0`–{@link MAX_PLAUSIBLE_RESIDENTIAL_KW} bounds
 * as `acPowerKw`: same quantity, same unit, same site, so a runaway ML p90 is
 * exactly what the cap is for.
 */
export const uncertaintyBandSchema = z
  .object({
    p10AcPowerKw: z.number().gte(0).lte(MAX_PLAUSIBLE_RESIDENTIAL_KW),
    p90AcPowerKw: z.number().gte(0).lte(MAX_PLAUSIBLE_RESIDENTIAL_KW),
  })
  .refine((band) => band.p10AcPowerKw <= band.p90AcPowerKw, {
    message: 'p10AcPowerKw must not exceed p90AcPowerKw',
    path: ['p10AcPowerKw'],
  });

/**
 * Exported in its own right, not as `NonNullable<Forecast['uncertainty']>`: fleet aggregation
 * consumes and produces band-shaped values detached from any one `Forecast`, and the derived
 * idiom names a field rather than a concept and cannot parse anything at runtime.
 */
export type UncertaintyBand = z.infer<typeof uncertaintyBandSchema>;

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
 * - `acPowerKw`'s cap *is* {@link MAX_PLAUSIBLE_RESIDENTIAL_KW}, the same
 *   constant bounding `siteSchema.capacityKw`, because output is clipped at
 *   nameplate (ADR 0003)
 * - `poaIrradianceWm2` is plane-of-array irradiance in W/m²; 2000 is a sanity
 *   ceiling well above terrestrial peak including edge-of-cloud enhancement.
 *   It is deliberately looser than the 1500 caps on the horizontal-component
 *   irradiances it is computed from (`weatherReadingSchema`): projecting onto a
 *   tilted plane concentrates beam irradiance by geometry, and cloud-edge
 *   enhancement stacks on top, so a legitimate POA value can exceed its inputs.
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
  acPowerKw: z.number().gte(0).lte(MAX_PLAUSIBLE_RESIDENTIAL_KW),
  uncertainty: uncertaintyBandSchema.optional(),
});

export type Forecast = z.infer<typeof forecastSchema>;
