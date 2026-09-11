import {
  aggregateFleetForecast,
  contributingCapacityKwByHour,
  type SiteCapacity,
} from './aggregation';
import type { Forecast, UncertaintyBand } from './forecast';
import { compareUtcIsoTimestamps, type UtcIsoTimestamp } from './timestamp';

/**
 * The fleet roll-up: the fleet aggregate split into per-location **partials** that a per-location
 * producer can write on its own, and summed back at read (ADR 0009, #494).
 *
 * ## Why this module exists at all
 *
 * `GET /v1/fleet/forecast` used to answer by reading every site's partition and summing in the
 * request — 1,753.9 ms p50 / 2,998.9 ms p95 warm, on a visitor's first paint. ADR 0002 named
 * exactly that as the trigger for a cached aggregate, and ADR 0009 takes it.
 *
 * The shape is forced by the producer, not chosen: ADR 0004 makes one SQS message one *location's*
 * whole horizon, so there is no "end of a forecast run" event any message could hook. Each message
 * therefore writes only what is already in its hand — its own location's contribution to each hour
 * — and the read sums whatever partials are there.
 *
 * ## Additivity is the load-bearing claim, so it is stated rather than assumed
 *
 * A partial can only carry a field that is an **additive per-hour total**, because the read adds
 * partials and nothing else. Every field the fleet aggregate reports is one:
 *
 * - `acPowerKw`, `p10AcPowerKw`, `p90AcPowerKw` and `contributingCapacityKw` are sums over sites,
 *   and a sum over a partition of the sites is the sum over all of them.
 * - `contributingSiteCount` is a count, which is the same statement.
 * - `hasUncertainty` is the one non-numeric one: a boolean OR, which is an additive fold in every
 *   sense that matters here (associative, commutative, identity `false`). It is carried as a flag
 *   rather than derived from the quantiles because a band is only *absent* when no contributing
 *   site had one — and a site without a band still contributes `p10 = p90 = acPowerKw`, so the
 *   quantile sums alone cannot tell "no band anywhere" from "every band happens to be degenerate".
 *
 * The claim that makes those sums exact is **disjointness**, and it is structural: a site's
 * `locationId` is a pure function of its own coordinates (`location.ts`), so a site belongs to
 * exactly one location and appears in exactly one partial. Per-site de-duplication therefore never
 * has cross-partial work to do, which is why {@link sumFleetRollupPartials} adds rather than
 * re-deduplicating. A producer that wrote two locations' sites into one partial, or one site into
 * two, would break this — and nothing in `apps/forecast` can, because the message it consumes is
 * refused unless it names exactly one location.
 *
 * `minimumContributingSites` — the thinnest-hour count the partial-aggregate notice quotes — is
 * **not** additive, and deliberately does not live here: it is a `min` over hours of the
 * *already-summed* counts, so it is computed at the consumer from this module's output, exactly as
 * it was before the roll-up existed.
 *
 * ## The one way the two paths differ, stated rather than absorbed
 *
 * IEEE-754 addition is not associative. Adding a fleet's sixty terms grouped by location and adding
 * them in one pass therefore land a bit or two apart — measured at **~1.4e-14 kW on a ~117 kW
 * fleet total** (`fleet-rollup-additivity.test.ts`, which bounds it at a nanowatt and would fail if
 * it widened). That is the *entire* discrepancy between this roll-up and the fan-out it replaces:
 * no field is lost and nothing is approximated. It is six orders of magnitude below the watt
 * precision a power value in this repo claims, so it is invisible to every consumer — but it is why
 * the proof asserts a bound rather than equality, and why it says so out loud.
 *
 * Rounding partials to watt precision at the write boundary was considered for exactly that reason
 * and **rejected**: twelve rounded partials can sum 6 mW away from the unrounded fleet, a thousand
 * times worse than the association error it would be fixing.
 *
 * ## One definition of the fleet total, still
 *
 * Every kilowatt below comes out of `aggregation.ts` — {@link aggregateFleetForecast} and
 * {@link contributingCapacityKwByHour}. There is no `+` over a power value in this file that is not
 * a fold of values those two produced, which is the rule `apps/web/src/dashboard/fleet-series.ts`
 * already states for the client, applied to the producer. `docs/standards/architecture.md` rule 3
 * is why: a second place that knows how to add up a fleet is a second definition of what the fleet
 * generates, and the two only agree until someone edits one.
 *
 * Pure by construction: no I/O, no clock, no ambient state. The storage shape of a partial belongs
 * to `@cumulo/storage`; this module owns only the arithmetic and the vocabulary.
 */

