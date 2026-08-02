import { z } from 'zod';

import { MAX_PLAUSIBLE_RESIDENTIAL_KW } from './site';
import { utcIsoTimestampSchema } from './timestamp';

/**
 * An observed generation actual for one site and one hour — or a simulated one,
 * since the fleet has no real telemetry feed (see #19); the schema is identical
 * either way.
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
 * There is no provenance field: generation is measured at the site, not derived
 * from a weather provider, so there is no upstream model to attribute.
 */
export const generationReadingSchema = z.object({
  siteId: z.uuid(),
  validTime: utcIsoTimestampSchema,
  acPowerKw: z.number().gte(0).lte(MAX_PLAUSIBLE_RESIDENTIAL_KW),
});

export type GenerationReading = z.infer<typeof generationReadingSchema>;
