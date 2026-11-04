import {
  apiErrorSchema,
  fleetActualsResponseSchema,
  openMeteoAttribution,
  utcIsoTimestampSchema,
  type FleetSite,
} from '@cumulo/shared';
import type { FleetRollupRow } from '@cumulo/storage';
import { describe, expect, it } from 'vitest';

import {
  fleetSite,
  fullBudgetDeadline,
  jsonBodyOf,
  RATHMINES_ID,
  routeRequest,
  VALID_TIME,
} from '../api-fixtures';
import type { RequestDeadline } from '../http/request-deadline';

import { cycleOfReading } from './cycle-cache';
import { BRISTOL, BRISTOL_SITE, DUBLIN, partial, row } from './fleet-rollup-fixtures';
import {
  fleetActualsReadDeadlineEvent,
  getFleetActuals,
  type GetFleetActualsDeps,
} from './get-fleet-actuals';

/**
 * The roll-up read's own cases live in `fleet-actuals-rollup-read.test.ts`; here the stub's
 * `#FLEET` partition is empty unless a test fills it. The stub records the totals Query's window,
 * which is the question the look-back cases ask.
 */
interface Stub {
  readonly deps: GetFleetActualsDeps;
  /** `from to` per totals Query, in order. */
  readonly totalsReads: string[];
  readonly logged: Record<string, unknown>[];
}

/** The clock every test below shares, so the windows asserted on are readable here. */
const NOW = '2026-07-31T12:00:00Z';
const DAY_BEFORE_NOW = '2026-07-30T12:00:00Z';
const WEEK_BEFORE_NOW = '2026-07-24T12:00:00Z';

const RANELAGH = fleetSite();
const RATHMINES = fleetSite({ id: RATHMINES_ID, name: 'Rathmines terrace' });

/** A GEN slice at `validTime`: no band, as the producer writes it. */
const generationSlice = (validTime: string) => partial({ validTime, hasUncertainty: false });

/**
 * `complete` is the adapter's own field rather than a mode flag: it is how a bounded read reports
 * that it stopped with the window unread, and what this handler does with `false` is one of the
 * behaviours under test.
 */
const stub = (
  sites: readonly FleetSite[],
  rollupRows: readonly FleetRollupRow[] = [],
  complete = true,
): Stub => {
  const totalsReads: string[] = [];
  const logged: Record<string, unknown>[] = [];

  return {
    totalsReads,
    logged,
    deps: {
      sites: { listFleetSites: () => Promise.resolve([...sites]) },
      series: {
        queryFleetRollup: () => Promise.resolve({ rows: [...rollupRows], complete: true }),
        queryFleetActualsTotals: (from, to) => {
          totalsReads.push(`${from} ${to}`);
          return Promise.resolve({ rows: [], complete });
        },
      },
      now: () => utcIsoTimestampSchema.parse(NOW),
      log: (entry) => logged.push(entry),
    },
  };
};

const fleetActualsRequest = (
  query: Record<string, string> = {},
  deadline: RequestDeadline = fullBudgetDeadline,
) => routeRequest({ path: '/v1/fleet/actuals', query, deadline });

