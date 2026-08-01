import { createPhysicsForecast } from '@cumulo/forecast';
import type {
  Forecast,
  ForecastWeatherReading,
  SitePhysics,
  UtcIsoTimestamp,
} from '@cumulo/shared';

/**
 * One location's weather horizon, fanned out across the sites at that location.
 *
 * This is the whole of the service's domain logic and it is pure: no clock, no
 * I/O, no environment (`docs/standards/architecture.md` rule 3). The vintage
 * arrives as a parameter precisely so that it is — a `new Date()` here would make
 * the one function worth testing densely the one function a test cannot pin.
 *
 * Site-major rather than reading-major, and the order is not arbitrary: it is the
 * order the rows are written in, and `cumulo-series` partitions by site (ADR
 * 0002), so a site's whole horizon lands in one contiguous run. That keeps each
 * `BatchWriteItem` page mostly within a single partition instead of spraying
 * every page across all of them.
 */

/**
 * Everything the fan-out needs. Named and exported rather than inlined into the
 * signature (`docs/standards/typing.md` rule 6): the caller in
 * `consume-message.ts` assembles this from three different sources and benefits
 * from a contract it can name.
 */
export interface LocationForecastsInput {
  /**
   * The active sites at the location, as `SiteAdapter.listActiveSitePhysicsAtLocation`
   * returns them — the `by-location` index's projection, which is exactly the set
   * of fields the physics chain reads.
   */
  readonly sites: readonly SitePhysics[];
  /** The location's horizon: one reading per hour, from one queue message. */
  readonly readings: readonly ForecastWeatherReading[];
  /** The forecast vintage stamped on every row this call produces. */
  readonly issuedAt: UtcIsoTimestamp;
}

/**
 * Every site × every hour, as `Forecast` rows ready to write.
 *
 * `sites.length × readings.length` rows, always — including the hours a site
 * generates nothing. A night hour produces a row with `acPowerKw: 0`, and that
 * row is the point rather than noise: the read side (`querySeriesRange`) plots
 * what it finds, so an absent row and a zero row are the difference between a
 * flat night and a hole in the chart nobody can explain.
 *
 * Not caught here: `createPhysicsForecast` parses its own result and throws on a
 * value outside `forecastSchema`'s bounds. That throw is the caller's to convert
 * (see `consume-message.ts`), which keeps this function a total description of
 * the fan-out rather than a place failure policy is decided.
 */
export const locationForecasts = (input: LocationForecastsInput): Forecast[] => {
  const forecasts: Forecast[] = [];

  for (const site of input.sites) {
    for (const weather of input.readings) {
      forecasts.push(createPhysicsForecast({ site, weather, issuedAt: input.issuedAt }));
    }
  }

  return forecasts;
};
