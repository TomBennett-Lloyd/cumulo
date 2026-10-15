import { describe, expect, it } from 'vitest';

import { fromFleetActualsTotalItem, toFleetActualsTotalItem } from './fleet-actuals-total-item';
import { EXPIRES_AT_14H, rollupItem14h, totalItem14h, totalPoint14h } from './series-fixtures';

/**
 * The total item's wire shape, asserted against fixtures written out literally in
 * `series-fixtures.ts` for `fleet-rollup-item.test.ts`'s reason.
 */

describe('toFleetActualsTotalItem', () => {
  it('wraps a total in the sentinel partition, the total sort key and the series TTL', () => {
    const item = toFleetActualsTotalItem(totalPoint14h);

    expect(item.siteId).toBe('#FLEET');
    expect(item.sk).toBe('GEN#TOTAL#T#2026-07-30T14:00:00Z#FLEET');
    expect(item.expiresAt).toBe(EXPIRES_AT_14H);
    expect(item).toEqual(totalItem14h);
  });

  it('carries the four point fields and nothing else beyond the keys', () => {
    expect(Object.keys(toFleetActualsTotalItem(totalPoint14h)).sort()).toEqual([
      'acPowerKw',
      'contributingCapacityKw',
      'contributingSiteCount',
      'expiresAt',
      'siteId',
      'sk',
      'validTime',
    ]);
  });
});

describe('fromFleetActualsTotalItem', () => {
  it('round-trips a total, key attributes stripped', () => {
    expect(fromFleetActualsTotalItem({ ...toFleetActualsTotalItem(totalPoint14h) })).toEqual(
      totalPoint14h,
    );
  });

  it('is no larger on the wire than a slice, which is what prices a total at a slice', () => {
    expect(JSON.stringify(toFleetActualsTotalItem(totalPoint14h)).length).toBeLessThan(
      JSON.stringify(rollupItem14h).length,
    );
  });

  it('throws on an item it did not write', () => {
    expect(() => fromFleetActualsTotalItem({ sk: 'x' })).toThrow();
  });
});
