import { z } from 'zod';

import { locationId } from './location';
import type { SitePhysics } from './site';
import { utcIsoTimestampSchema } from './timestamp';

/**
 * What a `#FLEET` slice was summed from — which sites, with which physics, as of which forecast run
 * — so a reader can tell a stale slice from a fresh one (#602, ADR 0009's 2026-10-07 amendment).
 *
 * It lives beside the partial and never inside it: `fleetRollupPartialSchema` may only carry
 * additive per-hour totals (`fleet-rollup.ts`), and neither a membership nor a vintage adds.
 */

const FNV64_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const UINT64_MASK = 0xffffffffffffffffn;
const MEMBERS_HEX_LENGTH = 16;

/**
 * FNV-1a, 64-bit, over UTF-16 code units. Not cryptographic and not asked to be: the property it
 * owes is byte-identical output in Node and the browser, which `BigInt` arithmetic gives.
 */
const fnv1a64Hex = (text: string): string => {
  let hash = FNV64_OFFSET_BASIS;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash ^ BigInt(text.charCodeAt(index))) * FNV64_PRIME) & UINT64_MASK;
  }
  return hash.toString(16).padStart(MEMBERS_HEX_LENGTH, '0');
};

/** A {@link fleetRollupMembers} digest, branded so a free string cannot stand in for one. */
export const fleetRollupMembersSchema = z
  .string()
  .regex(/^[0-9a-f]{16}$/u)
  .brand<'FleetRollupMembers'>();

export type FleetRollupMembers = z.infer<typeof fleetRollupMembersSchema>;

/**
 * The membership digest of one location's sites: the sorted `(id, capacityKw, tiltDegrees,
 * azimuthDegrees, locationId)` tuples, hashed. Order-independent, and any field of any tuple moving
 * moves it — so a delete, an eviction, a delete-plus-add in one bucket, a resize or a re-tilt
 * through `PUT /v1/sites/{siteId}` all read as a different fleet (`fleet-rollup-provenance.test.ts`).
 *
 * Takes `SitePhysics` because that is what the producer lists; `FleetSite` is a superset, so the
 * reader computes the same digest from the listing it already holds.
 */
export const fleetRollupMembers = (sites: readonly SitePhysics[]): FleetRollupMembers => {
  // Code-unit order rather than `localeCompare`, whose collation is the runtime's ICU data's.
  const tuples = [...sites]
    .sort((left, right) => Number(left.id > right.id) - Number(left.id < right.id))
    .map((site) => [
      site.id,
      site.capacityKw,
      site.tiltDegrees,
      site.azimuthDegrees,
      locationId(site),
    ]);
  return fleetRollupMembersSchema.parse(fnv1a64Hex(JSON.stringify(tuples)));
};

/**
 * The provenance one slice carries: its {@link fleetRollupMembers} digest, and the `issuedAt` of the
 * forecast run it was summed from. A schema because it round-trips through DynamoDB
 * (`docs/standards/typing.md` rule 3).
 */
export const fleetRollupProvenanceSchema = z.object({
  members: fleetRollupMembersSchema,
  issuedAt: utcIsoTimestampSchema,
});

export type FleetRollupProvenance = z.infer<typeof fleetRollupProvenanceSchema>;
