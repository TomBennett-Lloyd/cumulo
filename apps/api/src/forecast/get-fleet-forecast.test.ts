import {
  apiErrorSchema,
  fleetForecastResponseSchema,
  openMeteoAttribution,
  utcIsoTimestampSchema,
  type FleetSite,
} from '@cumulo/shared';
import type { FleetRollupRow } from '@cumulo/storage';
import { describe, expect, it } from 'vitest';

import { fullBudgetDeadline, jsonBodyOf, routeRequest } from '../api-fixtures';
import type { RequestDeadline } from '../http/request-deadline';

import { fleetRollupShortEvent } from './fleet-rollup-read';
import {
  BRISTOL,
  BRISTOL_SITE,
  DUBLIN,
  RANELAGH,
  RATHMINES,
  partial,
  row,
} from './fleet-rollup-fixtures';
import {
  fleetForecastReadDeadlineEvent,
  getFleetForecast,
  type GetFleetForecastDeps,
} from './get-fleet-forecast';

/**
 * The route reads the pre-summed `#FLEET` partition (#494, ADR 0009), so the questions this suite
 * asks are: how many storage commands did one request spend, and what does it answer when the
 * partition is short of the fleet or the read ran out of time. The surviving claim is one Query,
 * and nothing behind it.
 */
interface Stub {
  readonly deps: GetFleetForecastDeps;
  /** `kind from to` per roll-up Query, in order. */
  readonly rollupReads: string[];
  readonly logged: Record<string, unknown>[];
}

/** The clock every test below shares, so the windows asserted on are readable here. */
const NOW = '2026-07-31T12:00:00Z';
const DAY_AFTER_NOW = '2026-08-01T12:00:00Z';
const TWO_DAYS_AFTER_NOW = '2026-08-02T12:00:00Z';
const WEEK_AFTER_NOW = '2026-08-07T12:00:00Z';

interface StubInput {
  readonly sites: readonly FleetSite[];
  readonly rollupRows?: readonly FleetRollupRow[];
  /** False ⇒ the roll-up Query stopped short of the window, which is the route's 500. */
  readonly rollupComplete?: boolean;
}

const stub = (input: StubInput): Stub => {
  const rollupReads: string[] = [];
  const logged: Record<string, unknown>[] = [];

  return {
    rollupReads,
    logged,
    deps: {
      sites: { listFleetSites: () => Promise.resolve([...input.sites]) },
      series: {
        queryFleetRollup: (kind, from, to) => {
          rollupReads.push(`${kind.kind} ${from} ${to}`);
          return Promise.resolve({
            rows: [...(input.rollupRows ?? [])],
            complete: input.rollupComplete ?? true,
          });
        },
      },
      now: () => utcIsoTimestampSchema.parse(NOW),
      log: (entry) => logged.push(entry),
    },
  };
};

const fleetForecastRequest = (
  query: Record<string, string> = {},
  deadline: RequestDeadline = fullBudgetDeadline,
) => routeRequest({ path: '/v1/fleet/forecast', query, deadline });

