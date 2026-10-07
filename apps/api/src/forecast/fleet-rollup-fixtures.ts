import {
  fleetRollupMembers,
  fleetRollupPartialSchema,
  utcIsoTimestampSchema,
  type FleetRollupPartial,
  type FleetSite,
  type UtcIsoTimestamp,
} from '@cumulo/shared';
import type { FleetRollupRow, SeriesPoint } from '@cumulo/storage';

import { fleetSite, fullBudgetDeadline, RATHMINES_ID } from '../api-fixtures';

import {
  readFleetForecastAggregate,
  type FleetForecastAggregateRead,
  type FleetRollupReadDeps,
} from './fleet-rollup-read';

/**
 * The `#FLEET` fixtures `fleet-rollup-read.test.ts` and `get-fleet-forecast.test.ts` share. Test
 * support.
 */

export const RANELAGH = fleetSite();
export const RATHMINES = fleetSite({ id: RATHMINES_ID, name: 'Rathmines terrace' });
/** Both Dublin fixtures round into one weather bucket — the unit the producer writes a partial for. */
export const DUBLIN = '53.32,-6.26';

/** A second bucket, so "some locations have written and some have not" is expressible. */
export const BRISTOL = '51.45,-2.59';
export const BRISTOL_SITE = fleetSite({
  id: '7c9e6679-7425-40de-944b-e07fc1f90111',
  name: 'Bristol terrace',
  latitude: 51.4545,
  longitude: -2.5879,
});

export const partial = (
  overrides: Partial<Record<keyof FleetRollupPartial, unknown>> = {},
): FleetRollupPartial =>
  fleetRollupPartialSchema.parse({
    validTime: '2026-07-31T13:00:00Z',
    acPowerKw: 5,
    p10AcPowerKw: 4,
    p90AcPowerKw: 6,
    hasUncertainty: true,
    contributingSiteCount: 2,
    contributingCapacityKw: 8.4,
    ...overrides,
  });

export const ISSUED_AT = utcIsoTimestampSchema.parse('2026-07-31T11:07:00Z');
export const EARLIER_RUN = utcIsoTimestampSchema.parse('2026-07-31T10:07:00Z');

/** One stored slice, stamped as the producer stamps it: the digest of the sites it summed. */
export const row = (
  location: string,
  summedSites: readonly FleetSite[],
  slice: FleetRollupPartial = partial(),
  issuedAt: UtcIsoTimestamp = ISSUED_AT,
): FleetRollupRow => ({
  locationId: location,
  provenance: { members: fleetRollupMembers(summedSites), issuedAt },
  partial: slice,
});

/** `readFleetForecastAggregate` with recording stubs, for `fleet-rollup-read.test.ts`. */
const FROM = utcIsoTimestampSchema.parse('2026-07-31T12:00:00Z');
const TO = utcIsoTimestampSchema.parse('2026-08-02T12:00:00Z');
const DEADLINE_EVENT = 'api.fleet-forecast.read-deadline-reached';

export interface Harness {
  readonly deps: FleetRollupReadDeps;
  readonly rollupReads: number;
  readonly siteReads: string[];
  readonly logged: Record<string, unknown>[];
}

export interface HarnessInput {
  readonly rows?: readonly FleetRollupRow[];
  readonly rollupComplete?: boolean;
  readonly pointsBySite?: Readonly<Record<string, readonly SeriesPoint[]>>;
}

export const harness = (input: HarnessInput = {}): Harness => {
  const siteReads: string[] = [];
  const logged: Record<string, unknown>[] = [];
  const state = { rollupReads: 0 };

  return {
    siteReads,
    logged,
    get rollupReads(): number {
      return state.rollupReads;
    },
    deps: {
      series: {
        queryFleetRollup: () => {
          state.rollupReads += 1;
          return Promise.resolve({
            rows: [...(input.rows ?? [])],
            complete: input.rollupComplete ?? true,
          });
        },
        querySeriesRange: (siteId) => {
          siteReads.push(siteId);
          return Promise.resolve({
            points: [...(input.pointsBySite?.[siteId] ?? [])],
            complete: true,
          });
        },
      },
      log: (entry) => logged.push(entry),
    },
  };
};

export const read = async (
  deps: FleetRollupReadDeps,
  sites: readonly FleetSite[],
): Promise<FleetForecastAggregateRead> =>
  readFleetForecastAggregate(deps, fullBudgetDeadline, sites, FROM, TO, DEADLINE_EVENT);

export const pointsOf = (result: FleetForecastAggregateRead) => {
  if (!result.complete) {
    throw new Error('expected a complete read');
  }
  return result.points;
};
