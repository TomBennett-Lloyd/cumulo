import {
  aggregateFleetActuals,
  aggregateFleetForecast,
  type FleetActualsPoint,
  type FleetForecastPoint,
  type Forecast,
  type GenerationReading,
  type Site,
  type UtcIsoTimestamp,
} from '@cumulo/shared';

import type { ForecastChartPoint } from '../charts/ForecastChart';
import { fleetNightClassifier } from './fleet-night';

/*
 * The fleet aggregate, as the chart's point shape — and how complete it is.
 *
 * Lifted out of the old fleet aggregate view (deleted with the rest of them in
 * #148) so the content column can render the fleet
 * without importing a whole view (`structure.md` rule 1: these were always
 * standalone functions over explicit inputs, and only their file said
 * otherwise). Everything here is pure and takes what it reads, so it is
 * unit-testable without a DOM.
 *
 * The summing is not here. `aggregateFleetForecast` / `aggregateFleetActuals`
 * in `@cumulo/shared` own every kilowatt of arithmetic (`architecture.md`
 * rule 3), including the comonotonic band addition whose statistical position
 * is stated in that module; this file *calls* them, joins their output to the
 * chart's shape and counts what went into it. There is deliberately no `+` over
 * a power value below — if one appears, a second definition of "the fleet
 * total" has been created.
 *
 * `fleetChartAggregate` at the bottom is the whole pipeline under one name, and
 * that is what makes it memoizable by the panel: two aggregations and a join
 * that used to run from scratch on every render of a component whose sibling
 * poll re-renders it once a second during add-a-site (#293).
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
 *
 * Each hour is parsed **once**, before the sort, rather than twice per comparison — the change
 * #293 asked for, and it is a change of cost and shape only. These keys are same-format UTC ISO
 * strings, so their lexicographic and chronological orders coincide: no input distinguishes this
 * comparator from a string one, and no test can. What the epoch keys buy is O(n) parses instead of
 * O(n log n), while keeping the *stated* rule "by instant" true of the code rather than true by
 * luck of the spelling — which is why the parse stays at all.
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
  const hours = [...new Set([...forecastByHour.keys(), ...measuredByHour.keys()])]
    .map((validTime) => ({ validTime, epochMs: Date.parse(validTime) }))
    .sort((left, right) => left.epochMs - right.epochMs)
    .map((hour) => hour.validTime);

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

/**
 * Everything the panel's body draws from the fleet's two reads, as one value.
 *
 * The two travel together because they come out of the same aggregation pass:
 * the completeness line quotes the thinnest hour of the *forecast* aggregate, which is the same
 * array the points were joined from. Returned as a pair rather than recomputed at each use so the
 * fleet is summed once per answer rather than once per reader (#293) — the reason it is a value at
 * all, and not two exported functions the body calls in turn.
 *
 * Not to be confused with `FleetSeries` in `fleet-panel-body.tsx`: that one is the two *source*
 * reads, this one is what the chart draws from them.
 */
export interface FleetChartAggregate {
  readonly points: readonly ForecastChartPoint[];
  /** The thinnest hour on display, from the same forecast aggregate the points were joined from. */
  readonly minContributingSites: number;
}

/**
 * The answer for a fleet with nothing summed: no hours, and no site count to be short of.
 *
 * One shared value rather than a fresh `{ points: [] }` per call, so a panel that is loading,
 * failed or empty hands its chart the same array every render — the identity the ready arm gets
 * from the panel's memo, extended to the arms that have nothing to memoize.
 */
export const EMPTY_FLEET_AGGREGATE: FleetChartAggregate = { points: [], minContributingSites: 0 };

/**
 * The fleet's two reads, summed and joined into what the chart draws — the pipeline under one name.
 *
 * One function rather than three calls at the use site, because the three are one intent and
 * because a caller memoizing them is memoizing this and nothing else. `aggregateFleetForecast`'s
 * output is used twice and computed once, which is why the completeness count travels with the
 * points rather than being asked for separately: split across two calls, memoizing the points
 * would have left the count re-summing the whole fleet on every render.
 *
 * `sites` is here rather than in `joinFleetSeries` because night is not a property of the join.
 * The join's business is the union x-domain and what each series has to say at each hour; where
 * the fleet *is* is a fact about the fleet, and it arrives from the panel alongside the two reads.
 * Keeping it out of the join is also what leaves that function's own tests untouched by this layer.
 *
 * The classifier is built once per aggregate and applied per hour, which is the whole reason
 * `fleetNightClassifier` returns a function: whether there is a fleet to answer about at all is a
 * fact about the fleet, not about the hour. This runs inside the panel's memo, so the sites are
 * walked once per hour of one answer rather than once per hour of every render (#293's reasoning,
 * extended to this layer) — and that walk short-circuits at the first daylit site, so the daylight
 * hours, which are most of them, cost one solar position each.
 */
export const fleetChartAggregate = (
  forecasts: readonly Forecast[],
  readings: readonly GenerationReading[],
  sites: readonly Site[],
): FleetChartAggregate => {
  const forecastPoints = aggregateFleetForecast(forecasts);
  const isNight = fleetNightClassifier(sites);

  return {
    points: joinFleetSeries(forecastPoints, aggregateFleetActuals(readings)).map((point) => ({
      ...point,
      night: isNight(point.validTimeIso),
    })),
    minContributingSites: minimumContributingSites(forecastPoints),
  };
};
