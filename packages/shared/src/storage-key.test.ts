import { describe, expect, it } from 'vitest';

import {
  archiveDayMarkerSortKey,
  metricsSortKey,
  parseSeriesSortKey,
  seriesSortKey,
  weatherSortKey,
  type SeriesKind,
} from './storage-key';
import { utcIsoTimestampSchema, type UtcIsoTimestamp } from './timestamp';

const at = (instant: string): UtcIsoTimestamp => utcIsoTimestampSchema.parse(instant);

const NOON = at('2026-07-30T12:00:00Z');
const ONE_PM = at('2026-07-30T13:00:00Z');
const TWO_PM = at('2026-07-30T14:00:00Z');

/**
 * Compares by UTF-16 code unit, the order DynamoDB sorts string sort keys in —
 * `localeCompare` would answer a different, locale-dependent question.
 */
const byCodeUnit = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
};

const allKinds: SeriesKind[] = [
  { kind: 'forecast', model: 'physics' },
  { kind: 'forecast', model: 'ml' },
  { kind: 'generation' },
];

describe('seriesSortKey', () => {
  it('renders a physics forecast key', () => {
    expect(seriesSortKey(TWO_PM, { kind: 'forecast', model: 'physics' })).toBe(
      'T#2026-07-30T14:00:00Z#FC#physics',
    );
  });

  it('renders an ml forecast key', () => {
    expect(seriesSortKey(TWO_PM, { kind: 'forecast', model: 'ml' })).toBe(
      'T#2026-07-30T14:00:00Z#FC#ml',
    );
  });

  it('renders a generation key', () => {
    expect(seriesSortKey(TWO_PM, { kind: 'generation' })).toBe('T#2026-07-30T14:00:00Z#GEN');
  });

  it('orders by time before kind, so one Query returns kinds interleaved chronologically', () => {
    const sorted = [
      seriesSortKey(TWO_PM, { kind: 'generation' }),
      seriesSortKey(NOON, { kind: 'forecast', model: 'ml' }),
      seriesSortKey(ONE_PM, { kind: 'generation' }),
      seriesSortKey(NOON, { kind: 'forecast', model: 'physics' }),
    ].sort(byCodeUnit);

    expect(sorted).toEqual([
      'T#2026-07-30T12:00:00Z#FC#ml',
      'T#2026-07-30T12:00:00Z#FC#physics',
      'T#2026-07-30T13:00:00Z#GEN',
      'T#2026-07-30T14:00:00Z#GEN',
    ]);
  });
});

// These four are the string-order properties the series adapter's range query
// rests on. DynamoDB permits only one comparator pair on a sort key, so a
// half-open window [from, to) is issued as BETWEEN 'T#<from>' AND 'T#<to>' with
// the upper bound left bare. That is only correct if the bare bound sorts
// strictly below every real item at `to`, and at or below every real item at
// `from`. Asserted here as plain string comparisons — no adapter, no mock.
describe('series sort key range semantics', () => {
  it.each(allKinds)('includes items at the inclusive lower bound (%o)', (kind) => {
    expect(seriesSortKey(NOON, kind) >= `T#${NOON}`).toBe(true);
  });

  it.each(allKinds)('excludes items at the exclusive upper bound (%o)', (kind) => {
    expect(seriesSortKey(TWO_PM, kind) > `T#${TWO_PM}`).toBe(true);
  });

  it.each(allKinds)('keeps items strictly inside the window inside it (%o)', (kind) => {
    const key = seriesSortKey(ONE_PM, kind);

    expect(key >= `T#${NOON}`).toBe(true);
    expect(key <= `T#${TWO_PM}`).toBe(true);
  });

  it('places the bare upper bound between the last included item and the first excluded one', () => {
    const lastIncluded = seriesSortKey(ONE_PM, { kind: 'generation' });
    const firstExcluded = seriesSortKey(TWO_PM, { kind: 'forecast', model: 'ml' });

    expect(lastIncluded < `T#${TWO_PM}`).toBe(true);
    expect(firstExcluded > `T#${TWO_PM}`).toBe(true);
  });
});