describe('GET /v1/fleet/forecast, reading the roll-up', () => {
  it('answers from one storage command when every location has written', async () => {
    const { deps, rollupReads, logged } = stub({
      sites: [RANELAGH, RATHMINES],
      rollupRows: [row(DUBLIN, [RANELAGH, RATHMINES], partial())],
    });

    const response = await getFleetForecast(deps, fleetForecastRequest());

    expect(response.statusCode).toBe(200);
    // The claim the ticket exists to make: one Query, and no fan-out behind it.
    expect(rollupReads).toEqual([`forecast ${NOW} ${TWO_DAYS_AFTER_NOW}`]);
    expect(logged).toEqual([]);
  });

  it('sums the partials of every location into one point per hour', async () => {
    const { deps } = stub({
      sites: [RANELAGH, BRISTOL_SITE],
      rollupRows: [
        row(DUBLIN, [RANELAGH], partial({ acPowerKw: 5, contributingSiteCount: 2 })),
        row(BRISTOL, [BRISTOL_SITE], partial({ acPowerKw: 3, contributingSiteCount: 1 })),
      ],
    });

    const body = fleetForecastResponseSchema.parse(
      jsonBodyOf(await getFleetForecast(deps, fleetForecastRequest())),
    );

    expect(body.points).toEqual([
      {
        validTime: '2026-07-31T13:00:00Z',
        acPowerKw: 8,
        uncertainty: { p10AcPowerKw: 8, p90AcPowerKw: 12 },
        contributingSiteCount: 3,
        contributingCapacityKw: 16.8,
      },
    ]);
  });

  it('answers 200 for a 60-site daylight hour whose band sums past one house’s cap', async () => {
    // #586: the fleet band carried the per-site cap, so `jsonResponse` refused this body as a 500.
    const sixtySites = partial({
      acPowerKw: 180,
      p10AcPowerKw: 140,
      p90AcPowerKw: 230,
      contributingSiteCount: 60,
      contributingCapacityKw: 340,
    });
    const { deps } = stub({
      sites: [RANELAGH],
      rollupRows: [row(DUBLIN, [RANELAGH], sixtySites)],
    });

    const response = await getFleetForecast(deps, fleetForecastRequest());

    expect(response.statusCode).toBe(200);
  });

  it.each([
    { name: 'no hours parameter at all', query: {}, to: TWO_DAYS_AFTER_NOW },
    { name: 'an explicit hours=24', query: { hours: '24' }, to: DAY_AFTER_NOW },
    { name: 'hours=48', query: { hours: '48' }, to: TWO_DAYS_AFTER_NOW },
    { name: 'hours=168', query: { hours: '168' }, to: WEEK_AFTER_NOW },
  ])('reads forward from the clock to $to given $name', async ({ query, to }) => {
    // The window opens at `now()` and runs `hours` ahead — the mirror of the fleet-actuals route,
    // which closes at the clock and reads backwards. The first case takes no `hours` at all, so the
    // 48-hour default is proven by the path a caller that sends nothing actually takes.
    const { deps, rollupReads } = stub({
      sites: [RANELAGH],
      rollupRows: [row(DUBLIN, [RANELAGH], partial())],
    });

    const response = await getFleetForecast(deps, fleetForecastRequest(query));

    expect(response.statusCode).toBe(200);
    expect(rollupReads).toEqual([`forecast ${NOW} ${to}`]);
  });

  it('rejects hours outside 24/48/168 with validation_failed, before any read', async () => {
    const { deps, rollupReads } = stub({ sites: [RANELAGH, RATHMINES] });

    const response = await getFleetForecast(deps, fleetForecastRequest({ hours: '8760' }));

    expect(response.statusCode).toBe(400);
    const body = apiErrorSchema.parse(jsonBodyOf(response));
    expect(body.code).toBe('validation_failed');
    expect(body.details?.[0]?.path).toBe('hours');
    expect(rollupReads).toEqual([]);
  });

  it('answers 200 with an empty array for a fleet with no sites, reading nothing', async () => {
    // An empty fleet is an answer about the fleet's size, not a missing resource — and it must
    // still carry the attribution, because a client that renders "no forecast yet" beside a chart
    // is still rendering the chart. A fleet of nothing has no partition state to consult, so
    // nothing is read.
    const { deps, rollupReads, logged } = stub({ sites: [] });

    const response = await getFleetForecast(deps, fleetForecastRequest());

    expect(response.statusCode).toBe(200);
    const body = fleetForecastResponseSchema.parse(jsonBodyOf(response));
    expect(body.points).toEqual([]);
    expect(body.attribution).toEqual(openMeteoAttribution);
    expect(rollupReads).toEqual([]);
    expect(logged).toEqual([]);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('credits Open-Meteo in every 200 body', async () => {
    const { deps } = stub({
      sites: [RANELAGH],
      rollupRows: [row(DUBLIN, [RANELAGH], partial())],
    });

    const response = await getFleetForecast(deps, fleetForecastRequest());
    const body = fleetForecastResponseSchema.parse(jsonBodyOf(response));

    expect(response.headers['cache-control']).toBeUndefined();
    expect(body.attribution).toEqual(openMeteoAttribution);
    expect(body.attribution.text).toBe('Weather data by Open-Meteo.com');
  });
});

describe('GET /v1/fleet/forecast, short of a location or of time', () => {
  it('answers 500 with this route\u2019s own deadline event when the roll-up Query stopped short', async () => {
    const { deps, logged } = stub({
      sites: [RANELAGH],
      rollupRows: [row(DUBLIN, [RANELAGH], partial())],
      rollupComplete: false,
    });

    const response = await getFleetForecast(deps, fleetForecastRequest());

    expect(response.statusCode).toBe(500);
    expect(apiErrorSchema.parse(jsonBodyOf(response)).code).toBe('internal');
    expect(logged.at(-1)).toEqual({ event: fleetForecastReadDeadlineEvent, rowsRead: 1 });
  });

  it('serves the locations that have written, labelled by their count, when one has not', async () => {
    const { deps, logged } = stub({
      sites: [RANELAGH, BRISTOL_SITE],
      rollupRows: [row(DUBLIN, [RANELAGH], partial({ contributingSiteCount: 2 }))],
    });

    const response = await getFleetForecast(deps, fleetForecastRequest());

    expect(response.statusCode).toBe(200);
    const body = fleetForecastResponseSchema.parse(jsonBodyOf(response));
    expect(body.points[0]?.contributingSiteCount).toBe(2);
    expect(logged[0]).toMatchObject({ event: fleetRollupShortEvent, reason: 'incomplete' });
  });

  it('answers 200 with no points, uncacheable, when nothing has been rolled up yet', async () => {
    const { deps, logged } = stub({ sites: [RANELAGH, RATHMINES] });

    const response = await getFleetForecast(deps, fleetForecastRequest());

    expect(response.statusCode).toBe(200);
    expect(fleetForecastResponseSchema.parse(jsonBodyOf(response)).points).toEqual([]);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(logged[0]).toMatchObject({ event: fleetRollupShortEvent, reason: 'absent' });
  });

  it('refuses to serve an aggregate that violates the response contract', async () => {
    // The negative control for `jsonResponse`'s parse. A stored partial can be built past the
    // schema in a test, and `acPowerKw: -1` fails the response schema's lower bound \u2014 so the
    // handler throws and the boundary answers 500 rather than shipping a 200 the OpenAPI document
    // does not describe.
    const { deps } = stub({
      sites: [RANELAGH],
      rollupRows: [row(DUBLIN, [RANELAGH], { ...partial(), acPowerKw: -1, p10AcPowerKw: -1 })],
    });

    await expect(getFleetForecast(deps, fleetForecastRequest())).rejects.toThrow();
  });
});