describe('GET /v1/fleet/actuals', () => {
  it('serves the fleet’s GEN slices summed when every location has written', async () => {
    const slice = generationSlice('2026-07-31T11:00:00Z');
    const { deps, logged } = stub(
      [RANELAGH, RATHMINES],
      [row(DUBLIN, [RANELAGH, RATHMINES], slice)],
    );

    const response = await getFleetActuals(deps, fleetActualsRequest());

    expect(response.statusCode).toBe(200);
    expect(fleetActualsResponseSchema.parse(jsonBodyOf(response)).points).toEqual([
      {
        validTime: slice.validTime,
        acPowerKw: slice.acPowerKw,
        contributingSiteCount: slice.contributingSiteCount,
        contributingCapacityKw: slice.contributingCapacityKw,
      },
    ]);
    expect(logged).toEqual([]);
  });

  it.each([
    { name: 'no hours parameter at all', query: {}, from: DAY_BEFORE_NOW },
    { name: 'an explicit hours=24', query: { hours: '24' }, from: DAY_BEFORE_NOW },
    { name: 'hours=168', query: { hours: '168' }, from: WEEK_BEFORE_NOW },
  ])('looks back from the clock to $from given $name', async ({ query, from }) => {
    // The window closes at `now()` and opens `hours` before it — the mirror of
    // the forecast route, which opens at the clock and reads forward.
    const { deps, totalsReads } = stub([RANELAGH]);

    const response = await getFleetActuals(deps, fleetActualsRequest(query));

    expect(response.statusCode).toBe(200);
    expect(totalsReads).toEqual([`${from} ${NOW}`]);
  });

  it('rejects hours outside 24/48/168 with validation_failed', async () => {
    // A closed set rather than a bounded integer, because each admitted value is a window whose
    // cost is known in advance: `hours=8760` would be a year of partition, and it is refused before
    // a single site is listed.
    const { deps, totalsReads } = stub([RANELAGH, RATHMINES]);

    const response = await getFleetActuals(deps, fleetActualsRequest({ hours: '8760' }));

    expect(response.statusCode).toBe(400);
    const body = apiErrorSchema.parse(jsonBodyOf(response));
    expect(body.code).toBe('validation_failed');
    expect(body.details?.[0]?.path).toBe('hours');
    expect(totalsReads).toEqual([]);
  });

  it('answers 200 with an empty array for a fleet with no sites', async () => {
    // An empty fleet is an answer about the fleet's size, not a missing
    // resource — and it must still carry the attribution, because a client that
    // renders "no data yet" beside a chart is still rendering the chart.
    const { deps, totalsReads } = stub([]);

    const response = await getFleetActuals(deps, fleetActualsRequest());

    expect(response.statusCode).toBe(200);
    const body = fleetActualsResponseSchema.parse(jsonBodyOf(response));
    expect(body.points).toEqual([]);
    expect(body.attribution).toEqual(openMeteoAttribution);
    expect(totalsReads).toEqual([]);
  });

  it('answers 200 with an empty array, uncacheable, for a fleet that holds no readings yet', async () => {
    const { deps } = stub([RANELAGH, RATHMINES]);

    const response = await getFleetActuals(deps, fleetActualsRequest());

    expect(response.statusCode).toBe(200);
    expect(fleetActualsResponseSchema.parse(jsonBodyOf(response)).points).toEqual([]);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('dates a roll-up answer by its most-behind location', async () => {
    const { deps } = stub(
      [RANELAGH, RATHMINES, BRISTOL_SITE],
      [
        // Bristol's newest sits between Dublin's two, so neither the window's oldest hour nor its
        // newest is the answer — only each location's newest, then the oldest of those.
        row(DUBLIN, [RANELAGH, RATHMINES], generationSlice('2026-07-31T09:00:00Z')),
        row(DUBLIN, [RANELAGH, RATHMINES], generationSlice('2026-07-31T11:00:00Z')),
        row(BRISTOL, [BRISTOL_SITE], generationSlice('2026-07-31T10:00:00Z')),
      ],
    );

    const response = await getFleetActuals(deps, fleetActualsRequest());

    expect(response.dataCycleStart).toBe(cycleOfReading('2026-07-31T10:00:00Z'));
  });

  it('credits Open-Meteo in every 200 body', async () => {
    const { deps } = stub([RANELAGH], [row(DUBLIN, [RANELAGH], generationSlice(VALID_TIME))]);

    const response = await getFleetActuals(deps, fleetActualsRequest());

    const body = fleetActualsResponseSchema.parse(jsonBodyOf(response));
    expect(response.headers['cache-control']).toBeUndefined();
    expect(response.dataCycleStart).toBe(cycleOfReading(VALID_TIME));
    expect(body.attribution).toEqual(openMeteoAttribution);
    expect(body.attribution.text).toBe('Weather data by Open-Meteo.com');
  });

  it('answers 500 with this route’s own deadline event when a Query stopped short', async () => {
    const { deps, logged } = stub([RANELAGH], [], false);

    const response = await getFleetActuals(deps, fleetActualsRequest());

    expect(response.statusCode).toBe(500);
    expect(apiErrorSchema.parse(jsonBodyOf(response)).code).toBe('internal');
    expect(logged.at(-1)).toMatchObject({ event: fleetActualsReadDeadlineEvent });
  });

  it('refuses to serve a stored reading that violates the response contract', async () => {
    // The negative control for `jsonResponse`'s parse. `acPowerKw: -1` type-checks and sums to a
    // point `fleetActualsResponseSchema` refuses, so the handler throws and the boundary answers
    // 500 rather than shipping a 200 the OpenAPI document does not describe.
    const negative = { ...generationSlice(VALID_TIME), acPowerKw: -1 };
    const { deps } = stub([RANELAGH], [row(DUBLIN, [RANELAGH], negative)]);

    await expect(getFleetActuals(deps, fleetActualsRequest())).rejects.toThrow();
  });
});
