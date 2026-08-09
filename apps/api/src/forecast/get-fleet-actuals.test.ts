import {
  apiErrorSchema,
  fleetActualsResponseSchema,
  openMeteoAttribution,
  utcIsoTimestampSchema,
  type FleetSite,
} from '@cumulo/shared';
import type { QueryPaginationBound, SeriesPoint } from '@cumulo/storage';
import { describe, expect, it } from 'vitest';

import {
  countdownDeadline,
  fleetSite,
  forecastPoint,
  fullBudgetDeadline,
  generationPoint,
  generationReading,
  jsonBodyOf,
  RANELAGH_ID,
  RATHMINES_ID,
  routeRequest,
} from '../api-fixtures';
import type { RequestDeadline } from '../http/request-deadline';

import {
  fleetActualsReadDeadlineEvent,
  getFleetActuals,
  type GetFleetActualsDeps,
} from './get-fleet-actuals';

/**
 * The route's whole job is a fan-out: one clock reading, one window, one Query
 * per site, and a single answer that is either the whole fleet or an error. So
 * the stub records what was read and in what order, rather than only what came
 * back — "which sites did this request actually reach" is the question every
 * deadline test below asks.
 */
interface Stub {
  readonly deps: GetFleetActualsDeps;
  /** `siteId from to` per Query, in order: the fan-out as the series table saw it. */
  readonly reads: string[];
  readonly logged: Record<string, unknown>[];
  /** The pagination bound each read was given, so a test can ask it what the adapter would. */
  readonly bounds: (QueryPaginationBound | undefined)[];
}

/** The clock every test below shares, so the windows asserted on are readable here. */
const NOW = '2026-07-31T12:00:00Z';
const DAY_BEFORE_NOW = '2026-07-30T12:00:00Z';
const WEEK_BEFORE_NOW = '2026-07-24T12:00:00Z';

const RANELAGH = fleetSite();
const RATHMINES = fleetSite({ id: RATHMINES_ID, name: 'Rathmines terrace' });

/**
 * `complete` is the adapter's own field rather than a mode flag: it is how a
 * bounded read reports that it stopped with the window unread, and what this
 * handler does with `false` is one of the behaviours under test.
 */
