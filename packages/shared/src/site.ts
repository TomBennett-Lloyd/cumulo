import { z } from 'zod';

import { utcIsoTimestampSchema } from './timestamp';

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

/**
 * A site as a *caller* proposes it: every domain field of {@link siteSchema},
 * minus the `id`.
 *
 * The id is the server's to assign, so it cannot be part of the request — a
 * client that predicts an id is a client that can collide with, or overwrite,
 * something it did not create. Derived with `.omit` rather than redeclared so
 * the physics bounds have exactly one definition (`architecture.md` rule 2):
 * the Fleet API's request validation (#14), the add-site form (#17) and the
 * in-memory demo source all validate against this same schema, and a bound
 * changed in `siteSchema` changes all three at once.
 */
export const createSiteInputSchema = siteSchema.omit({ id: true });

export type CreateSiteInput = z.infer<typeof createSiteInputSchema>;

/**
 * The physics parameters the forecast chain needs for one site: every field the
 * model reads, and nothing it does not.
 *
 * Derived by omission rather than redeclared, so the bounds have one home
 * (`architecture.md` rule 2). The omitted field is exactly the one the
 * `by-location` index does not project — `name` — which makes this schema the
 * compile-time mirror of the INCLUDE projection in `infra/storage/tables.tf`.
 * If that projection changes, this line changes with it.
 *
 * It lives here rather than in `@cumulo/storage` because two services now need
 * it and neither may import the other: the storage adapter parses the projected
 * index items into it (ADR 0002 access pattern F1), and the forecast service
 * takes it as the input to `createPhysicsForecast`. A full `Site` is
 * structurally assignable to it, so callers holding one need no conversion.
 */
export const sitePhysicsSchema = siteSchema.omit({ name: true });

export type SitePhysics = z.infer<typeof sitePhysicsSchema>;

/**
 * How a site joined the fleet.
 *
 * This is not decoration: ADR 0002 makes `origin` the basis of a structural
 * exemption. The `user-sites-by-age` index is written only for `user` sites, so
 * the seed fleet is invisible to eviction (#29) as a property of the data
 * model rather than of a filter a later change could forget.
 */
export const siteOriginSchema = z.enum(['seed', 'user']);

export type SiteOrigin = z.infer<typeof siteOriginSchema>;

/**
 * A site as the fleet control plane holds it — the domain attributes ADR 0002
 * stores in `cumulo-sites` alongside the `siteSchema` fields.
 *
 * - `origin` — see {@link siteOriginSchema}
 * - `createdAt` — the eviction order for user sites (#29), and the reason
 *   `gsiCreatedAt` sorts the way it does
 * - `active` — whether the forecast cycle should still fetch weather for this
 *   site; an inactive site is structurally absent from the `by-location` index
 *   rather than filtered out of its results
 *
 * Derived with `.extend` rather than redeclared, so the physics fields have
 * exactly one definition (architecture rule 2). No key attribute appears here:
 * `pk`, `locationId` and the `gsi*` attributes are computed by the storage
 * adapter from these fields and never round-trip as domain data.
 */
export const fleetSiteSchema = siteSchema.extend({
  origin: siteOriginSchema,
  createdAt: utcIsoTimestampSchema,
  active: z.boolean(),
});

export type FleetSite = z.infer<typeof fleetSiteSchema>;
