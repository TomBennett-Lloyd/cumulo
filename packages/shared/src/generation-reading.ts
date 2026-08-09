import { z } from 'zod';

import { MAX_PLAUSIBLE_RESIDENTIAL_KW } from './site';
import { utcIsoTimestampSchema } from './timestamp';

/**
 * An observed generation actual for one site and one hour — or a simulated one,
 * since the fleet has no real telemetry feed (see #19); the schema is identical
 * either way. Live mode serves simulated readings: `simulatedActualFromForecast`
 * (`simulated-actual.ts`) derives them from the stored physics forecast for the
 * same hour, so nothing measured is ever claimed (#264).
 *
 * Conventions:
 * - validTime: hour-ending — `14:00:00Z` labels the hour from 13:00 to 14:00
 * - acPowerKw: mean AC power over that preceding hour, in kilowatts; the upper
 *   bound is {@link MAX_PLAUSIBLE_RESIDENTIAL_KW}, the same constant that caps
 *   `siteSchema.capacityKw`
 *
 * Quantity, unit and time semantics are deliberately identical to
 * `forecastSchema.acPowerKw`, so a forecast and its actual interleave directly
 * in ADR 0002's `series` table (access pattern A4) and are comparable without
 * conversion — an error metric is a subtraction, not a unit negotiation.
 *
 * There is no provenance field, and its absence is a modelling choice rather
 * than an oversight the simulation exposed. A reading claims one thing —
 * power-at-time — which is the whole of what a meter at the site would claim;
 * there is no upstream weather model for the row itself to attribute. Whether
 * the fleet's readings are measured or simulated is a fact about the deployment
 * rather than about any one hour, so it is stated once where a reader meets it:
 * the UI's labels, and `FleetActualsResponse`'s description in the published
 * OpenAPI document. A per-row field would restate that deployment fact once per
 * site-hour, and would let two rows of the same fleet disagree about it.
 */
export const generationReadingSchema = z.object({
  siteId: z.uuid(),
  validTime: utcIsoTimestampSchema,
  acPowerKw: z.number().gte(0).lte(MAX_PLAUSIBLE_RESIDENTIAL_KW),
});

export type GenerationReading = z.infer<typeof generationReadingSchema>;
