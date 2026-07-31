/**
 * The public surface of `@cumulo/storage`.
 *
 * Everything a consumer of this package may import is named here, once
 * (architecture rule 1: modules expose a deliberate surface via `index.ts`, and
 * a deep import into `src/` is a smell). Two categories are deliberately
 * *absent*:
 *
 * - the `toItem`/`fromItem` pairs each adapter exports for its own tests. They
 *   are the wire format, not the contract; exporting them would invite a caller
 *   to build items by hand and bypass the key computation the adapters exist to
 *   own.
 * - the stored-item types (`FleetSiteItem`, `ForecastItem`, …). Same reason:
 *   ADR 0002's key attributes live between `toItem` and `fromItem` and nowhere
 *   else, and a type that names them outside the package would make them look
 *   like domain data.
 */

export {
  createStorageDocumentClient,
  createStorageRetryStrategy,
  storageRetryDelayMs,
  STORAGE_MAX_ATTEMPTS,
  STORAGE_RETRY_BASE_DELAY_MS,
  type StorageClientOptions,
} from './client';
export {
  drainBatches,
  defaultBatchPolicy,
  fullJitterDelayMs,
  MAX_BACKOFF_DELAY_MS,
  type BackoffSpec,
  type BatchPolicy,
  type BatchWriteOutcome,
  type DrainOutcome,
} from './batch';
export { StorageError, type StorageErrorContext } from './errors';
export { storageTableName, type StorageTable } from './table-name';
export { expiresAtEpochSeconds, SERIES_RETENTION_DAYS } from './ttl';

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
