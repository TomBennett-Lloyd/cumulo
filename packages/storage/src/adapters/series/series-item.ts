import {
  forecastSchema,
  generationReadingSchema,
  parseSeriesSortKey,
  seriesSortKey,
  type Forecast,
  type GenerationReading,
} from '@cumulo/shared';

import { SERIES_RETENTION_DAYS, TTL_ATTRIBUTE_NAME, expiresAtEpochSeconds } from '../../ttl';

/**
 * The wire format of a `cumulo-series` item (ADR 0002 "Key design" table 2):
 * the sort key and TTL that wrap a domain forecast or generation reading, and
 * the sort key's second job as the discriminator on the way back out.
 */

/**
 * The sort-key prefix that a range bound is built from — the same
 * `TIME_SEGMENT` that `seriesSortKey` writes (`@cumulo/shared/storage-key`).
 *
 * A *bare* `T#<timestamp>` is never a real item's sort key: every stored key
 * carries a `#FC#<model>` or `#GEN` suffix after the timestamp. That gap is
 * exactly what the half-open range in `SeriesAdapter.querySeriesRange` relies
 * on.
 */
export const TIME_BOUND_PREFIX = 'T#';

/** The key and TTL attributes a series item carries on top of its domain fields. */
export interface SeriesItemKeys {
  /** The sort key — `seriesSortKey(validTime, kind)`. */
  readonly sk: string;
  /**
   * DynamoDB TTL, in epoch **seconds**. Series data is disposable after the
   * 90-day accuracy window; see `ttl.ts`, which also owns the attribute's name.
   */
  readonly [TTL_ATTRIBUTE_NAME]: number;
}

export type ForecastItem = Forecast & SeriesItemKeys;
export type GenerationReadingItem = GenerationReading & SeriesItemKeys;

/**
 * One point on a site's timeline. A forecast and an actual are different
 * things — different schemas, different meanings — so the Query that returns
 * them interleaved returns a discriminated union rather than a bag of optional
 * fields (typing rule 4). The caller switches; nothing has to guess from which
 * fields happen to be present.
 */
export type SeriesPoint =
  | { readonly type: 'forecast'; readonly forecast: Forecast }
  | { readonly type: 'generation'; readonly reading: GenerationReading };

/** Attributes that address or expire an item rather than describing it. */
const KEY_ATTRIBUTES: ReadonlySet<string> = new Set(['sk', TTL_ATTRIBUTE_NAME]);

/**
 * Domain forecast → stored item.
 *
 * `siteId` is deliberately *not* stripped or renamed: it is a domain field of
 * `forecastSchema` that also serves as the partition key, so unlike the sites
 * table there is no key attribute to invent here. Only `sk` and `expiresAt` are
 * added, and `fromItem` removes exactly those two again.
 *
 * Exported for its tests; it is not part of the package's public surface.
 */
export const toForecastItem = (forecast: Forecast): ForecastItem => ({
  ...forecast,
  sk: seriesSortKey(forecast.validTime, { kind: 'forecast', model: forecast.model }),
  [TTL_ATTRIBUTE_NAME]: expiresAtEpochSeconds(forecast.validTime, SERIES_RETENTION_DAYS),
});

/**
 * Domain generation reading → stored item.
 *
 * Exported for its tests; it is not part of the package's public surface.
 */
export const toGenerationReadingItem = (reading: GenerationReading): GenerationReadingItem => ({
  ...reading,
  sk: seriesSortKey(reading.validTime, { kind: 'generation' }),
  [TTL_ATTRIBUTE_NAME]: expiresAtEpochSeconds(reading.validTime, SERIES_RETENTION_DAYS),
});

const domainAttributes = (item: Record<string, unknown>): Record<string, unknown> => {
  const domain: Record<string, unknown> = {};
  for (const [attribute, value] of Object.entries(item)) {
    if (!KEY_ATTRIBUTES.has(attribute)) {
      domain[attribute] = value;
    }
  }
  return domain;
};

/**
 * Stored item → domain point.
 *
 * The sort key is the discriminator: `parseSeriesSortKey` says whether this row
 * is a forecast (and from which model) or an actual, and the matching schema
 * then parses the domain attributes. Two things follow deliberately:
 *
 * - The parse is not ceremony. A table is a boundary, so its contents are
 *   `unknown` until a schema has looked at them (typing rule 3) — and it is the
 *   parse, not the sort key, that restores the branded `UtcIsoTimestamp` on
 *   `validTime` (`parseSeriesSortKey` returns a plain validated string).
 * - Both failure modes throw rather than returning a value: an unreadable sort
 *   key or an item that does not parse means the table holds something this
 *   code did not write — a violated invariant, not an outcome a caller could
 *   handle (`docs/standards/error-handling.md` rule 1). Neither is wrapped in a
 *   `StorageError`, which means "the call to AWS failed" and would send a reader
 *   looking in the wrong place.
 *
 * Exported for its tests; it is not part of the package's public surface.
 */
export const fromItem = (item: Record<string, unknown>): SeriesPoint => {
  const sortKey = item.sk;
  if (typeof sortKey !== 'string') {
    throw new Error(
      `Series item has no string sort key: ${JSON.stringify(sortKey)} (siteId ${JSON.stringify(item.siteId)})`,
    );
  }

  const { kind } = parseSeriesSortKey(sortKey);
  const domain = domainAttributes(item);

  return kind.kind === 'forecast'
    ? { type: 'forecast', forecast: forecastSchema.parse(domain) }
    : { type: 'generation', reading: generationReadingSchema.parse(domain) };
};
