import type { FleetActualsPoint, FleetForecastPoint, UtcIsoTimestamp } from '@cumulo/shared';

import type { ForecastChartPoint } from '../charts/ForecastChart';

/*
 * The fleet aggregate, as the chart's point shape — and how complete it is.
 *
 * Lifted out of the old fleet aggregate view (deleted with the rest of them in
 * #148) so the content column can render the fleet
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
 * Every hour either series knows about, in time order, as the chart's point shape.
 *
 * **The x-domain is the union, and that is the whole point of this function.** It used to be the
 * forecast alone, with an actual whose hour had no forecast simply dropped — which was invisible
 * against the demo source, whose two windows overlap, and silently fatal against the deployed one.
 * The live fleet reads its forecasts as a forward horizon (`/v1/sites/{id}/forecast`, future hours
 * only) and its actuals as a look-back (`/v1/fleet/actuals`, `[now−h, now)`), so the two windows
 * are disjoint for every value of the clock: under the old rule every simulated actual was dropped
 * and the live chart could never draw one, under a legend and an accessible name that both
 * promised otherwise (#264).
 *
 * What a row missing half its series does *not* do is invent the missing half. A past hour carries
 * `medianKw: null` and no band; a future hour carries `actualKw: null`. Both read as gaps, on the
 * rule the chart already applied to the actuals and the overlay — a bridged line or a zero would
 * draw a forecast nobody made or a reading nobody took, which is the widening failure this whole
 * ticket is about (`error-handling.md` rule 5).
 *
 * Ordered by instant rather than by string: both inputs arrive sorted from `@cumulo/shared`'s
 * aggregation, but a merge of two sorted sequences still has to compare across them, and comparing
 * the parsed instants keeps the ordering rule out of the timestamp's spelling.
 */
export const joinFleetSeries = (
  points: readonly FleetForecastPoint[],
  actuals: readonly FleetActualsPoint[],
): readonly ForecastChartPoint[] => {
  const forecastByHour = new Map<UtcIsoTimestamp, FleetForecastPoint>(
    points.map((point) => [point.validTime, point]),
  );
  const measuredByHour = new Map<UtcIsoTimestamp, number>(
    actuals.map((actual) => [actual.validTime, actual.acPowerKw]),
  );
  const hours = [...new Set([...forecastByHour.keys(), ...measuredByHour.keys()])].sort(
    (left, right) => Date.parse(left) - Date.parse(right),
  );

  return hours.map((validTime) => {
    const forecast = forecastByHour.get(validTime);
    const joined = {
      validTimeIso: validTime,
      medianKw: forecast?.acPowerKw ?? null,
      actualKw: measuredByHour.get(validTime) ?? null,
    };

    // The key is omitted, never set to `undefined`: under `exactOptionalPropertyTypes` those are
    // different values, and the chart reads absence as "point estimate, draw no band".
    const uncertainty = forecast?.uncertainty;
    return uncertainty === undefined
      ? joined
      : {
          ...joined,
          band: { p10Kw: uncertainty.p10AcPowerKw, p90Kw: uncertainty.p90AcPowerKw },
        };
  });
};
