/**
 * The public surface of `@cumulo/storage`.
 *
 * Everything a consumer of this package may import is named here, once
 * (architecture rule 1: modules expose a deliberate surface via `index.ts`, and
 * a deep import into `src/` is a smell). What earns a line here is what a
 * caller needs to *use the adapters*: build the client, name a table, construct
 * an adapter, pass it domain values, and interpret what it hands back —
 * including its two failure vocabularies, `StorageError` and the partial-write
 * outcome. Nothing else, on the principle that a surface is a promise and every
 * name on it is one more thing that cannot change freely.
 *
 * So these categories are deliberately *absent*:
 *
 * - the machinery that *applies* the failure and retention policies:
 *   `drainBatches` and `DrainOutcome`, the backoff arithmetic
 *   (`fullJitterDelayMs`, `BackoffSpec`, `MAX_BACKOFF_DELAY_MS`,
 *   `storageRetryDelayMs`, `createStorageRetryStrategy`) and the TTL
 *   computation (`expiresAtEpochSeconds`). A caller reaching for these is
 *   either rebuilding an adapter or tuning one from the outside, and both
 *   belong in here instead. The *numbers* those functions apply do stay
 *   exported — `STORAGE_MAX_ATTEMPTS`, `STORAGE_RETRY_BASE_DELAY_MS`,
 *   `SERIES_RETENTION_DAYS` — because ADR 0002 Consequences 4 and 5 state them
 *   as decisions, and infrastructure and operators quote them. So does
 *   `BatchPolicy`/`defaultBatchPolicy`, which `WeatherAdapterDeps` and its
 *   siblings name in their own signatures.
 * - the `toItem`/`fromItem` pairs each adapter exports for its own tests. They
 *   are the wire format, not the contract; exporting them would invite a caller
 *   to build items by hand and bypass the key computation the adapters exist to
 *   own.
 * - the stored-item types (`FleetSiteItem`, `ForecastItem`, …). Same reason:
 *   ADR 0002's key attributes live between `toItem` and `fromItem` and nowhere
 *   else, and a type that names them outside the package would make them look
 *   like domain data.
 *
 * Tests reach past this file by relative path on purpose — they test the
 * modules, not the promise.
 */

export {
  createStorageDocumentClient,
  STORAGE_MAX_ATTEMPTS,
  STORAGE_RETRY_BASE_DELAY_MS,
  type StorageClientOptions,
} from './client';
export { defaultBatchPolicy, type BatchPolicy, type BatchWriteOutcome } from './batch';
export { StorageError, type StorageErrorContext } from './errors';
export { storageTableName, type StorageTable } from './table-name';
export { SERIES_RETENTION_DAYS } from './ttl';

export {
  createSiteAdapter,
  type GetFleetSiteResult,
  type SiteAdapter,
  type SiteAdapterDeps,
  type SitePhysics,
} from './site-adapter';
export {
  createSeriesAdapter,
  type SeriesAdapter,
  type SeriesAdapterDeps,
  type SeriesPoint,
} from './series-adapter';
export {
  createWeatherAdapter,
  FORECAST_WEATHER_RETENTION_DAYS,
  type ArchiveDayCoverage,
  type ArchiveWeatherReading,
  type ForecastWeatherReading,
  type WeatherAdapter,
  type WeatherAdapterDeps,
  type WeatherLocation,
} from './weather-adapter';
