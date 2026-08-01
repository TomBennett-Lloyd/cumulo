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

/**
 * How many `user`-origin sites the fleet holds before adding one evicts the
 * oldest.
 *
 * A public, anonymous add-a-site path needs a ceiling that is a number rather
 * than a hope, and this number is argued from the one hard external constraint
 * this project has — Open-Meteo's 10,000 calls/day (CLAUDE.md). Worst case at
 * every step:
 *
 * - the seed fleet is 60 sites over 12 locations (`generateFleet` at
 *   `canonicalFleetSeed`), co-located by construction so a cluster costs one
 *   fetch;
 * - a user site lands wherever its caller chose, so the worst case is 40
 *   distinct buckets — **≤ 52 locations, ≤ 100 sites**;
 * - 52 locations at the hourly cadence is `52 × 24 = 1,248` calls/day, **12% of
 *   the allowance**, leaving the rest for #16's archive backfill and for the
 *   retry each fetch is allowed;
 * - 52 sits well under ingestion's own `MAX_LOCATIONS_PER_CYCLE` (100), so a
 *   full fleet never defers a location;
 * - 100 sites is exactly the row ADR 0002's fleet-headroom table prices, at 14%
 *   of the free write allowance.
 *
 * Two properties this constant relies on rather than states. The cap is applied
 * atomically in storage — a counter item conditioned on this value inside the
 * same transaction as the write (ADR 0002) — not by a read-then-write, which
 * two concurrent creates would both pass. And the seed fleet is exempt from
 * eviction *structurally*: only `user` sites are written to the
 * `user-sites-by-age` index, so eviction cannot see a seed site to choose it
 * ({@link siteOriginSchema}).
 *
 * `site.test.ts` holds the arithmetic above against the **generated** fleet, so
 * a seed fleet that grows — or a jitter box widened until a cluster stops being
 * one bucket — fails there rather than at the quota.
 */
export const MAX_USER_SITES = 40;
