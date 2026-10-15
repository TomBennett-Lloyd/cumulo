import {
  FLEET_ROLLUP_PARTITION,
  fleetActualsAggregatePointSchema,
  fleetActualsTotalSortKey,
  type FleetActualsAggregatePoint,
} from '@cumulo/shared';

import { SERIES_RETENTION_DAYS, TTL_ATTRIBUTE_NAME, expiresAtEpochSeconds } from '../../ttl';

import type { SeriesTableItem } from './series-item';

/**
 * The wire format of a **fleet actuals total** — one settled hour's fleet-wide actuals, summed once
 * and stored in the `#FLEET` partition beside the slices it summarises (ADR 0009's 2026-10-14
 * (#615) entry).
 *
 * Apart from `fleet-rollup-item.ts` because the payloads differ (`docs/standards/structure.md`
 * rule 7): a total carries no provenance and no `locationId`, since a settled hour has no writer to
 * check and no single location. It expires on the slices' clock.
 */
export type FleetActualsTotalItem = FleetActualsAggregatePoint & SeriesTableItem;

/** Domain total → stored item. Exported for its tests; not part of the package's public surface. */
export const toFleetActualsTotalItem = (
  point: FleetActualsAggregatePoint,
): FleetActualsTotalItem => ({
  ...point,
  siteId: FLEET_ROLLUP_PARTITION,
  sk: fleetActualsTotalSortKey(point.validTime),
  [TTL_ATTRIBUTE_NAME]: expiresAtEpochSeconds(point.validTime, SERIES_RETENTION_DAYS),
});

/**
 * Stored item → domain total; the parse strips the key attributes, and an item that does not parse
 * throws, for `fromFleetRollupItem`'s reason.
 */
export const fromFleetActualsTotalItem = (
  item: Record<string, unknown>,
): FleetActualsAggregatePoint => fleetActualsAggregatePointSchema.parse(item);