const stub = (
  sites: readonly FleetSite[],
  pointsBySite: Readonly<Record<string, readonly SeriesPoint[]>> = {},
  complete = true,
): Stub => {
  const reads: string[] = [];
  const logged: Record<string, unknown>[] = [];
  const bounds: (QueryPaginationBound | undefined)[] = [];

  return {
    reads,
    logged,
    bounds,
    deps: {
      sites: { listFleetSites: () => Promise.resolve([...sites]) },
      series: {
        querySeriesRange: (siteId, from, to, bound) => {
          reads.push(`${siteId} ${from} ${to}`);
          bounds.push(bound);
          return Promise.resolve({ points: [...(pointsBySite[siteId] ?? [])], complete });
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
  it('merges every site’s readings into one array and leaves the forecasts behind', async () => {
    // The same partition holds both kinds interleaved (ADR 0002), and only one
    // of them is this route's answer. The power values are distinct so that a
    // forecast leaking through would be visible: `forecastSchema` and
    // `generationReadingSchema` overlap enough that a leak would still parse.
    const ranelagh = generationReading({ acPowerKw: 2.4 });
    const rathmines = generationReading({ siteId: RATHMINES_ID, acPowerKw: 1.1 });
    const { deps } = stub([RANELAGH, RATHMINES], {
      [RANELAGH_ID]: [forecastPoint({ acPowerKw: 2.8 }), { type: 'generation', reading: ranelagh }],
      [RATHMINES_ID]: [{ type: 'generation', reading: rathmines }],
    });

    const response = await getFleetActuals(deps, fleetActualsRequest());

    expect(response.statusCode).toBe(200);
    const body = fleetActualsResponseSchema.parse(jsonBodyOf(response));
    expect(body.actuals).toEqual([ranelagh, rathmines]);
    expect(body.actuals.map((reading) => reading.acPowerKw)).toEqual([2.4, 1.1]);
  });

  it('reads every site in the fleet exactly once', async () => {
    const { deps, reads } = stub([RANELAGH, RATHMINES]);

    await getFleetActuals(deps, fleetActualsRequest());

    expect(reads).toEqual([
      `${RANELAGH_ID} ${DAY_BEFORE_NOW} ${NOW}`,
      `${RATHMINES_ID} ${DAY_BEFORE_NOW} ${NOW}`,
    ]);
  });

  it.each([
    { name: 'no hours parameter at all', query: {}, from: DAY_BEFORE_NOW },
    { name: 'an explicit hours=24', query: { hours: '24' }, from: DAY_BEFORE_NOW },
    { name: 'hours=168', query: { hours: '168' }, from: WEEK_BEFORE_NOW },
  ])('looks back from the clock to $from given $name', async ({ query, from }) => {
    // The window closes at `now()` and opens `hours` before it — the mirror of
    // the forecast route, which opens at the clock and reads forward.
    const { deps, reads } = stub([RANELAGH]);

    const response = await getFleetActuals(deps, fleetActualsRequest(query));

    expect(response.statusCode).toBe(200);
    expect(reads).toEqual([`${RANELAGH_ID} ${from} ${NOW}`]);
  });

  it('rejects hours outside 24/48/168 with validation_failed', async () => {
    // A closed set rather than a bounded integer, because each admitted value is
    // a fan-out whose cost is known in advance: `hours=8760` would be a year of
    // partition per site, and it is refused before a single site is listed.
    const { deps, reads } = stub([RANELAGH, RATHMINES]);

    const response = await getFleetActuals(deps, fleetActualsRequest({ hours: '8760' }));

    expect(response.statusCode).toBe(400);
    const body = apiErrorSchema.parse(jsonBodyOf(response));
    expect(body.code).toBe('validation_failed');
    expect(body.details?.[0]?.path).toBe('hours');
    expect(reads).toEqual([]);
  });

  it('answers 200 with an empty array for a fleet with no sites', async () => {
    // An empty fleet is an answer about the fleet's size, not a missing
    // resource — and it must still carry the attribution, because a client that
    // renders "no data yet" beside a chart is still rendering the chart.
    const { deps, reads } = stub([]);

    const response = await getFleetActuals(deps, fleetActualsRequest());

    expect(response.statusCode).toBe(200);
    const body = fleetActualsResponseSchema.parse(jsonBodyOf(response));
    expect(body.actuals).toEqual([]);
    expect(body.attribution).toEqual(openMeteoAttribution);
    expect(reads).toEqual([]);
  });

  it('answers 200 with an empty array for a fleet whose sites hold no readings', async () => {
    const { deps, reads } = stub([RANELAGH, RATHMINES]);

    const response = await getFleetActuals(deps, fleetActualsRequest());

    expect(response.statusCode).toBe(200);
    expect(fleetActualsResponseSchema.parse(jsonBodyOf(response)).actuals).toEqual([]);
    expect(reads).toHaveLength(2);
  });

  it('credits Open-Meteo in every 200 body', async () => {
    const { deps } = stub([RANELAGH], { [RANELAGH_ID]: [generationPoint()] });

    const response = await getFleetActuals(deps, fleetActualsRequest());

    const body = fleetActualsResponseSchema.parse(jsonBodyOf(response));
    expect(body.attribution).toEqual(openMeteoAttribution);
    expect(body.attribution.text).toBe('Weather data by Open-Meteo.com');
  });

  it('answers 500 rather than a fleet that quietly stops part-way through', async () => {
    // Three sites and room for one more read after the first: the fan-out stops
    // between sites, where the handler can still answer, and refuses to serve a
    // fleet total that is short a site — summed hour by hour, a missing site
    // does not read as missing, it reads as a fleet that generated less.
    const { deps, reads, logged } = stub([
      RANELAGH,
      RATHMINES,
      fleetSite({ id: '9d1f0c2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f', name: 'Portobello mews' }),
    ]);

    const response = await getFleetActuals(deps, fleetActualsRequest({}, countdownDeadline(1)));

    expect(response.statusCode).toBe(500);
    expect(apiErrorSchema.parse(jsonBodyOf(response)).code).toBe('internal');
    expect(reads).toHaveLength(2);
    expect(logged).toEqual([{ event: fleetActualsReadDeadlineEvent, sitesRead: 2, fleetSize: 3 }]);
  });

  it('answers 500 when any one site’s window stopped short, without reading on', async () => {
    const { deps, reads, logged } = stub(
      [RANELAGH, RATHMINES],
      { [RANELAGH_ID]: [generationPoint()] },
      false,
    );

    const response = await getFleetActuals(deps, fleetActualsRequest());

    expect(response.statusCode).toBe(500);
    expect(apiErrorSchema.parse(jsonBodyOf(response)).code).toBe('internal');
    // Stopped at the first site: the answer cannot become whole by reading more.
    expect(reads).toHaveLength(1);
    expect(logged).toEqual([{ event: fleetActualsReadDeadlineEvent, siteId: RANELAGH_ID }]);
  });

  it('serves the 200 and logs nothing when the whole fleet was read to its end', async () => {
    const { deps, logged } = stub([RANELAGH, RATHMINES], {
      [RANELAGH_ID]: [generationPoint()],
      [RATHMINES_ID]: [generationPoint({ siteId: RATHMINES_ID })],
    });

    const response = await getFleetActuals(deps, fleetActualsRequest());

    expect(response.statusCode).toBe(200);
    expect(fleetActualsResponseSchema.parse(jsonBodyOf(response)).actuals).toHaveLength(2);
    expect(logged).toEqual([]);
  });

  it.each([
    { name: 'a request with its whole budget left', deadline: fullBudgetDeadline, permitted: true },
    { name: 'a request whose time is gone', deadline: countdownDeadline(0), permitted: false },
  ])(
    'hands each site’s read a pagination bound that answers for $name',
    async ({ deadline, permitted }) => {
      // The bound is asked *between* pages of one site's Query, so what matters
      // is that its answer comes from this request's deadline and not a constant.
      const { deps, bounds } = stub([RANELAGH]);

      await getFleetActuals(deps, fleetActualsRequest({}, deadline));

      expect(bounds).toHaveLength(1);
      expect(bounds[0]?.hasBudgetForNextPage()).toBe(permitted);
    },
  );

  it('refuses to serve a stored reading that violates the response contract', async () => {
    // The negative control for `jsonResponse`'s parse. `acPowerKw: -1`
    // type-checks and fails `generationReadingSchema`'s lower bound, so the
    // handler throws and the boundary answers 500 rather than shipping a 200 the
    // OpenAPI document does not describe.
    const { deps } = stub([RANELAGH], {
      [RANELAGH_ID]: [{ type: 'generation', reading: { ...generationReading(), acPowerKw: -1 } }],
    });

    await expect(getFleetActuals(deps, fleetActualsRequest())).rejects.toThrow();
  });
});
