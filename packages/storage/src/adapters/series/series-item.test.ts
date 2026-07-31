import { describe, expect, it } from 'vitest';

import {
  EXPIRES_AT_14H,
  EXPIRES_AT_15H,
  SITE_ID,
  forecast,
  generationItem14h,
  generationReading,
  physicsItem14h,
} from './series-fixtures';
import {
  fromItem,
  toForecastItem,
  toGenerationReadingItem,
  type ForecastItem,
  type GenerationReadingItem,
} from './series-item';

/**
 * The sort key is where this table's design lives — it carries the valid time,
 * the kind, and (for a forecast) the model — and it is pure, so it is pinned
 * directly rather than only through the adapter's queries.
 */

describe('toForecastItem', () => {
  it('adds the sort key and a 90-day TTL to the domain fields, changing nothing else', () => {
    expect(toForecastItem(forecast())).toEqual({
      siteId: SITE_ID,
      model: 'physics',
      validTime: '2026-07-30T14:00:00Z',
      issuedAt: '2026-07-30T13:00:00Z',
      weatherSource: 'open-meteo',
      poaIrradianceWm2: 640.5,
      acPowerKw: 3.2,
      sk: 'T#2026-07-30T14:00:00Z#FC#physics',
      expiresAt: EXPIRES_AT_14H,
    });
  });

  it('puts the model in the sort key so both models coexist at one valid time', () => {
    expect(toForecastItem(forecast({ model: 'ml' })).sk).toBe('T#2026-07-30T14:00:00Z#FC#ml');
  });

  it('expires an item exactly 90 days after its valid time', () => {
    const ninetyDaysSeconds = 90 * 24 * 60 * 60;

    expect(toForecastItem(forecast()).expiresAt).toBe(EXPIRES_AT_14H);
    expect(EXPIRES_AT_14H - Date.parse('2026-07-30T14:00:00Z') / 1000).toBe(ninetyDaysSeconds);
    expect(toForecastItem(forecast({ validTime: '2026-07-30T15:00:00Z' })).expiresAt).toBe(
      EXPIRES_AT_15H,
    );
  });
});

describe('toGenerationReadingItem', () => {
  it('marks an actual with the GEN suffix and the same TTL rule', () => {
    expect(toGenerationReadingItem(generationReading())).toEqual({
      siteId: SITE_ID,
      validTime: '2026-07-30T14:00:00Z',
      acPowerKw: 3.05,
      sk: 'T#2026-07-30T14:00:00Z#GEN',
      expiresAt: EXPIRES_AT_14H,
    });
  });
});

describe('fromItem', () => {
  /**
   * Widens a typed item to the shape a table hands back. `fromItem` takes
   * `Record<string, unknown>` because a stored item is boundary data, so a
   * round-trip test has to cross that boundary rather than short-circuit it.
   */
  const stored = (item: ForecastItem | GenerationReadingItem): Record<string, unknown> => ({
    ...item,
  });

  it('round-trips a physics forecast', () => {
    const point = forecast();

    expect(fromItem(stored(toForecastItem(point)))).toEqual({ type: 'forecast', forecast: point });
  });

  it('round-trips an ML forecast carrying an uncertainty band', () => {
    const point = forecast({
      model: 'ml',
      uncertainty: { p10AcPowerKw: 2.8, p90AcPowerKw: 3.9 },
    });

    expect(fromItem(stored(toForecastItem(point)))).toEqual({ type: 'forecast', forecast: point });
  });

  it('round-trips a generation reading', () => {
    const point = generationReading();

    expect(fromItem(stored(toGenerationReadingItem(point)))).toEqual({
      type: 'generation',
      reading: point,
    });
  });

  it('returns no key or TTL attribute as a domain field', () => {
    const point = fromItem(physicsItem14h);
    if (point.type !== 'forecast') {
      throw new Error('expected the physics item to be tagged as a forecast');
    }

    expect(Object.keys(point.forecast).sort()).toEqual([
      'acPowerKw',
      'issuedAt',
      'model',
      'poaIrradianceWm2',
      'siteId',
      'validTime',
      'weatherSource',
    ]);
  });

  it('dispatches on the sort key, not on which fields happen to be present', () => {
    // The generation schema is a strict subset of the forecast's shape, so an
    // item tagged GEN must be parsed as a reading even though its attributes
    // would also satisfy nothing else. The sort key is the discriminator.
    expect(fromItem(generationItem14h)).toEqual({
      type: 'generation',
      reading: generationReading(),
    });
  });

  it('throws on a malformed sort key rather than guessing the kind', () => {
    expect(() =>
      fromItem({ ...physicsItem14h, sk: 'T#2026-07-30T14:00:00Z#FC#guesswork' }),
    ).toThrow(/Malformed series sort key/);
    expect(() => fromItem({ ...physicsItem14h, sk: 'garbage' })).toThrow(
      /Malformed series sort key/,
    );
  });

  it('throws when the sort key attribute is missing or is not a string', () => {
    const { sk, ...withoutSortKey } = physicsItem14h;
    void sk;

    expect(() => fromItem(withoutSortKey)).toThrow(/no string sort key/);
    expect(() => fromItem({ ...physicsItem14h, sk: 42 })).toThrow(/no string sort key/);
  });

  it('throws on an item the domain schema does not recognise', () => {
    expect(() => fromItem({ ...physicsItem14h, acPowerKw: '3.2' })).toThrow();
    expect(() =>
      fromItem({ ...physicsItem14h, model: 'physics', weatherSource: 'guess' }),
    ).toThrow();
  });
});
