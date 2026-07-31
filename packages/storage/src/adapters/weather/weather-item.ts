import type { NativeAttributeValue } from '@aws-sdk/lib-dynamodb';
import {
  locationId,
  weatherReadingSchema,
  weatherSortKey,
  type ArchiveWeatherReading,
  type ForecastWeatherReading,
  type WeatherReading,
} from '@cumulo/shared';
import { z } from 'zod';

import { SERIES_RETENTION_DAYS, expiresAtEpochSeconds } from '../../ttl';

/**
 * The wire format of a `cumulo-weather` item (ADR 0002 "Key design" §3): the
 * `locationId`/`sk` key pair each reading is stored under, the day marker that
 * vouches for a fetched archive day, and the one table's two lifetimes —
 * forecast weather expires by TTL, archive weather never does.
 */

/** Where a weather reading is: the two schema fields `locationId` is built from. */
export type WeatherLocation = Pick<WeatherReading, 'latitude' | 'longitude'>;

/**
 * Forecast weather is kept exactly as long as the series it explains
 * (`SERIES_RETENTION_DAYS`). Tying the two is deliberate: a stored forecast
 * whose input weather had already expired would be unexplainable, and #16's
 * hindcast replays over *archive* weather, which never expires at all.
 */
export const FORECAST_WEATHER_RETENTION_DAYS = SERIES_RETENTION_DAYS;

export type WeatherItem = Record<string, NativeAttributeValue>;

/** A marker key, and the shape of a marker item — it has no other attributes. */
export const markerKeySchema = z.object({ locationId: z.string(), sk: z.string() });
export type MarkerKey = z.infer<typeof markerKeySchema>;

/**
 * The two writers take the narrowed reading types (`@cumulo/shared`) rather than
 * `WeatherReading`, and neither inspects `kind` at runtime: they write different
 * sort-key prefixes and different TTLs, so handing one the other's readings is a
 * compile error instead of a runtime check nobody exercises.
 */
export const toForecastItem = (reading: ForecastWeatherReading): WeatherItem => ({
  ...reading,
  locationId: locationId(reading),
  sk: weatherSortKey('forecast', reading.validTime),
  expiresAt: expiresAtEpochSeconds(reading.validTime, FORECAST_WEATHER_RETENTION_DAYS),
});

export const toArchiveItem = (reading: ArchiveWeatherReading): WeatherItem => ({
  // No `expiresAt`: archive weather is the hindcast's permanent input (ADR 0002
  // §3 — "`expiresAt` on `FORECAST` items only").
  ...reading,
  locationId: locationId(reading),
  sk: weatherSortKey('archive', reading.validTime),
});

/**
 * The attributes this adapter owns rather than the domain: the two key
 * attributes and the TTL. Everything else in an item is a weather-reading
 * field.
 */
const STORAGE_ATTRIBUTES = new Set(['locationId', 'sk', 'expiresAt']);

/**
 * Storage-owned attributes are removed before parsing, rather than left for
 * zod to strip, so the boundary is stated here: an item that carries anything
 * else this code did not write fails loudly on the domain fields.
 */
export const fromItem = (item: Record<string, unknown>): WeatherReading => {
  const domainFields = Object.fromEntries(
    Object.entries(item).filter(([attribute]) => !STORAGE_ATTRIBUTES.has(attribute)),
  );
  return weatherReadingSchema.parse(domainFields);
};
