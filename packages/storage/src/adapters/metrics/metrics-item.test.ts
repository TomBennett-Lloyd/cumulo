import { metricsSortKey } from '@cumulo/shared';
import { describe, expect, it } from 'vitest';

import { JULY_30, JULY_31, errorMetrics, mlItem, physicsItem } from './metrics-fixtures';
import { fromItem, metricsPeriodPrefix, toItem } from './metrics-item';

/**
 * The key logic carries the real risk here — the sort key the row is addressed
 * by, the prefix the side-by-side Query is built from, and what does *not*
 * survive the trip back into the domain — and all of it is pure, so it is pinned
 * directly on the wire-format functions rather than only through the adapter
 * (`docs/standards/testing.md` rule 2).
 */

describe('toItem', () => {
  it('adds the sort key and nothing else to the domain fields', () => {
    expect(toItem(errorMetrics())).toEqual(physicsItem);
    expect(
      toItem(errorMetrics({ model: 'ml', maeKw: 0.31, rmseKw: 0.48, skillScore: 0.46 })),
    ).toEqual(mlItem);
  });

  it('keeps the period as a map attribute rather than flattening it into keys', () => {
    const item = toItem(errorMetrics());

    expect(item.period).toEqual({
      startInclusive: '2026-07-30T00:00:00Z',
      endExclusive: '2026-07-31T00:00:00Z',
    });
  });

  it('derives the sort key from the row itself, so a stored row composes its own key', () => {
    const metrics = errorMetrics({ model: 'ml' });

    expect(toItem(metrics).sk).toBe(
      metricsSortKey(metrics.period, metrics.model, metrics.baseline),
    );
  });
});

describe('metricsPeriodPrefix', () => {
  it('ends at a delimiter, so a model segment can only ever match whole', () => {
    expect(metricsPeriodPrefix(JULY_30)).toBe('2026-07-30T00:00:00Z#2026-07-31T00:00:00Z#');
  });

  it('matches every model and baseline of its own period and no other period', () => {
    const prefix = metricsPeriodPrefix(JULY_30);

    for (const model of ['physics', 'ml'] as const) {
      expect(metricsSortKey(JULY_30, model, 'persistence-24h').startsWith(prefix)).toBe(true);
      expect(metricsSortKey(JULY_30, model, 'clear-sky').startsWith(prefix)).toBe(true);
      expect(metricsSortKey(JULY_31, model, 'persistence-24h').startsWith(prefix)).toBe(false);
    }
  });
});

describe('fromItem', () => {
  it('round-trips a domain value through the stored shape', () => {
    const metrics = errorMetrics({ skillScore: null });

    expect(fromItem(toItem(metrics))).toEqual(metrics);
  });

  it('returns no key attribute as a domain field', () => {
    expect(Object.keys(fromItem(physicsItem)).sort()).toEqual([
      'baseline',
      'computedAt',
      'maeKw',
      'model',
      'period',
      'rmseKw',
      'sampleCount',
      'siteId',
      'skillScore',
    ]);
  });

  it('throws on an item the schema does not recognise', () => {
    expect(() => fromItem({ ...physicsItem, maeKw: '0.42' })).toThrow();
    expect(() => fromItem({ ...physicsItem, period: undefined })).toThrow();
  });
});
