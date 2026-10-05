import {
  FLEET_ROLLUP_PARTITION,
  fleetRollupPartialSchema,
  fleetRollupSortKey,
  type FleetRollupPartial,
  type SeriesKind,
} from '@cumulo/shared';

import { SERIES_RETENTION_DAYS, TTL_ATTRIBUTE_NAME, expiresAtEpochSeconds } from '../../ttl';

import type { SeriesItemKeys } from './series-item';

/**
 * The wire format of a **fleet roll-up partial** — one location's additive contribution to one hour
 * of the fleet aggregate, stored in `cumulo-series` under the `#FLEET` sentinel partition (ADR
 * 0009, #494).
 *
 * `series-item.ts` is this file's sibling and its opposite: that one stores one site's own points,
 * this one stores a number *about* a group of sites. They share the table, the TTL attribute and
 * the half-open-bound trick, and nothing else — which is why the two live apart rather than as a
 * third branch of `fromItem` (`docs/standards/structure.md` rule 7). A roll-up item has no
 * `issuedAt`, no `model` on the row and no domain schema of its own beyond the partial it carries.
 *
 * **What a location is, here.** `locationId` is the weather-grid bucket a site's coordinates round
 * into (`location.ts` in `@cumulo/shared`), which is also the unit one SQS message speaks for (ADR
 * 0004). So one producer invocation writes exactly one location's items, and no two invocations of
 * one cycle write the same key — the disjointness the sum at read depends on, made structural by
 * the key rather than defended by a lock.
 *
 * **Idempotent by key.** The sort key is derived from `(kind, validTime, locationId)` and every
 * write is a Put, so a redelivered SQS message rewrites byte-identical items. That is the same
 * property `consume-message.ts` already relies on for the forecasts themselves, extended to the
 * roll-up so that the roll-up inherits the redelivery policy instead of needing one of its own.
 *
 * **It expires with what it summarises.** `SERIES_RETENTION_DAYS` and `TTL_ATTRIBUTE_NAME` are the
 * series table's, taken from `ttl.ts` rather than restated, so an abandoned roll-up reaps on the
 * same 90-day clock as the per-site rows it was summed from — never outliving them, and never
 * leaving the `#FLEET` partition as the one thing in this table that grows for ever.
 */

/** The attributes a roll-up item carries beyond the partial itself. */
export interface FleetRollupItemKeys extends SeriesItemKeys {
  /** The `#FLEET` sentinel — this table's partition key, holding a value no site can own. */
  readonly siteId: string;
  /**
   * Which location this partial speaks for.
   *
   * Duplicated out of the sort key deliberately. The key is a string this package composes, and a
   * reader of a stored item — an operator in the console, a future actuals producer — should not
   * have to parse one to learn what the row is about. It is also why `storage-key.ts` declines to
   * offer an inverse of `fleetRollupSortKey`: nothing has to rediscover the location from the key,
   * because the attribute is right there.
   */
  readonly locationId: string;
}

export type FleetRollupItem = FleetRollupPartial & FleetRollupItemKeys;

/**
 * Domain partial → stored item.
 *
 * Exported for its tests; it is not part of the package's public surface.
 */
export const toFleetRollupItem = (
  kind: SeriesKind,
  locationId: string,
  partial: FleetRollupPartial,
): FleetRollupItem => ({
  ...partial,
  siteId: FLEET_ROLLUP_PARTITION,
  sk: fleetRollupSortKey(kind, partial.validTime, locationId),
  locationId,
  [TTL_ATTRIBUTE_NAME]: expiresAtEpochSeconds(partial.validTime, SERIES_RETENTION_DAYS),
});

/**
 * One stored item, and which location wrote it.
 *
 * The two travel together because the read needs both and for different jobs: the partials are what
 * `sumFleetRollupPartials` adds, and the location set is what tells the API whether the partition is
 * *complete* — whether every location the fleet has sites at has written yet (ADR 0009's fallback
 * condition). Returning only the partials would leave the route unable to tell a quiet fleet from a
 * half-written cycle, which is the one distinction the fallback exists to make.
 */
export interface FleetRollupRow {
  readonly locationId: string;
  readonly partial: FleetRollupPartial;
}

/**
 * Stored item → domain row.
 *
 * The partial is parsed rather than cast: a table is a boundary, so what comes back is `unknown`
 * until a schema has looked at it (`docs/standards/typing.md` rule 3), and it is the parse — not the
 * key — that restores the branded `UtcIsoTimestamp` on `validTime`. `locationId` is read off the
 * item for the same reason it is stored there.
 *
 * Both failure modes throw rather than returning a value, exactly as `series-item.ts`'s `fromItem`
 * does and for its reason: an item in this partition that does not parse means the table holds
 * something this code did not write, which is a violated invariant rather than an outcome a caller
 * could handle (`docs/standards/error-handling.md` rule 1). Neither is a `StorageError`, which means
 * "the call to AWS failed" and would send an operator looking in the wrong place.
 *
 * Exported for its tests; it is not part of the package's public surface.
 */
export const fromFleetRollupItem = (item: Record<string, unknown>): FleetRollupRow => {
  const { locationId } = item;
  if (typeof locationId !== 'string' || locationId === '') {
    throw new Error(
      `Fleet roll-up item has no locationId: ${JSON.stringify(locationId)} (sk ${JSON.stringify(item.sk)})`,
    );
  }

  return { locationId, partial: fleetRollupPartialSchema.parse(item) };
};
