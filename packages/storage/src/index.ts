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
 *   `drainBatches` and `DrainOutcome`, the rest of the backoff arithmetic
 *   (`MAX_BACKOFF_DELAY_MS`, `storageRetryDelayMs`,
 *   `createStorageRetryStrategy`) and the TTL computation
 *   (`expiresAtEpochSeconds`). A caller reaching for these is
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
 *
 *   `fullJitterDelayMs` and `BackoffSpec` moved *onto* the surface for that
 *   same reason in #155. The site adapter now reports a conflict-cancelled
 *   transaction as a domain outcome and deliberately does not retry it (ADR
 *   0002's layer-ownership rule; see `transactUnless`), which makes the API
 *   route handlers the retry owner. An owner outside this package still has to
 *   back off, and the alternative to exporting the curve is each handler
 *   restating `uniform(0, min(base * 2^n, max))` from memory — the #115
 *   mistake again, one layer up. So the *arithmetic* is shared while the
 *   *numbers* stay the retry owner's own: the handlers pass their own
 *   `BackoffSpec` rather than inheriting this package's, because their budget
 *   is a request's, not a background drain's.
 * - the `toItem`/`fromItem` pairs each adapter exports for its own tests. They
 *   are the wire format, not the contract; exporting them would invite a caller
 *   to build items by hand and bypass the key computation the adapters exist to
 *   own.
 * - the stored-item types (`FleetSiteItem`, `ForecastItem`, …). Same reason:
 *   ADR 0002's key attributes live between `toItem` and `fromItem` and nowhere
 *   else, and a type that names them outside the package would make them look
 *   like domain data.
 * - the domain schema types the adapters' parameters and returns are written in
 *   — `ForecastWeatherReading`, `ArchiveWeatherReading`, `WeatherReading` and,
 *   since #136, `SitePhysics`. These come from `@cumulo/shared` and a caller
 *   imports them from there (#91). Re-exporting them here would give one
 *   definition three import paths and imply this package owns a concept it only
 *   consumes — the opposite of `architecture.md` rule 2. `SitePhysics` had to
 *   move for a second reason: the forecast service takes it as an input, and it
 *   would otherwise have reached that service through a package it does not
 *   otherwise need. Which is why `WeatherLocation`, just below, *is* exported:
 *   it is a `Pick` of the shared reading describing what this package keys on,
 *   and it exists nowhere else.
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
  fullJitterDelayMs,
  type BackoffSpec,
  type BatchPolicy,
  type BatchWriteOutcome,
} from './batch';
export { StorageError, type StorageErrorContext } from './errors';
export { storageTableName, type StorageTable } from './table-name';
export { SERIES_RETENTION_DAYS } from './ttl';

export { type BatchingAdapterDeps, type StorageAdapterDeps } from './adapters/storage-adapter-base';

export {
  SiteAdapter,
  type CreateUserSiteResult,
  type EvictAndCreateResult,
  type GetFleetSiteResult,
  type OldestUserSiteResult,
} from './adapters/site/site-adapter';
export {
  AbuseAdapter,
  type AbuseAdapterDeps,
  type BlockStatus,
} from './adapters/abuse/abuse-adapter';
export { SeriesAdapter, type SeriesCleanupOutcome } from './adapters/series/series-adapter';
export { type SeriesPoint } from './adapters/series/series-item';
export { MetricsAdapter } from './adapters/metrics/metrics-adapter';
export { WeatherAdapter, type ArchiveDayCoverage } from './adapters/weather/weather-adapter';
export {
  FORECAST_WEATHER_RETENTION_DAYS,
  type WeatherLocation,
} from './adapters/weather/weather-item';
