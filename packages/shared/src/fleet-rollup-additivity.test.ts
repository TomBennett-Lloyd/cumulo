import { describe, expect, it } from 'vitest';

import { aggregateFleetForecast, contributingCapacityKwByHour } from './aggregation';
import { canonicalFleetSeed, generateFleet } from './fleet';
import {
  fleetForecastAggregate,
  fleetRollupPartials,
  sumFleetRollupPartials,
  type FleetForecastAggregatePoint,
} from './fleet-rollup';
import { forecastSchema, type Forecast } from './forecast';
import { locationId } from './location';
import type { Site } from './site';

/**
 * The additivity proof — ADR 0009's load-bearing claim, made executable.
 *
 * The whole design rests on one equality: **the fleet aggregate computed over every site at once
 * equals the sum of per-location partials computed independently.** If that stops holding — a new
 * field that is not an additive per-hour total, a de-duplication rule that reaches across locations
 * — the roll-up starts answering a different question from the one the client used to ask, hour by
 * hour and silently, because both answers look like plausible kilowatts.
 *
 * Its own file rather than a block in `fleet-rollup.test.ts` (`docs/standards/structure.md` rule 7):
 * that suite pins the behaviour of two functions, this one pins a property of the *design*, over a
 * fixture — the canonical fleet — that neither function knows about.
 *
 * **The canonical 12 × 5 fleet, not a hand-built pair of sites**, because the property is about a
 * real partition into real locations. `generateFleet`'s clusters are exactly the `locationId`
 * buckets the producer's messages are keyed by — `fleet.ts` bounds the jitter box below half a
 * bucket so a site cannot round into a neighbour — so the grouping below is the grouping the
 * deployed pipeline performs, not a stand-in for it.
 */

const noon = '2026-07-30T12:00:00Z';
const onePm = '2026-07-30T13:00:00Z';
const twoPm = '2026-07-30T14:00:00Z';
const hours = [noon, onePm, twoPm];

const fleet: readonly Site[] = generateFleet(canonicalFleetSeed);

/**
 * A deterministic hour of output per site — varied kW, and a band on only the larger sites, so the
 * OR-fold that decides band presence is exercised rather than assumed.
 *
 * Parsed through `forecastSchema`, which is both the cast-free way to brand the timestamps and a
 * standing check that these are forecasts a real producer could have emitted.
 */
const forecastFor = (site: Site, hourIndex: number, offset: number): Forecast => {
  const acPowerKw = Number(((site.capacityKw * (hourIndex + 1)) / 10 + offset).toFixed(3));
  const banded = site.capacityKw > 4;
  return forecastSchema.parse({
    siteId: site.id,
    model: 'physics',
    validTime: hours[hourIndex] ?? noon,
    issuedAt: '2026-07-30T06:00:00Z',
    weatherSource: 'open-meteo',
    poaIrradianceWm2: 0,
    acPowerKw,
    ...(banded
      ? {
          uncertainty: {
            p10AcPowerKw: Number((acPowerKw * 0.8).toFixed(3)),
            p90AcPowerKw: Number((acPowerKw * 1.2).toFixed(3)),
          },
        }
      : {}),
  });
};

const allForecasts: readonly Forecast[] = fleet.flatMap((site, siteIndex) =>
  hours.map((_hour, hourIndex) => forecastFor(site, hourIndex, siteIndex / 100)),
);

const sitesByLocation = (): ReadonlyMap<string, readonly Site[]> => {
  const groups = new Map<string, Site[]>();
  for (const site of fleet) {
    const id = locationId(site);
    const group = groups.get(id) ?? [];
    group.push(site);
    groups.set(id, group);
  }
  return groups;
};

/** Exactly what twelve independent forecast Lambda invocations would each write. */
const perLocationPartials = () =>
  [...sitesByLocation().values()].flatMap((locationSites) => {
    const siteIds = new Set(locationSites.map((site) => site.id));
    return fleetRollupPartials(
      allForecasts.filter((forecast) => siteIds.has(forecast.siteId)),
      locationSites,
    );
  });

/**
 * The tightest tolerance a float sum can honour: `1e-9` kW — a **microwatt**.
 *
 * Named in the unit these numbers are actually in. A kilowatt's ninth decimal place is 1e-9 kW,
 * which is 1e-6 W: a microwatt, not the nanowatt an earlier draft of this file called it. The
 * arithmetic was always right and the word was wrong by three orders, which is exactly the kind of
 * slip a named constant is supposed to stop rather than spread — so the name carries the unit and
 * the comment carries the conversion. See the `it` below.
 */
const MICROWATT_PLACES = 9;