/**
 * One location's additive contribution to one hour of the fleet aggregate.
 *
 * No `locationId` field: which location a partial speaks for is part of its **key**, not of its
 * arithmetic, and keeping it out is what lets {@link fleetForecastAggregate} run the same code over
 * a whole fleet treated as one group. `@cumulo/storage` carries the location alongside the stored
 * item.
 */
export interface FleetRollupPartial {
  readonly validTime: UtcIsoTimestamp;
  /** Σ `acPowerKw` over this group's sites at this hour. */
  readonly acPowerKw: number;
  /** Σ of each site's `p10AcPowerKw`, or its point estimate where it carried no band. */
  readonly p10AcPowerKw: number;
  /** Σ of each site's `p90AcPowerKw`, or its point estimate where it carried no band. */
  readonly p90AcPowerKw: number;
  /** Whether *any* site in this group carried a band at this hour — see the module docblock. */
  readonly hasUncertainty: boolean;
  /** How many distinct sites in this group reported this hour. */
  readonly contributingSiteCount: number;
  /** Σ nameplate `capacityKw` over exactly those sites — the %-of-capacity divisor. */
  readonly contributingCapacityKw: number;
}

/**
 * One hour of the summed fleet forecast, as a reader of the aggregate sees it.
 *
 * `FleetForecastPoint` (`aggregation.ts`) plus the per-hour contributing capacity, which is the
 * divisor the web chart's `%` mode needs and which that type does not carry because
 * `aggregateFleetForecast` is not given the sites. Carrying it here is what lets the client stop
 * holding every site's raw forecast just to compute a divisor from it.
 *
 * The band is absent rather than `undefined` when no site had one, matching `FleetForecastPoint`:
 * under `exactOptionalPropertyTypes` those are different values, and only absence is meaningful.
 */
export interface FleetForecastAggregatePoint {
  readonly validTime: UtcIsoTimestamp;
  readonly acPowerKw: number;
  readonly uncertainty?: UncertaintyBand;
  readonly contributingSiteCount: number;
  readonly contributingCapacityKw: number;
}

/**
 * One group of sites' forecasts, as the per-hour partials a producer writes — ascending by
 * `validTime`, one per hour the group reported.
 *
 * The group is whatever the caller hands in: the forecast service passes one location's sites and
 * their forecasts, and {@link fleetForecastAggregate} passes a whole fleet, which is the
 * one-group case. Duplicates for a site-hour collapse to the latest `issuedAt` before anything is
 * summed, because {@link aggregateFleetForecast} does it.
 *
 * `sites` supplies the capacity behind each hour. A forecast whose `siteId` matches no entry there
 * contributes `0` capacity — `contributingCapacityKwByHour`'s rule, kept rather than papered over:
 * capacity that cannot be evidenced is not asserted, and a partial claiming otherwise would inflate
 * the divisor the `%` view reads.
 */
export const fleetRollupPartials = (
  forecasts: readonly Forecast[],
  sites: readonly SiteCapacity[],
): readonly FleetRollupPartial[] => {
  const capacityKwByHour = contributingCapacityKwByHour(forecasts, sites);

  return aggregateFleetForecast(forecasts).map((point) => ({
    validTime: point.validTime,
    acPowerKw: point.acPowerKw,
    // The degenerate band, spelled the same way `sumForecastGroup` spells it per site: a point
    // estimate is a band of zero width, so a site without one shifts the sum's centre without
    // widening it. Applying it here — once per group, over an already-summed hour — is the same
    // arithmetic as applying it per site, because both are sums of the same per-site terms.
    p10AcPowerKw: point.uncertainty?.p10AcPowerKw ?? point.acPowerKw,
    p90AcPowerKw: point.uncertainty?.p90AcPowerKw ?? point.acPowerKw,
    hasUncertainty: point.uncertainty !== undefined,
    contributingSiteCount: point.contributingSiteCount,
    contributingCapacityKw: capacityKwByHour.get(point.validTime) ?? 0,
  }));
};

