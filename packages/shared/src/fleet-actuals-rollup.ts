import { z } from 'zod';

import {
  aggregateFleetActuals,
  contributingCapacityKwByHour,
  type SiteCapacity,
} from './aggregation';
import { sumFleetRollupPartials, type FleetRollupPartial } from './fleet-rollup';
import type { GenerationReading } from './generation-reading';
import type { SeriesKind } from './storage-key';
import { utcIsoTimestampSchema } from './timestamp';

/**
 * The actuals kind of the roll-up (ADR 0009's `GEN` segment, #506): the producer writes it and the
 * API reads it from this one declaration, for `FLEET_ROLLUP_FORECAST_KIND`'s reason (`fleet-rollup.ts`).
 */
export const FLEET_ROLLUP_ACTUALS_KIND = { kind: 'generation' } as const satisfies SeriesKind;

/** One hour of the summed fleet actuals: `fleetForecastAggregatePointSchema` without a band. */
export const fleetActualsAggregatePointSchema = z.object({
  validTime: utcIsoTimestampSchema,
  acPowerKw: z.number().gte(0),
  contributingSiteCount: z.int().gte(0),
  contributingCapacityKw: z.number().gte(0),
});

export type FleetActualsAggregatePoint = z.infer<typeof fleetActualsAggregatePointSchema>;

/**
 * One group of sites' readings as the per-hour partials a producer writes. A reading is a point
 * value, so each partial carries the degenerate band and `hasUncertainty: false`; the partial
 * schema is the forecast kind's, unchanged ("a producer, never a schema", ADR 0009).
 */
export const fleetActualsRollupPartials = (
  readings: readonly GenerationReading[],
  sites: readonly SiteCapacity[],
): readonly FleetRollupPartial[] => {
  const capacityKwByHour = contributingCapacityKwByHour(readings, sites);
  return aggregateFleetActuals(readings).map((point) => ({
    validTime: point.validTime,
    acPowerKw: point.acPowerKw,
    p10AcPowerKw: point.acPowerKw,
    p90AcPowerKw: point.acPowerKw,
    hasUncertainty: false,
    contributingSiteCount: point.contributingSiteCount,
    contributingCapacityKw: capacityKwByHour.get(point.validTime) ?? 0,
  }));
};

/** Sum actuals partials from any number of groups: {@link sumFleetRollupPartials}, band dropped. */
export const sumFleetActualsRollupPartials = (
  partials: readonly FleetRollupPartial[],
): readonly FleetActualsAggregatePoint[] =>
  sumFleetRollupPartials(partials).map((point) => ({
    validTime: point.validTime,
    acPowerKw: point.acPowerKw,
    contributingSiteCount: point.contributingSiteCount,
    contributingCapacityKw: point.contributingCapacityKw,
  }));

/**
 * The fleet actuals computed straight from raw readings — the API fallback's and the demo source's
 * path, composed from the two above for `fleetForecastAggregate`'s reason.
 */
export const fleetActualsAggregate = (
  readings: readonly GenerationReading[],
  sites: readonly SiteCapacity[],
): readonly FleetActualsAggregatePoint[] =>
  sumFleetActualsRollupPartials(fleetActualsRollupPartials(readings, sites));
