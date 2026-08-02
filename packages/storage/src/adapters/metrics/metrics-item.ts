import {
  errorMetricsSchema,
  metricsSortKey,
  type ErrorMetrics,
  type UtcWindow,
} from '@cumulo/shared';

/**
 * The wire format of a `cumulo-metrics` item (ADR 0002 "Key design" table 4):
 * the sort key that wraps a domain {@link ErrorMetrics}, and the period prefix
 * the side-by-side Query is built from.
 *
 * There is no TTL attribute here, deliberately: `infra/storage/tables.tf` gives
 * this table no TTL because metrics are the published evidence #20's comparison
 * view rests on, unlike the series data they were computed from.
 */

/**
 * A `cumulo-metrics` item: the domain fields of an {@link ErrorMetrics}, plus
 * the one computed key attribute.
 *
 * A type alias over an inline literal rather than an intersection with a named
 * `interface`, matching `site-item.ts`: an interface has no implicit index
 * signature, so an item typed through one cannot be handed to anything taking
 * the `Record<string, unknown>` that DynamoDB rows arrive as — including
 * `fromItem` itself, which is what a round-trip test needs.
 */
export type ErrorMetricsItem = ErrorMetrics & {
  /** The sort key — `metricsSortKey(period, model, baseline)`. */
  readonly sk: string;
};

/** Attributes that address an item rather than describing it. */
const KEY_ATTRIBUTES: ReadonlySet<string> = new Set(['sk']);

/**
 * The `begins_with` prefix that selects every metrics row for one period,
 * whatever model or baseline produced it (ADR 0002 access pattern H5/A6).
 *
 * The trailing `#` is the whole point. `metricsSortKey` writes
 * `<start>#<end>#<model>#<baseline>`, so a prefix stopping at `<end>` would also
 * match a period whose end merely *starts* with these characters — and since
 * timestamps are fixed-width that can only happen for a longer end bound, but
 * relying on width for a correctness property that a delimiter gives for free is
 * the kind of implicit coupling this codebase pays for later. The separator is
 * therefore part of the prefix, and `metrics-item.test.ts` pins that every real
 * sort key for a period begins with it while a neighbouring period's does not.
 */
export const metricsPeriodPrefix = (period: UtcWindow): string =>
  `${period.startInclusive}#${period.endExclusive}#`;

/**
 * Domain metrics → stored item.
 *
 * `siteId` is deliberately neither stripped nor renamed: it is a domain field of
 * `errorMetricsSchema` that also serves as the partition key, exactly as on the
 * series table, so there is no key attribute to invent. Only `sk` is added, and
 * `fromItem` removes exactly it again. `period` goes down as a plain map
 * attribute — it is domain data that the sort key happens to be derived from,
 * not a key itself.
 *
 * Exported for its tests; it is not part of the package's public surface.
 */
export const toItem = (metrics: ErrorMetrics): ErrorMetricsItem => ({
  ...metrics,
  sk: metricsSortKey(metrics.period, metrics.model, metrics.baseline),
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
 * Stored item → domain metrics.
 *
 * The parse is not ceremony: a table is a boundary, so its contents are
 * `unknown` until a schema has looked at them (typing rule 3). An item that does
 * not parse means the table holds something this code did not write — a violated
 * invariant, so it throws rather than returning a value
 * (`docs/standards/error-handling.md` rule 1). Deliberately *not* wrapped in a
 * `StorageError`: that type means "the call to AWS failed", and labelling schema
 * drift as an infrastructure failure would send the reader looking in the wrong
 * place.
 *
 * Exported for its tests; it is not part of the package's public surface.
 */
export const fromItem = (item: Record<string, unknown>): ErrorMetrics =>
  errorMetricsSchema.parse(domainAttributes(item));
