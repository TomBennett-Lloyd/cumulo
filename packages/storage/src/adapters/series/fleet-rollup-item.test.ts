import { FLEET_ROLLUP_FORECAST_KIND } from '@cumulo/shared';
import { describe, expect, it } from 'vitest';

import { fromFleetRollupItem, toFleetRollupItem } from './fleet-rollup-item';
import { EXPIRES_AT_14H, LOCATION_ID, partial, rollupItem14h } from './series-fixtures';

/**
 * The roll-up item's wire shape, asserted against fixtures written out literally in
 * `series-fixtures.ts` rather than produced by the code under test — a fixture that agreed with the
 * builder by construction would prove nothing about what lands in DynamoDB.
 */

describe('toFleetRollupItem', () => {
  it('wraps a partial in the sentinel partition, the roll-up sort key and the series TTL', () => {
    expect(toFleetRollupItem(FLEET_ROLLUP_FORECAST_KIND, LOCATION_ID, partial())).toEqual(
      rollupItem14h,
    );
  });

  it('keys the actuals kind apart from the forecast kind at the same hour', () => {
    const generation = toFleetRollupItem({ kind: 'generation' }, LOCATION_ID, partial());

    expect(generation.sk).toBe(`GEN#T#2026-07-30T14:00:00Z#L#${LOCATION_ID}`);
    expect(generation.sk).not.toBe(rollupItem14h.sk);
  });

  it('is deterministic in its inputs, so a redelivered message rewrites identical items', () => {
    const first = toFleetRollupItem(FLEET_ROLLUP_FORECAST_KIND, LOCATION_ID, partial());
    const second = toFleetRollupItem(FLEET_ROLLUP_FORECAST_KIND, LOCATION_ID, partial());

    expect(first).toEqual(second);
  });

  it('expires a partial on the same clock as the rows it was summed from', () => {
    // 2026-07-30T14:00:00Z + 90 days, the same figure `series-fixtures.ts` pins for a forecast at
    // that hour — the point being that the roll-up inherits the retention rather than declaring one.
    expect(toFleetRollupItem(FLEET_ROLLUP_FORECAST_KIND, LOCATION_ID, partial()).expiresAt).toBe(
      EXPIRES_AT_14H,
    );
  });
});

describe('fromFleetRollupItem', () => {
  it('parses a stored item back into its location and its partial, key attributes stripped', () => {
    expect(fromFleetRollupItem(rollupItem14h)).toEqual({
      locationId: LOCATION_ID,
      partial: partial(),
    });
  });

  it('round-trips a partial through the item shape unchanged', () => {
    const original = partial({ acPowerKw: 7.25, hasUncertainty: false, contributingSiteCount: 3 });

    const item = toFleetRollupItem(FLEET_ROLLUP_FORECAST_KIND, LOCATION_ID, original);

    // Spread, because the round trip is through DynamoDB: what `fromFleetRollupItem` is handed on
    // the way back is a plain bag of attributes, not the declared item type.
    expect(fromFleetRollupItem({ ...item }).partial).toEqual(original);
  });

  it('throws on an item with no locationId rather than inventing one', () => {
    // Spelled as an override rather than a destructured omission: the failing item is one whose
    // `locationId` attribute is absent, and `undefined` is how DynamoDB's document client hands
    // back an attribute that was never written.
    expect(() => fromFleetRollupItem({ ...rollupItem14h, locationId: undefined })).toThrow(
      /no locationId/u,
    );
  });

  it('throws on a partial that does not parse rather than summing a NaN into the fleet', () => {
    expect(() => fromFleetRollupItem({ ...rollupItem14h, acPowerKw: 'lots' })).toThrow();
  });

  it('refuses a non-finite power, which would poison every hour it touched', () => {
    expect(() =>
      fromFleetRollupItem({ ...rollupItem14h, contributingCapacityKw: Number.POSITIVE_INFINITY }),
    ).toThrow();
  });

  it('refuses a fractional site count', () => {
    expect(() => fromFleetRollupItem({ ...rollupItem14h, contributingSiteCount: 2.5 })).toThrow();
  });
});
