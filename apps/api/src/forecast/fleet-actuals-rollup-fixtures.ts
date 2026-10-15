import {
  fleetActualsAggregatePointSchema,
  utcIsoTimestampSchema,
  type FleetActualsAggregatePoint,
  type FleetSite,
  type SeriesKind,
  type UtcIsoTimestamp,
} from '@cumulo/shared';
import type { FleetRollupRow, SeriesPoint } from '@cumulo/storage';

import { fullBudgetDeadline } from '../api-fixtures';

import {
  readFleetActualsAggregate,
  type FleetActualsAggregateRead,
  type FleetActualsRollupReadDeps,
} from './fleet-actuals-rollup-read';
import { RANELAGH, RATHMINES, partial } from './fleet-rollup-fixtures';

/**
 * The actuals read's shared test support (#615): the window, the hours the cases name, and a
 * harness whose stub honours the windows it is asked for, so a double count is observable here.
 */

export const FROM = utcIsoTimestampSchema.parse('2026-07-30T12:00:00Z');
export const TO = utcIsoTimestampSchema.parse('2026-07-31T12:00:00Z');
/** The window's first hour, and one the producer no longer rewrites, and one it still does. */
export const FIRST_HOUR = '2026-07-30T12:00:00Z';
export const SETTLED_HOUR = '2026-07-31T06:00:00Z';
export const REWRITTEN_HOUR = '2026-07-31T10:00:00Z';
export const LONG_AGO = utcIsoTimestampSchema.parse('2026-07-01T00:00:00Z');

/** A GEN slice: no band, as `fleetActualsRollupPartials` writes it. */
export const slice = (validTime: string, acPowerKw: number) =>
  partial({
    validTime,
    acPowerKw,
    p10AcPowerKw: acPowerKw,
    p90AcPowerKw: acPowerKw,
    hasUncertainty: false,
  });

/** A settled hour's total, as the producer's compaction would have summed two locations. */
export const total = (validTime: string, acPowerKw: number): FleetActualsAggregatePoint =>
  fleetActualsAggregatePointSchema.parse({
    validTime,
    acPowerKw,
    contributingSiteCount: 2,
    contributingCapacityKw: 8.4,
  });

export const DUBLIN_SITES = [RANELAGH, RATHMINES];

type Window = [UtcIsoTimestamp, UtcIsoTimestamp];

export const harness = (
  rows: readonly FleetRollupRow[],
  pointsBySite: Readonly<Record<string, readonly SeriesPoint[]>> = {},
  totals: readonly FleetActualsAggregatePoint[] = [],
  options: { readonly totalsComplete?: boolean } = {},
) => {
  const kinds: SeriesKind[] = [];
  const sliceWindows: Window[] = [];
  const totalsWindows: Window[] = [];
  const siteReads: string[] = [];
  const logged: Record<string, unknown>[] = [];
  const deps: FleetActualsRollupReadDeps = {
    series: {
      queryFleetRollup: (kind, from, to) => {
        kinds.push(kind);
        sliceWindows.push([from, to]);
        return Promise.resolve({
          rows: rows.filter((row) => row.partial.validTime >= from && row.partial.validTime < to),
          complete: true,
        });
      },
      queryFleetActualsTotals: (from, to) => {
        totalsWindows.push([from, to]);
        return Promise.resolve({ rows: [...totals], complete: options.totalsComplete ?? true });
      },
      querySeriesRange: (siteId) => {
        siteReads.push(siteId);
        return Promise.resolve({ points: [...(pointsBySite[siteId] ?? [])], complete: true });
      },
    },
    log: (entry) => logged.push(entry),
  };
  return { deps, kinds, sliceWindows, totalsWindows, siteReads, logged };
};

export const read = (deps: FleetActualsRollupReadDeps, sites: readonly FleetSite[]) =>
  readFleetActualsAggregate(deps, fullBudgetDeadline, sites, FROM, TO, 'deadline-event');

export const pointsOf = (result: FleetActualsAggregateRead) => {
  if (!result.complete) {
    throw new Error('expected a complete read');
  }
  return result.points;
};
