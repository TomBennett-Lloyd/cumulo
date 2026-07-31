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
 *   `STORAGE_REQUEST_TIMEOUT_MS`, `STORAGE_CONNECTION_TIMEOUT_MS`,
 *   `DYNAMODB_BATCH_WRITE_SIZE`, `SERIES_RETENTION_DAYS` — because ADR 0002
 *   Consequences 4 and 5 state them as decisions, and infrastructure and
 *   operators quote them. So does `BatchPolicy`/`defaultBatchPolicy`, which
 *   `BatchingAdapterDeps` names in its own signature.
 *
 *   The four timing numbers earn their place twice over since #115: they are
 *   the terms `@cumulo/ingestion` multiplies out to bound one location's
 *   storage cost. A consumer computing a time budget from remembered values
 *   instead of these is writing down a model of this package rather than
 *   reading this package, which is the mistake #115 was filed about.
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
  STORAGE_CONNECTION_TIMEOUT_MS,
  STORAGE_MAX_ATTEMPTS,
  STORAGE_REQUEST_TIMEOUT_MS,
  STORAGE_RETRY_BASE_DELAY_MS,
  type StorageClientOptions,
} from './client';
export {
  DYNAMODB_BATCH_WRITE_SIZE,
  defaultBatchPolicy,
  type BatchPolicy,
  type BatchWriteOutcome,
} from './batch';
export { StorageError, type StorageErrorContext } from './errors';
export { storageTableName, type StorageTable } from './table-name';
export { SERIES_RETENTION_DAYS } from './ttl';

export { type BatchingAdapterDeps, type StorageAdapterDeps } from './adapters/storage-adapter-base';

export { SiteAdapter, type GetFleetSiteResult } from './adapters/site/site-adapter';
export { type SitePhysics } from './adapters/site/site-item';
export { SeriesAdapter } from './adapters/series/series-adapter';
export { type SeriesPoint } from './adapters/series/series-item';
export { WeatherAdapter, type ArchiveDayCoverage } from './adapters/weather/weather-adapter';
export {
  FORECAST_WEATHER_RETENTION_DAYS,
  type ArchiveWeatherReading,
  type ForecastWeatherReading,
  type WeatherLocation,
} from './adapters/weather/weather-item';