describe('parseSeriesSortKey', () => {
  it.each(allKinds)('round-trips %o', (kind) => {
    expect(parseSeriesSortKey(seriesSortKey(TWO_PM, kind))).toEqual({
      validTime: '2026-07-30T14:00:00Z',
      kind,
    });
  });

  it.each([
    ['an empty string', ''],
    ['a key with no kind segment', 'T#2026-07-30T14:00:00Z'],
    ['a key with the wrong time prefix', 'X#2026-07-30T14:00:00Z#GEN'],
    ['a key with an unparseable valid time', 'T#yesterday#GEN'],
    ['a key with a variable-width valid time', 'T#2026-07-30T14:00:00.000Z#GEN'],
    ['a forecast key with no model', 'T#2026-07-30T14:00:00Z#FC'],
    ['a forecast key naming an unknown model', 'T#2026-07-30T14:00:00Z#FC#oracle'],
    ['a generation key with a trailing segment', 'T#2026-07-30T14:00:00Z#GEN#extra'],
    ['a key with an unknown kind segment', 'T#2026-07-30T14:00:00Z#ACTUAL'],
    ['a weather sort key', 'ARCHIVE#T#2026-07-30T14:00:00Z'],
  ])('throws on %s', (_description, sortKey) => {
    expect(() => parseSeriesSortKey(sortKey)).toThrow();
  });
});

describe('weatherSortKey', () => {
  it('renders a forecast-weather key', () => {
    expect(weatherSortKey('forecast', TWO_PM)).toBe('FORECAST#T#2026-07-30T14:00:00Z');
  });

  it('renders an archive-weather key', () => {
    expect(weatherSortKey('archive', TWO_PM)).toBe('ARCHIVE#T#2026-07-30T14:00:00Z');
  });

  it('separates archive from forecast items, so a range query over one never reads the other', () => {
    expect(weatherSortKey('archive', TWO_PM) < weatherSortKey('forecast', NOON)).toBe(true);
  });

  it('orders each source chronologically', () => {
    expect(weatherSortKey('archive', NOON) < weatherSortKey('archive', TWO_PM)).toBe(true);
    expect(weatherSortKey('forecast', NOON) < weatherSortKey('forecast', TWO_PM)).toBe(true);
  });
});

describe('archiveDayMarkerSortKey', () => {
  it('renders a day marker', () => {
    expect(archiveDayMarkerSortKey('2026-07-01')).toBe('ARCHIVE#DAY#2026-07-01');
  });

  it('keeps markers out of the archive reading range, so a range query returns only readings', () => {
    expect(archiveDayMarkerSortKey('2026-07-30') < weatherSortKey('archive', NOON)).toBe(true);
  });

  it('orders markers chronologically', () => {
    expect(archiveDayMarkerSortKey('2026-07-01') < archiveDayMarkerSortKey('2026-07-02')).toBe(
      true,
    );
    expect(archiveDayMarkerSortKey('2026-07-31') < archiveDayMarkerSortKey('2026-08-01')).toBe(
      true,
    );
  });

  it.each([
    ['an unpadded month and day', '2026-7-1'],
    ['an unpadded day', '2026-07-1'],
    ['a two-digit year', '26-07-01'],
    ['a full timestamp', '2026-07-01T00:00:00Z'],
    ['an empty string', ''],
    ['a slash-separated date', '2026/07/01'],
    ['a trailing-space date', '2026-07-01 '],
  ])('throws on %s', (_description, day) => {
    expect(() => archiveDayMarkerSortKey(day)).toThrow();
  });
});

describe('metricsSortKey', () => {
  const july = {
    startInclusive: at('2026-07-01T00:00:00Z'),
    endExclusive: at('2026-08-01T00:00:00Z'),
  };

  it('renders period, then model, then baseline', () => {
    expect(metricsSortKey(july, 'physics', 'persistence')).toBe(
      '2026-07-01T00:00:00Z#2026-08-01T00:00:00Z#physics#persistence',
    );
  });

  it('gives both models of one period a shared prefix, so one begins_with Query returns the pair', () => {
    const prefix = '2026-07-01T00:00:00Z#2026-08-01T00:00:00Z#';

    expect(metricsSortKey(july, 'physics', 'persistence').startsWith(prefix)).toBe(true);
    expect(metricsSortKey(july, 'ml', 'persistence').startsWith(prefix)).toBe(true);
  });

  it('treats two baselines over the same period as distinct results, not a collision', () => {
    expect(metricsSortKey(july, 'ml', 'persistence')).not.toBe(
      metricsSortKey(july, 'ml', 'clear-sky'),
    );
  });

  it('does not conflate periods that share a start', () => {
    const shorter = {
      startInclusive: july.startInclusive,
      endExclusive: at('2026-07-15T00:00:00Z'),
    };

    expect(metricsSortKey(shorter, 'ml', 'persistence')).not.toBe(
      metricsSortKey(july, 'ml', 'persistence'),
    );
  });
});
