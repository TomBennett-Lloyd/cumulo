import { z } from 'zod';

/**
 * A single rooftop PV installation in the fleet.
 *
 * Conventions:
 * - tilt: degrees from horizontal — 0 = flat, 90 = vertical
 * - azimuth: degrees clockwise from true north — 180 = due south; 360 normalizes to 0
 * - capacity: nameplate DC kilowatts; upper bound is a sanity cap for residential rooftops
 */
export const siteSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(120),
  latitude: z.number().gte(-90).lte(90),
  longitude: z.number().gte(-180).lte(180),
  tiltDegrees: z.number().gte(0).lte(90),
  azimuthDegrees: z.number().gte(0).lt(360),
  capacityKw: z.number().positive().lte(50),
});

export type Site = z.infer<typeof siteSchema>;
