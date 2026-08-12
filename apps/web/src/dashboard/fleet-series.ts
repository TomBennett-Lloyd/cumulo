import {
  aggregateFleetActuals,
  aggregateFleetForecast,
  contributingCapacityKwByHour,
  type FleetActualsPoint,
  type FleetForecastPoint,
  type Forecast,
  type GenerationReading,
  type Site,
  type UtcIsoTimestamp,
} from '@cumulo/shared';

import type { ForecastChartPoint } from '../charts/ForecastChart';
import type { ChartUnit } from './chart-unit';
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
 * total" has been created. The percent arm added by #291 does not breach that
 * rule and is not an exception to it: dividing an already-summed hour by an
 * already-summed divisor rescales one total, it does not compute a second one,
 * and the divisor itself is summed in `@cumulo/shared` too
 * (`contributingCapacityKwByHour`). The `+`-free reading of this file still
 * holds line by line.
 *
 * This is also the seam where the display unit is applied, and the only one.
 * Below it — storage, the API, `@cumulo/shared` — everything is kW and stays
 * kW; above it the chart is unit-agnostic apart from its axis title, its
 * percent floor and the word its readout speaks. Percentages therefore travel
 * in the `medianKw` / `p10Kw` / `p90Kw` / `actualKw` fields of
 * `ForecastChartPoint`, whose own docblock states that contract: those fields
 * carry the chart's *selected* display unit, not kW by definition.
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
 * Whether an hour has a divisor worth dividing by.
 *
 * An hour absent from the divisor map, or one whose contributing capacity came to `0`, is not a
 * fleet running at 0% — it is an hour whose capacity could not be evidenced, which
 * `contributingCapacityKwByHour` reaches only for entries whose `siteId` matches no known site. A
 * predicate rather than an inline comparison so the narrowing is visible to the compiler at both
 * use sites (`typing.md` rule 2: a type guard, never an assertion).
 */
const isUsableDivisor = (capacityKw: number | undefined): capacityKw is number =>
  capacityKw !== undefined && capacityKw > 0;

/** The one place the percentage is computed, shared by the median, the band edges and the actual. */
const percentOf = (kw: number, capacityKw: number): number => (kw / capacityKw) * 100;

/**
 * One value as a percentage of its hour's capacity — or `null`, which is the interesting answer.
 *
 * A `null` in stays `null` out: the gap rules `joinFleetSeries` establishes above survive the unit
 * change untouched. A divisor that is missing or non-positive *produces* one, rather than a zero or
 * a number divided by something that was not there — a break in the mark, on the same rule the rest
 * of this file applies (`error-handling.md` rule 5). Values above 100 pass through unclamped: a
 * fleet outrunning the nameplate its inverters are rated at is a real reading, and flattening it to
 * 100 would hide exactly the hour worth looking at.
 */
const toPercent = (kw: number | null, capacityKw: number | undefined): number | null =>
  kw === null || !isUsableDivisor(capacityKw) ? null : percentOf(kw, capacityKw);

/**
 * One joined hour, rescaled — the median and its band by the forecast's divisor, the actual by its
 * own.
 *
 * **Two divisors, because two different sets of sites answered.** The forecast's contributors at an
 * hour and the measurement's contributors at that same hour need not be the same sites: a site can
 * forecast an hour it never reported, or report one nobody forecast (the disjoint live windows this
 * file's join exists for). Dividing both series by one of them would put a percentage over capacity
 * that was never behind it.
 *
 * **The band divides by the median's divisor, not by one of its own**, which is what keeps
 * P10 ≤ median ≤ P90 true after the transform. The band is the same hour's uncertainty about the
 * same summed sites; giving it a separate divisor could only unnest it. When that divisor is
 * unusable the band is dropped whole — the key omitted, never `undefined`, exactly as the join does
 * it — because half a band is not a narrower band, it is a wrong one.
 */
const inPercentOfCapacity = (
  point: ForecastChartPoint,
  forecastCapacityKw: number | undefined,
  actualCapacityKw: number | undefined,
): ForecastChartPoint => {
  const { band, ...rest } = point;
  const scaled = {
    ...rest,
    medianKw: toPercent(point.medianKw, forecastCapacityKw),
    actualKw: toPercent(point.actualKw, actualCapacityKw),
  };

  return band === undefined || !isUsableDivisor(forecastCapacityKw)
    ? scaled
    : {
        ...scaled,
        band: {
          p10Kw: percentOf(band.p10Kw, forecastCapacityKw),
          p90Kw: percentOf(band.p90Kw, forecastCapacityKw),
        },
      };
};

/**
 * The joined series in percent of the capacity actually behind each hour.
 *
 * The divisors come from the *unaggregated* per-site reads rather than from the aggregate, because
 * the aggregate does not carry them: `contributingSiteCount` is a count, and a count times the mean
 * site is only the right divisor on a fleet of identical sites. The exact per-hour sum is
 * `@cumulo/shared`'s to compute and that module's docblock owns the reasoning; both reads are
 * already in the caller's hand, so it costs one pass each.
 *
 * The maps are keyed by `UtcIsoTimestamp` and read here by the joined point's `validTimeIso`, which
 * is the same string with the brand dropped at the chart's boundary — read through
 * `ReadonlyMap<string, number>`, so the widening is a declaration rather than an assertion.
 */
const percentOfCapacitySeries = (
  points: readonly ForecastChartPoint[],
  forecasts: readonly Forecast[],
  readings: readonly GenerationReading[],
  sites: readonly Site[],
): readonly ForecastChartPoint[] => {
  const forecastCapacityKwByHour: ReadonlyMap<string, number> = contributingCapacityKwByHour(
    forecasts,
    sites,
  );
  const actualCapacityKwByHour: ReadonlyMap<string, number> = contributingCapacityKwByHour(
    readings,
    sites,
  );

  return points.map((point) =>
    inPercentOfCapacity(
      point,
      forecastCapacityKwByHour.get(point.validTimeIso),
      actualCapacityKwByHour.get(point.validTimeIso),
    ),
  );
};

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
 *
 * `unit` is applied last of all and changes nothing about how the fleet is summed: both arms
 * aggregate and join in kW, and `'percent'` then rescales the joined points. Two consequences worth
 * stating, because both are load-bearing. `minContributingSites` is a count of sites and is the
 * same number in either unit — the completeness notice does not move when the toggle does. And the
 * night flag is a fact about the sun, so it is stamped on the rescaled points exactly as it was on
 * the kW ones; the `'kw'` arm is today's pipeline unchanged, value for value.
 */
export const fleetChartAggregate = (
  forecasts: readonly Forecast[],
  readings: readonly GenerationReading[],
  sites: readonly Site[],
  unit: ChartUnit,
): FleetChartAggregate => {
  const forecastPoints = aggregateFleetForecast(forecasts);
  const joined = joinFleetSeries(forecastPoints, aggregateFleetActuals(readings));
  const scaled =
    unit === 'kw' ? joined : percentOfCapacitySeries(joined, forecasts, readings, sites);
  const isNight = fleetNightClassifier(sites);

  return {
    points: scaled.map((point) => ({
      ...point,
      night: isNight(point.validTimeIso),
    })),
    minContributingSites: minimumContributingSites(forecastPoints),
  };
};