const expectAggregatesAgree = (
  actual: readonly FleetForecastAggregatePoint[],
  expected: readonly FleetForecastAggregatePoint[],
): void => {
  // Everything discrete is compared exactly: nothing about grouping may move which hours exist,
  // in what order, how many sites answered, or whether the hour has a band at all.
  expect(actual.map((point) => point.validTime)).toEqual(expected.map((point) => point.validTime));
  expect(actual.map((point) => point.contributingSiteCount)).toEqual(
    expected.map((point) => point.contributingSiteCount),
  );
  expect(actual.map((point) => point.uncertainty !== undefined)).toEqual(
    expected.map((point) => point.uncertainty !== undefined),
  );

  actual.forEach((point, index) => {
    const want = expected[index];
    expect(want).toBeDefined();
    expect(point.acPowerKw).toBeCloseTo(want?.acPowerKw ?? Number.NaN, MICROWATT_PLACES);
    expect(point.contributingCapacityKw).toBeCloseTo(
      want?.contributingCapacityKw ?? Number.NaN,
      MICROWATT_PLACES,
    );
    if (point.uncertainty !== undefined && want?.uncertainty !== undefined) {
      expect(point.uncertainty.p10AcPowerKw).toBeCloseTo(
        want.uncertainty.p10AcPowerKw,
        MICROWATT_PLACES,
      );
      expect(point.uncertainty.p90AcPowerKw).toBeCloseTo(
        want.uncertainty.p90AcPowerKw,
        MICROWATT_PLACES,
      );
    }
  });
};

describe('the roll-up partition is the fleet partition', () => {
  it('splits the canonical fleet into exactly the 12 weather locations, 5 sites each', () => {
    const groups = sitesByLocation();
    expect(groups.size).toBe(12);
    expect([...groups.values()].every((group) => group.length === 5)).toBe(true);
  });

  it('gives every site exactly one location, so no partial can double-count one', () => {
    const counted = [...sitesByLocation().values()].flat();
    expect(counted).toHaveLength(fleet.length);
    expect(new Set(counted.map((site) => site.id)).size).toBe(fleet.length);
  });
});

describe('partials sum to the whole-fleet aggregate', () => {
  it('agrees on every field, discrete ones exactly and kilowatts to a microwatt', () => {
    expectAggregatesAgree(
      sumFleetRollupPartials(perLocationPartials()),
      fleetForecastAggregate(allForecasts, fleet),
    );
  });

  /**
   * The one place the two paths genuinely differ, named and bounded rather than absorbed.
   *
   * IEEE-754 addition is not associative, so adding the same 60 terms grouped by location and
   * adding them in one pass land a bit or two apart — measured here at ~2e-14 kW: worst case
   * `2.1e-14` on the 50.9 kW hour, `1.4e-14` on the 117.4 kW one. That is the *entire* discrepancy
   * between the roll-up and the fan-out it replaces: there is no field the partial cannot carry and
   * nothing is approximated.
   *
   * **What this bound covers is `acPowerKw`**, which is what the reduce below reads. The same
   * phenomenon moves the other sums by the same order — the per-hour contributing capacity differs
   * by `1.1e-13` kW on this fixture — and `expectAggregatesAgree` above already holds every field
   * to `MICROWATT_PLACES`, so the field this one singles out is the one a reader of a chart would
   * see.
   *
   * A microwatt is six orders of magnitude tighter than the watt precision a power value in this
   * repo claims, and the measurement is another five below the microwatt, so the bound is "exact
   * for every purpose the number is put to" rather than a tolerance hiding a difference. Asserted as a
   * number so a change that widened it — a rounding step at the write boundary, say — fails here
   * instead of drifting the chart quietly.
   *
   * Rounding partials to a watt each was considered for exactly that reason and rejected: a watt of
   * precision is half a watt of error per partial, so twelve of them can put the summed fleet 6 W
   * (`0.006` kW) from the unrounded one — eleven orders of magnitude worse than the association
   * error it would be fixing.
   */
  it('differs from the one-pass sum by float association only, under a microwatt', () => {
    const grouped = sumFleetRollupPartials(perLocationPartials());
    const whole = fleetForecastAggregate(allForecasts, fleet);

    const worstKw = grouped.reduce(
      (largest, point, index) =>
        Math.max(largest, Math.abs(point.acPowerKw - (whole[index]?.acPowerKw ?? Number.NaN))),
      0,
    );

    expect(worstKw).toBeGreaterThanOrEqual(0);
    expect(worstKw).toBeLessThan(1e-9);
  });
});

describe('the aggregate is what the client used to compute', () => {
  it('is field-for-field identical to aggregateFleetForecast plus its per-hour divisor', () => {
    const points = aggregateFleetForecast(allForecasts);
    const capacityKwByHour = contributingCapacityKwByHour(allForecasts, fleet);

    // Exact, not close: one group means one addition order — the same terms in the same sequence
    // `aggregateFleetForecast` itself uses, which is what `fleetForecastAggregate` composes.
    expect(fleetForecastAggregate(allForecasts, fleet)).toEqual(
      points.map((point) => ({
        validTime: point.validTime,
        acPowerKw: point.acPowerKw,
        ...(point.uncertainty === undefined ? {} : { uncertainty: point.uncertainty }),
        contributingSiteCount: point.contributingSiteCount,
        contributingCapacityKw: capacityKwByHour.get(point.validTime) ?? 0,
      })),
    );
  });

  it('counts and divides by the whole fleet on an hour every site reported', () => {
    const noonPoint = fleetForecastAggregate(allForecasts, fleet).find(
      (point) => point.validTime === noon,
    );

    expect(noonPoint?.contributingSiteCount).toBe(fleet.length);
    expect(noonPoint?.contributingCapacityKw).toBeCloseTo(
      fleet.reduce((total, site) => total + site.capacityKw, 0),
      MICROWATT_PLACES,
    );
  });
});
