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
 * The fan-out's whole answer: every row, or the first hour that has none.
 *
 * Two arms rather than a partial row list, because this service's policy is
 * all-or-nothing per message and has to stay that way. `consume-message.ts` fails
 * the record on the `implausible-hour` arm, which redelivers the whole message —
 * and that redelivery is only free because every write is an idempotent Put over
 * a deterministic key (ADR 0002). Writing the plausible rows and reporting the
 * rest would make the two halves of a message diverge in vintage on redelivery.
 */
export type LocationForecastsOutcome =
  | { readonly status: 'complete'; readonly forecasts: Forecast[] }
  | {
      readonly status: 'implausible-hour';
      readonly siteId: string;
      readonly validTime: UtcIsoTimestamp;
      readonly detail: string;
    };

/**
 * Every site × every hour, as `Forecast` rows ready to write.
 *
 * `sites.length × readings.length` rows, always — including the hours a site
 * generates nothing. A night hour produces a row with `acPowerKw: 0`, and that
 * row is the point rather than noise: the read side (`querySeriesRange`) plots
 * what it finds, so an absent row and a zero row are the difference between a
 * flat night and a hole in the chart nobody can explain.
 *
 * The one exception is the site-hour `@cumulo/forecast` reports `implausible` for:
 * a schema-valid weather hour whose physics lands outside `forecastSchema`'s
 * bounds. The fan-out stops at the first one and hands it back, because this
 * service's answer to "who does the operator need to call?" is the queue —
 * `consume-message.ts` fails the record, the redrive retries it, and the DLQ
 * alarm is the signal (#136). Deciding that here would put failure policy in the
 * pure core; reporting it keeps the decision one layer up where the queue is.
 */
export const locationForecasts = (input: LocationForecastsInput): LocationForecastsOutcome => {
  const forecasts: Forecast[] = [];

  for (const site of input.sites) {
    for (const weather of input.readings) {
      const result = createPhysicsForecast({ site, weather, issuedAt: input.issuedAt });
      if (result.status === 'implausible') {
        return {
          status: 'implausible-hour',
          siteId: result.siteId,
          validTime: result.validTime,
          detail: result.detail,
        };
      }
      forecasts.push(result.forecast);
    }
  }

  return { status: 'complete', forecasts };
};
