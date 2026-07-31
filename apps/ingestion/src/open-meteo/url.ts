/**
 * Request construction for the Open-Meteo forecast endpoint.
 *
 * Pure: this module builds a URL string and never fetches it. The adapter that
 * performs the call (and states its timeout/retry policy) lives separately, so
 * every request parameter that matters to correctness is testable without
 * network access.
 */

/**
 * The coordinates a forecast was *requested* for.
 *
 * Deliberately distinct from the coordinates Open-Meteo echoes back: the API
 * snaps a request to its model grid and reports the grid cell's centre, which
 * can be kilometres away. Readings are keyed by the requested location (ADR
 * 0002 derives `locationId` from latitude/longitude), so the echoed values must
 * never reach a stored reading — see `parseForecastResponse`.
 */
export interface ForecastLocation {
  readonly latitude: number;
  readonly longitude: number;
}

/**
 * The hourly variables requested, in request order. Names are Open-Meteo's own;
 * `@cumulo/shared`'s `weatherReadingSchema` carries the camel-cased, unit-suffixed
 * counterpart of each, so the mapping in `response.ts` is a rename a reviewer can
 * check by eye.
 */
export const hourlyVariables = [
  'shortwave_radiation',
  'direct_radiation',
  'diffuse_radiation',
  'direct_normal_irradiance',
  'temperature_2m',
  'wind_speed_10m',
  'cloud_cover',
] as const;

export type HourlyVariable = (typeof hourlyVariables)[number];

export const openMeteoForecastEndpoint = 'https://api.open-meteo.com/v1/forecast';

/** Horizon requested per call. 48 h covers the demo's day-ahead + intraday views. */
export const forecastHours = 48;

/**
 * Build the forecast request URL for one location.
 *
 * Three parameters are load-bearing rather than stylistic:
 * - `wind_speed_unit=ms` — Open-Meteo defaults to km/h, and ordinary wind speeds
 *   in km/h parse cleanly as m/s against `weatherReadingSchema`'s 120 m/s sanity
 *   cap. Nothing downstream can detect the resulting ~3.6x error in the Faiman
 *   cell-temperature term, so pinning the unit here *is* the defence.
 * - `timezone=UTC` — Open-Meteo returns designator-less local times; asking for
 *   UTC is what makes appending `:00Z` during normalization correct rather than
 *   a silent offset bug.
 * - `forecast_hours=48` — API frugality (CLAUDE.md): ask for the horizon we use,
 *   not the 7-day default.
 */
export function buildForecastUrl(location: ForecastLocation): string {
  const url = new URL(openMeteoForecastEndpoint);
  url.search = new URLSearchParams({
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    hourly: hourlyVariables.join(','),
    wind_speed_unit: 'ms',
    timezone: 'UTC',
    forecast_hours: String(forecastHours),
  }).toString();
  return url.toString();
}
