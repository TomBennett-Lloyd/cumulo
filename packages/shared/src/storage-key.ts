import { forecastModelSchema, type ForecastModel } from './forecast';
import { utcIsoTimestampSchema, type UtcIsoTimestamp, type UtcWindow } from './timestamp';

/**
 * Storage sort keys for ADR 0002's single-store DynamoDB design.
 *
 * These are pure string functions and live in `@cumulo/shared` on purpose: the
 * key format is domain vocabulary shared by the ingestion, forecast and API
 * services, and the frontend package must never pull an AWS SDK in behind it.
 * The effectful adapters that use them live in `@cumulo/storage`.
 *
 * Every key here is built so that **lexicographic order is chronological
 * order** — which is only true because `utcIsoTimestampSchema` pins timestamps
 * to a fixed width (see `timestamp.ts`). Range queries depend on it directly:
 * a half-open window `[from, to)` is expressed as a DynamoDB `BETWEEN` from
 * `T#<from>` to the *bare* `T#<to>`, and real items at `to` carry a `#<kind>`
 * suffix that sorts strictly after that bare bound, so they fall outside the
 * range while items at `from` fall inside it. `storage-key.test.ts` pins that
 * property as plain string comparisons; it is load-bearing for the series
 * adapter and must not be treated as an incidental detail of the format.
 */

/** Which flavour of series point a `cumulo-series` item holds. */
export type SeriesKind = { kind: 'forecast'; model: ForecastModel } | { kind: 'generation' };

const TIME_SEGMENT = 'T';
const FORECAST_SEGMENT = 'FC';
const GENERATION_SEGMENT = 'GEN';
const ARCHIVE_SEGMENT = 'ARCHIVE';
const WEATHER_FORECAST_SEGMENT = 'FORECAST';
const DAY_SEGMENT = 'DAY';

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The kind half of a series-flavoured sort key: `FC#<model>` or `GEN`.
 *
 * Shared by {@link seriesSortKey} and {@link fleetRollupTimeBound} rather than
 * spelled twice, because the two keys encode *the same* vocabulary in a
 * different order (`docs/standards/structure.md` rule 7): a third flavour of
 * series row would be wrong in both places or in neither.
 */
const seriesKindSegment = (kind: SeriesKind): string =>
  kind.kind === 'forecast' ? `${FORECAST_SEGMENT}#${kind.model}` : GENERATION_SEGMENT;

/**
 * `cumulo-series` sort key: `T#<validTime>#FC#<model>` for a forecast,
 * `T#<validTime>#GEN` for a generation actual.
 *
 * Valid time comes before kind so that a single Query returns physics, ML and
 * actuals interleaved by time (ADR 0002 access pattern A4).
 */
export const seriesSortKey = (validTime: UtcIsoTimestamp, kind: SeriesKind): string =>
  `${TIME_SEGMENT}#${validTime}#${seriesKindSegment(kind)}`;

const LOCATION_SEGMENT = 'L';

/**
 * The partition every fleet roll-up partial is written under, in the
 * `cumulo-series` table (#494, ADR 0009).
 *
 * A sentinel value in the `siteId` partition key, so the roll-up needs no fifth
 * table, no index and no Terraform: the forecast service already writes this
 * table and the API already reads it. The cost, stated rather than hidden, is
 * that `siteId` stops meaning "a site's id" for one kind of item. Collision is
 * structural rather than hoped-for — `#` is not a character `randomUUID` emits,
 * and `siteSchema.id` is `z.uuid()`, so no site can ever own this partition.
 */
export const FLEET_ROLLUP_PARTITION = '#FLEET';

/**
 * A range bound for a Query over one kind of roll-up partial:
 * `FC#<model>#T#<validTime>` — the prefix {@link fleetRollupSortKey} builds on,
 * *without* the location suffix.
 *
 * That missing suffix is the whole mechanism, and it is `series-item.ts`'s
 * `TIME_BOUND_PREFIX` trick applied one level in. DynamoDB offers only
 * `BETWEEN`, which is inclusive at both ends, so a half-open `[from, to)` is a
 * `BETWEEN` from this bound at `from` to this bound at `to`: every real item at
 * `to` is this string plus `#L#<locationId>`, which sorts strictly after it and
 * so falls outside, while items at `from` sort at or after their bound and fall
 * inside. Half-openness comes out of string order and needs no sentinel
 * character — and it holds only because timestamps are fixed-width
 * (`timestamp.ts`), which `storage-key.test.ts` pins as plain string
 * comparisons.
 */
export const fleetRollupTimeBound = (kind: SeriesKind, validTime: UtcIsoTimestamp): string =>
  `${seriesKindSegment(kind)}#${TIME_SEGMENT}#${validTime}`;

/**
 * `cumulo-series` sort key for one **fleet roll-up partial** — one location's
 * additive contribution to one hour of the fleet aggregate:
 * `FC#<model>#T#<validTime>#L#<locationId>`, or `GEN#T#…#L#…` for the actuals
 * kind ADR 0009 defines but this ticket does not yet produce.
 *
 * **The segment order is the inverse of {@link seriesSortKey}'s, deliberately.**
 * There the partition is one site and a reader wants the two models and the
 * actual interleaved by time (A4), so time leads. Here the partition holds every
 * location and every kind, and the only read is "one kind, over one window", so
 * **kind leads and time follows it**: a Query for the forecast kind never reads
 * past a single actuals item, and `[from, to)` is expressible on the sort key.
 *
 * The location trails the hour because it is not a dimension any read selects
 * on — it is what makes a *partial* addressable, so that twelve locations write
 * twelve items for an hour instead of overwriting one. The sum at read is over
 * whatever locations are there (ADR 0009).
 *
 * `locationId` cannot contain `#` (`location.ts` builds it from two `toFixed(2)`
 * numbers), so the segments stay unambiguous. There is deliberately **no**
 * inverse of this function: unlike `parseSeriesSortKey`, nothing has to
 * rediscover the kind from a stored key — the Query's key condition already pins
 * it, and the item carries `validTime` and `locationId` as attributes its own
 * schema validates.
 */
