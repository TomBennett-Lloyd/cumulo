import type { Forecast, UncertaintyBand } from './forecast';
import type { GenerationReading } from './generation-reading';
import type { UtcIsoTimestamp } from './timestamp';

/**
 * Fleet aggregation — per-hour sums across the sites of a fleet.
 *
 * Pure by construction (architecture.md rule 3): no I/O, no clock, no ambient state. Everything a
 * point reports is a function of the entries handed in.
 *
 * Statistical position, stated because the choice is not neutral: the fleet band is the
 * elementwise sum of the site bands — fleet p10 = Σ site p10, fleet p90 = Σ site p90. Quantile
 * addition assumes perfect positive dependence between sites (comonotonicity); it is the
 * conservative upper bound on fleet spread, exact under a single monotone common weather driver,
 * chosen because the demo fleet clusters under shared synoptic weather and no inter-site
 * correlation model can be fitted before hindcast data (#16); it overstates fleet uncertainty to
 * the extent regions decorrelate.
 *
 * Model selection belongs to the caller: nothing here filters by `model`, so passing physics and
 * ML forecasts in one call would sum two models' views of the same site-hour. Pass a single model.
 *
 * The fleet band reuses `UncertaintyBand` as a *type* only. `uncertaintyBandSchema`'s 0–50 kW
 * bounds are per-site and cannot hold for a 60-site sum, so there is deliberately no fleet-level
 * schema here — fleet response contracts are #14's problem.
 */

/** The two fields aggregation groups on: one entry per site per hour. */
interface SiteHourEntry {
  readonly siteId: string;
  readonly validTime: UtcIsoTimestamp;
}

/** The surviving entries for one hour, after per-site deduplication. */
interface SiteHourGroup<Entry extends SiteHourEntry> {
  readonly validTime: UtcIsoTimestamp;
  readonly entries: readonly Entry[];
}

/**
 * Chronological comparison. `UtcIsoTimestamp` is fixed-width UTC by construction, so lexicographic
 * order *is* chronological order (see `timestamp.ts`) — no date parsing needed.
 */
const compareTimestamps = (left: UtcIsoTimestamp, right: UtcIsoTimestamp): number => {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
};

/**
 * Group entries by `validTime`, keeping at most one entry per `siteId` per hour, and return the
 * groups in ascending time order.
 *
 * `supersedes(candidate, incumbent)` decides which of two entries for the same site-hour survives;
 * it is a parameter rather than a mode flag because the two callers genuinely disagree about
 * vintage (forecasts have an `issuedAt`, readings have nothing to compare).
 */
const groupOnePerSitePerHour = <Entry extends SiteHourEntry>(
  entries: readonly Entry[],
  supersedes: (candidate: Entry, incumbent: Entry) => boolean,
): readonly SiteHourGroup<Entry>[] => {
  const byHour = new Map<UtcIsoTimestamp, Map<string, Entry>>();

  for (const entry of entries) {
    let bySite = byHour.get(entry.validTime);
    if (bySite === undefined) {
      bySite = new Map<string, Entry>();
      byHour.set(entry.validTime, bySite);
    }
    const incumbent = bySite.get(entry.siteId);
    if (incumbent === undefined || supersedes(entry, incumbent)) {
      bySite.set(entry.siteId, entry);
    }
  }

  return [...byHour.entries()]
    .sort(([left], [right]) => compareTimestamps(left, right))
    .map(([validTime, bySite]) => ({ validTime, entries: [...bySite.values()] }));
};

/** One hour of the fleet's forecast: the summed point estimate and, if any site had one, a band. */
export interface FleetForecastPoint {
  readonly validTime: UtcIsoTimestamp;
  readonly acPowerKw: number;
  readonly uncertainty?: UncertaintyBand;
  readonly contributingSiteCount: number;
}

/**
 * ADR 0002 collapses the issue-time axis: a later cycle replaces the earlier one for the same
 * site-hour. `>=` makes the last entry in input order win an `issuedAt` tie.
 */
const forecastSupersedes = (candidate: Forecast, incumbent: Forecast): boolean =>
  candidate.issuedAt >= incumbent.issuedAt;

const sumForecastGroup = (group: SiteHourGroup<Forecast>): FleetForecastPoint => {
  let acPowerKw = 0;
  let p10AcPowerKw = 0;
  let p90AcPowerKw = 0;
  let anySiteHasBand = false;

  for (const forecast of group.entries) {
    acPowerKw += forecast.acPowerKw;
    // A point estimate contributes a degenerate band — p10 = p90 = the estimate — so a site
    // without uncertainty shifts the fleet band's centre without widening it.
    p10AcPowerKw += forecast.uncertainty?.p10AcPowerKw ?? forecast.acPowerKw;
    p90AcPowerKw += forecast.uncertainty?.p90AcPowerKw ?? forecast.acPowerKw;
    if (forecast.uncertainty !== undefined) {
      anySiteHasBand = true;
    }
  }

  const point = {
    validTime: group.validTime,
    acPowerKw,
    contributingSiteCount: group.entries.length,
  };

  // Built conditionally, never assigned `undefined`: under `exactOptionalPropertyTypes` an absent
  // band and a present-but-undefined one are different values, and only absence is meaningful.
  return anySiteHasBand ? { ...point, uncertainty: { p10AcPowerKw, p90AcPowerKw } } : point;
};

/**
 * Sum a fleet's forecasts into one point per hour, ascending by `validTime`.
 *
 * Duplicates for the same site and hour collapse to the latest `issuedAt`; the band is present
 * only when at least one contributing forecast carried one. An empty input yields no points.
 */
export const aggregateFleetForecast = (
  forecasts: readonly Forecast[],
): readonly FleetForecastPoint[] =>
  groupOnePerSitePerHour(forecasts, forecastSupersedes).map(sumForecastGroup);

/** One hour of the fleet's measured output. */
export interface FleetActualsPoint {
  readonly validTime: UtcIsoTimestamp;
  readonly acPowerKw: number;
  readonly contributingSiteCount: number;
}

/**
 * A reading carries no vintage — nothing distinguishes two readings for the same site-hour — so
 * the last one in input order wins, mirroring the forecast tie-break.
 */
const readingSupersedes = (): boolean => true;

const sumActualsGroup = (group: SiteHourGroup<GenerationReading>): FleetActualsPoint => {
  let acPowerKw = 0;
  for (const reading of group.entries) {
    acPowerKw += reading.acPowerKw;
  }
  return {
    validTime: group.validTime,
    acPowerKw,
    contributingSiteCount: group.entries.length,
  };
};

/**
 * Sum a fleet's generation readings into one point per hour, ascending by `validTime`.
 *
 * Duplicates for the same site and hour collapse to the last one given. An empty input yields no
 * points.
 */
export const aggregateFleetActuals = (
  readings: readonly GenerationReading[],
): readonly FleetActualsPoint[] =>
  groupOnePerSitePerHour(readings, readingSupersedes).map(sumActualsGroup);
