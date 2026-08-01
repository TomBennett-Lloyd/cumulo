import {
  canonicalFleetSeed,
  fleetSiteSchema,
  generateFleet,
  utcIsoTimestampSchema,
  type FleetSite,
} from '@cumulo/shared';

/**
 * The canonical demo fleet as `cumulo-sites` rows: `generateFleet`'s physics
 * plus the three fleet attributes ADR 0002 stores alongside them.
 *
 * Pure and separate from the entry point so the properties the seed relies on
 * are pinned by `pnpm test` rather than discovered against a live table. The
 * one that matters most is not about this file at all: a `seed`-origin site is
 * never written to the `user-sites-by-age` index, which is what makes the demo
 * fleet unevictable by #29's cap machinery — a property of the data model, so
 * `seed-sites.test.ts` asserts it through `toItem` rather than trusting prose.
 */

/**
 * The creation instant every seed site carries.
 *
 * Fixed rather than `new Date()` because seeding must be idempotent: `putFleetSite`
 * is a plain overwrite, so a second run has to produce byte-identical items or it
 * silently rewrites 60 rows with new timestamps every time an operator re-seeds.
 * The value is the date {@link canonicalFleetSeed} encodes (20260730), so the
 * fleet's identity and its birthday tell the same story.
 *
 * `createdAt` is otherwise the eviction order for user sites. Seed sites are
 * outside that ordering entirely, so sharing one instant across all 60 costs
 * nothing: nothing ever sorts them.
 */
export const SEED_CREATED_AT = utcIsoTimestampSchema.parse('2026-07-30T00:00:00Z');

/**
 * The 60 canonical sites, ready to write.
 *
 * Deterministic in both halves — `generateFleet` draws from an explicit PRNG and
 * every attribute added here is a constant — so two calls are deeply equal and
 * re-seeding is an overwrite with the same bytes.
 */
export const buildSeedFleet = (): readonly FleetSite[] =>
  generateFleet(canonicalFleetSeed).map((site) =>
    fleetSiteSchema.parse({
      ...site,
      origin: 'seed',
      createdAt: SEED_CREATED_AT,
      active: true,
    }),
  );
