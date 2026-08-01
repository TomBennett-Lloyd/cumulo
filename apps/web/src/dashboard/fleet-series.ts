import type { FleetActualsPoint, FleetForecastPoint, UtcIsoTimestamp } from '@cumulo/shared';

import type { ForecastChartPoint } from '../charts/ForecastChart';

/*
 * The fleet aggregate, as the chart's point shape — and how complete it is.
 *
 * Lifted out of `FleetAggregateView` so the panel column can render the fleet
 * without importing a whole view (`structure.md` rule 1: these were always
 * standalone functions over explicit inputs, and only their file said
 * otherwise). Both are pure and take what they read, so they are unit-testable
 * without a DOM.
 *
 * The summing is not here. `aggregateFleetForecast` / `aggregateFleetActuals`
 * in `@cumulo/shared` own every kilowatt of arithmetic (`architecture.md`
 * rule 3), including the comonotonic band addition whose statistical position
 * is stated in that module; this file joins their output to the chart's shape
 * and counts what went into it. There is deliberately no `+` over a power value
 * below — if one appears, a second definition of "the fleet total" has been
 * created.
 */

/**
 * The thinnest hour on display — the count the partial notice quotes.
 *
 * Seeded from the first point rather than from `Infinity` so an empty series answers 0 instead of a
 * number no caller could render.
 */
export const minimumContributingSites = (points: readonly FleetForecastPoint[]): number =>
  points.reduce(
    (lowest, point) => Math.min(lowest, point.contributingSiteCount),
    points[0]?.contributingSiteCount ?? 0,
  );

/**
 * Zip the two aggregated series into the chart's point shape.
 *
 * The forecast series is the x-domain: an aggregated actual whose hour has no forecast point is
 * dropped, because the chart has nowhere to put it and inventing a column would imply a forecast
 * that was never made. An hour with no measurement carries `actualKw: null`, which the chart draws
 * as a gap rather than a bridged line.
 */
export const joinFleetSeries = (
  points: readonly FleetForecastPoint[],
  actuals: readonly FleetActualsPoint[],
): readonly ForecastChartPoint[] => {
  const measuredByHour = new Map<UtcIsoTimestamp, number>(
    actuals.map((actual) => [actual.validTime, actual.acPowerKw]),
  );

  return points.map((point) => {
    const joined = {
      validTimeIso: point.validTime,
      medianKw: point.acPowerKw,
      actualKw: measuredByHour.get(point.validTime) ?? null,
    };

    // The key is omitted, never set to `undefined`: under `exactOptionalPropertyTypes` those are
    // different values, and the chart reads absence as "point estimate, draw no band".
    return point.uncertainty === undefined
      ? joined
      : {
          ...joined,
          band: {
            p10Kw: point.uncertainty.p10AcPowerKw,
            p90Kw: point.uncertainty.p90AcPowerKw,
          },
        };
  });
};