/** The running total for one hour, before it is rendered as a point. */
interface HourTotal {
  acPowerKw: number;
  p10AcPowerKw: number;
  p90AcPowerKw: number;
  hasUncertainty: boolean;
  contributingSiteCount: number;
  contributingCapacityKw: number;
}

const emptyHourTotal = (): HourTotal => ({
  acPowerKw: 0,
  p10AcPowerKw: 0,
  p90AcPowerKw: 0,
  hasUncertainty: false,
  contributingSiteCount: 0,
  contributingCapacityKw: 0,
});

/**
 * Sum partials from any number of groups into the fleet aggregate, ascending by `validTime`.
 *
 * Partials for the same hour from different groups add; an hour no group reported is absent from
 * the result rather than present as a zero, which is the same rule the aggregation it descends from
 * applies — an unreported hour is a gap, and a gap drawn as zero is a fleet that generated nothing
 * rather than a fleet nobody asked about.
 *
 * Input order is irrelevant and duplicates are *not* de-duplicated: this is addition, and the
 * caller's job is to hand in each group once. That is safe because the only producer of these is
 * keyed by `(kind, hour, location)` and DynamoDB cannot return one key twice from one Query — and
 * it is the reason the module docblock spends a paragraph on disjointness rather than a sentence.
 */
export const sumFleetRollupPartials = (
  partials: readonly FleetRollupPartial[],
): readonly FleetForecastAggregatePoint[] => {
  const totalsByHour = new Map<UtcIsoTimestamp, HourTotal>();

  for (const partial of partials) {
    let total = totalsByHour.get(partial.validTime);
    if (total === undefined) {
      total = emptyHourTotal();
      totalsByHour.set(partial.validTime, total);
    }
    total.acPowerKw += partial.acPowerKw;
    total.p10AcPowerKw += partial.p10AcPowerKw;
    total.p90AcPowerKw += partial.p90AcPowerKw;
    total.hasUncertainty ||= partial.hasUncertainty;
    total.contributingSiteCount += partial.contributingSiteCount;
    total.contributingCapacityKw += partial.contributingCapacityKw;
  }

  return [...totalsByHour.entries()]
    .sort(([left], [right]) => compareUtcIsoTimestamps(left, right))
    .map(([validTime, total]) => {
      const point = {
        validTime,
        acPowerKw: total.acPowerKw,
        contributingSiteCount: total.contributingSiteCount,
        contributingCapacityKw: total.contributingCapacityKw,
      };
      // Built conditionally, never assigned `undefined` — see {@link FleetForecastAggregatePoint}.
      return total.hasUncertainty
        ? {
            ...point,
            uncertainty: { p10AcPowerKw: total.p10AcPowerKw, p90AcPowerKw: total.p90AcPowerKw },
          }
        : point;
    });
};

/**
 * The fleet aggregate computed straight from raw forecasts — the whole fleet as one group.
 *
 * Two callers, and they are the reason this is a composition of the two functions above rather than
 * a third implementation: the API's fallback for a `#FLEET` partition that is missing or
 * incomplete, and the web app's demo source, which has no API behind it and generates its fleet in
 * the browser. Both must produce *the same* numbers the producer-written path produces, and the
 * cheapest way to guarantee that is for all three to be the same code.
 *
 * It is also the executable statement of this module's additivity claim: summing one group is the
 * degenerate case of summing many, so `fleetForecastAggregate(all, sites)` and
 * `sumFleetRollupPartials(each location's partials)` must be equal — which is what
 * `fleet-rollup-additivity.test.ts` pins over the canonical 12 × 5 fleet, to within the association
 * bound the section above states.
 */
export const fleetForecastAggregate = (
  forecasts: readonly Forecast[],
  sites: readonly SiteCapacity[],
): readonly FleetForecastAggregatePoint[] =>
  sumFleetRollupPartials(fleetRollupPartials(forecasts, sites));