export const fleetRollupSortKey = (
  kind: SeriesKind,
  validTime: UtcIsoTimestamp,
  locationId: string,
): string => `${fleetRollupTimeBound(kind, validTime)}#${LOCATION_SEGMENT}#${locationId}`;

const malformedSeriesSortKey = (sortKey: string): Error =>
  new Error(`Malformed series sort key: ${JSON.stringify(sortKey)}`);

/**
 * Inverse of {@link seriesSortKey}, used by the series adapter to decide which
 * domain schema to parse an item with.
 *
 * Throws on anything it did not write. A sort key that does not round-trip is a
 * violated invariant — the table contains an item this code did not produce, or
 * the format changed under it — not an expected outcome a caller could handle,
 * so it propagates (`docs/standards/error-handling.md` rule 1).
 */
export const parseSeriesSortKey = (sortKey: string): { validTime: string; kind: SeriesKind } => {
  const segments = sortKey.split('#');
  const [prefix, rawValidTime, kindSegment, rawModel] = segments;

  if (prefix !== TIME_SEGMENT || rawValidTime === undefined) {
    throw malformedSeriesSortKey(sortKey);
  }

  const parsedValidTime = utcIsoTimestampSchema.safeParse(rawValidTime);
  if (!parsedValidTime.success) {
    throw malformedSeriesSortKey(sortKey);
  }
  const validTime: string = parsedValidTime.data;

  if (segments.length === 3 && kindSegment === GENERATION_SEGMENT) {
    return { validTime, kind: { kind: 'generation' } };
  }

  if (segments.length === 4 && kindSegment === FORECAST_SEGMENT) {
    const model = forecastModelSchema.safeParse(rawModel);
    if (!model.success) {
      throw malformedSeriesSortKey(sortKey);
    }
    return { validTime, kind: { kind: 'forecast', model: model.data } };
  }

  throw malformedSeriesSortKey(sortKey);
};

/**
 * `cumulo-weather` sort key: `FORECAST#T#<validTime>` or
 * `ARCHIVE#T#<validTime>`.
 *
 * `kind` is `weatherReadingSchema`'s axis (predicted vs historical archive);
 * ADR 0002 calls the same axis `source` in the sort key, because in the schema
 * `source` already means provenance. This function is where that rename
 * happens, and it is the only place it should.
 *
 * Source leads the key so that an archive range Query never has to read past
 * forecast items for the same location, and so the day markers below sit in one
 * contiguous run.
 */
export const weatherSortKey = (
  kind: 'forecast' | 'archive',
  validTime: UtcIsoTimestamp,
): string => {
  const sourceSegment = kind === 'archive' ? ARCHIVE_SEGMENT : WEATHER_FORECAST_SEGMENT;

  return `${sourceSegment}#${TIME_SEGMENT}#${validTime}`;
};

/**
 * `cumulo-weather` sort key of the marker item that records "this location-day
 * has been fetched from the archive": `ARCHIVE#DAY#<YYYY-MM-DD>`.
 *
 * The marker is the cache-hit test for the hindcast fetch (#16); the readings
 * are the payload. It is written in the same transaction as the day's readings,
 * so a partial fetch can never leave a marker claiming coverage it does not
 * have.
 *
 * Throws on a day that is not zero-padded `YYYY-MM-DD`. Width is the whole
 * point: `2026-7-1` would sort between `2026-12-31` and `2026-02-01` and make
 * the marker run unqueryable, so a loose day string is a violated invariant
 * rather than something to normalize quietly.
 */
export const archiveDayMarkerSortKey = (day: string): string => {
  if (!DAY_PATTERN.test(day)) {
    throw new Error(`Archive day must be YYYY-MM-DD, received: ${JSON.stringify(day)}`);
  }

  return `${ARCHIVE_SEGMENT}#${DAY_SEGMENT}#${day}`;
};

/**
 * `cumulo-metrics` sort key: `<periodStart>#<periodEnd>#<model>#<baseline>`.
 *
 * Period leads so that both models' metrics for one period come back from a
 * single `begins_with(sk, '<start>#<end>#')` Query — the side-by-side payload
 * #20's comparison endpoint returns. The baseline is part of the key because a
 * skill score carries its reference: two baselines over the same period are two
 * distinct results, not a collision.
 *
 * The period is a `UtcWindow` (`timestamp.ts`) — named half-open bounds, so the
 * two same-shaped timestamps cannot be swapped at a call site. #16 settled the
 * granularity question this signature left open: a hindcast evaluates an
 * arbitrary range, routinely shorter than a day (a single cloudy afternoon),
 * which a day-granular key would make unrepresentable — so the timestamp pair
 * stands unchanged, and `errorMetricsSchema.period` (`metrics.ts`) carries
 * exactly this shape so that `metricsSortKey(metrics.period, metrics.model,
 * metrics.baseline)` composes straight from a parsed row.
 */
export const metricsSortKey = (period: UtcWindow, model: ForecastModel, baseline: string): string =>
  `${period.startInclusive}#${period.endExclusive}#${model}#${baseline}`;
