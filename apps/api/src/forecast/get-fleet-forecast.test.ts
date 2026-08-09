import {
  apiErrorSchema,
  fleetForecastResponseSchema,
  openMeteoAttribution,
  utcIsoTimestampSchema,
  type FleetSite,
} from '@cumulo/shared';
import type { SeriesPoint } from '@cumulo/storage';
import { describe, expect, it } from 'vitest';

import {
  countdownDeadline,
  fleetSite,
  forecast,
  forecastPoint,
  fullBudgetDeadline,
  generationPoint,
  jsonBodyOf,
  RANELAGH_ID,
  RATHMINES_ID,
  routeRequest,
} from '../api-fixtures';
import type { RequestDeadline } from '../http/request-deadline';

import {
  fleetForecastReadDeadlineEvent,
  getFleetForecast,
  type GetFleetForecastDeps,
} from './get-fleet-forecast';

/**
 * The forward mirror of `get-fleet-actuals.test.ts`, and it asks the same
 * questions of the same fan-out: which sites did this request reach, over what
 * window, and what does it answer when it cannot reach them all. The stub
 * therefore records the reads in order rather than only what came back.
 *
 * The deadline cases here are not a copy of that file's for the sake of
 * symmetry: the refusal they exercise lives in `fleet-series-read.ts` now, and a
 * route that stopped calling it — or called it without its own event name —
 * would keep the other file green while serving a fleet that is short a site.
 */
interface Stub {
  readonly deps: GetFleetForecastDeps;
  /** `siteId from to` per Query, in order: the fan-out as the series table saw it. */
  readonly reads: string[];
  readonly logged: Record<string, unknown>[];
}

/** The clock every test below shares, so the windows asserted on are readable here. */
const NOW = '2026-07-31T12:00:00Z';
const DAY_AFTER_NOW = '2026-08-01T12:00:00Z';
const TWO_DAYS_AFTER_NOW = '2026-08-02T12:00:00Z';
const WEEK_AFTER_NOW = '2026-08-07T12:00:00Z';

const RANELAGH = fleetSite();
const RATHMINES = fleetSite({ id: RATHMINES_ID, name: 'Rathmines terrace' });

/**
 * `complete` is the adapter's own field rather than a mode flag: it is how a
 * bounded read reports that it stopped with the window unread, and what this
 * route does with `false` is one of the behaviours under test.
 */
const stub = (
  sites: readonly FleetSite[],
  pointsBySite: Readonly<Record<string, readonly SeriesPoint[]>> = {},
  complete = true,
): Stub => {
  const reads: string[] = [];
  const logged: Record<string, unknown>[] = [];

  return {
    reads,
    logged,
    deps: {
      sites: { listFleetSites: () => Promise.resolve([...sites]) },
      series: {
        querySeriesRange: (siteId, from, to) => {
          reads.push(`${siteId} ${from} ${to}`);
          return Promise.resolve({ points: [...(pointsBySite[siteId] ?? [])], complete });
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

describe('GET /v1/fleet/forecast', () => {
  it('merges every site’s forecasts into one array and leaves the readings behind', async () => {
    // The same partition holds both kinds interleaved (ADR 0002), and only one
    // of them is this route's answer. The power values are distinct so that a
    // reading leaking through would be visible: `forecastSchema` and
    // `generationReadingSchema` overlap enough that a leak would still parse.
    const ranelagh = forecast({ acPowerKw: 2.8 });
    const rathmines = forecast({ siteId: RATHMINES_ID, acPowerKw: 1.6 });
    const { deps } = stub([RANELAGH, RATHMINES], {
      [RANELAGH_ID]: [
        generationPoint({ acPowerKw: 0.9 }),
        { type: 'forecast', forecast: ranelagh },
      ],
      [RATHMINES_ID]: [{ type: 'forecast', forecast: rathmines }],
    });

    const response = await getFleetForecast(deps, fleetForecastRequest());

    expect(response.statusCode).toBe(200);
    const body = fleetForecastResponseSchema.parse(jsonBodyOf(response));
    expect(body.forecasts).toEqual([ranelagh, rathmines]);
    expect(body.forecasts.map((point) => point.acPowerKw)).toEqual([2.8, 1.6]);
  });

  it('reads every site in the fleet exactly once', async () => {
    const { deps, reads } = stub([RANELAGH, RATHMINES]);

    await getFleetForecast(deps, fleetForecastRequest());

    expect(reads).toEqual([
      `${RANELAGH_ID} ${NOW} ${TWO_DAYS_AFTER_NOW}`,
      `${RATHMINES_ID} ${NOW} ${TWO_DAYS_AFTER_NOW}`,
    ]);
  });

  it.each([
    { name: 'no hours parameter at all', query: {}, to: TWO_DAYS_AFTER_NOW },
    { name: 'an explicit hours=24', query: { hours: '24' }, to: DAY_AFTER_NOW },
    { name: 'hours=48', query: { hours: '48' }, to: TWO_DAYS_AFTER_NOW },
    { name: 'hours=168', query: { hours: '168' }, to: WEEK_AFTER_NOW },
  ])('reads forward from the clock to $to given $name', async ({ query, to }) => {
    // The window opens at `now()` and runs `hours` ahead — the mirror of the
    // fleet-actuals route, which closes at the clock and reads backwards. The
    // first case takes no `hours` at all, so the 48-hour default is proven by
    // the path a caller that sends nothing actually takes.
    const { deps, reads } = stub([RANELAGH]);

    const response = await getFleetForecast(deps, fleetForecastRequest(query));

    expect(response.statusCode).toBe(200);
    expect(reads).toEqual([`${RANELAGH_ID} ${NOW} ${to}`]);
  });

  it('rejects hours outside 24/48/168 with validation_failed', async () => {
    // A closed set rather than a bounded integer, because each admitted value is
    // a fan-out whose cost is known in advance: `hours=8760` would be a year of
    // partition per site, and it is refused before a single site is listed.
    const { deps, reads } = stub([RANELAGH, RATHMINES]);

    const response = await getFleetForecast(deps, fleetForecastRequest({ hours: '8760' }));

    expect(response.statusCode).toBe(400);
    const body = apiErrorSchema.parse(jsonBodyOf(response));
    expect(body.code).toBe('validation_failed');
    expect(body.details?.[0]?.path).toBe('hours');
    expect(reads).toEqual([]);
  });

  it('answers 200 with an empty array for a fleet with no sites', async () => {
    // An empty fleet is an answer about the fleet's size, not a missing
    // resource — and it must still carry the attribution, because a client that
    // renders "no forecast yet" beside a chart is still rendering the chart.
    const { deps, reads } = stub([]);

    const response = await getFleetForecast(deps, fleetForecastRequest());

    expect(response.statusCode).toBe(200);
    const body = fleetForecastResponseSchema.parse(jsonBodyOf(response));
    expect(body.forecasts).toEqual([]);
    expect(body.attribution).toEqual(openMeteoAttribution);
    expect(reads).toEqual([]);
  });

  it('answers 200 with an empty array for a fleet whose sites hold no forecasts', async () => {
    const { deps, reads } = stub([RANELAGH, RATHMINES]);

    const response = await getFleetForecast(deps, fleetForecastRequest());

    expect(response.statusCode).toBe(200);
    expect(fleetForecastResponseSchema.parse(jsonBodyOf(response)).forecasts).toEqual([]);
    expect(reads).toHaveLength(2);
  });

  it('credits Open-Meteo in every 200 body', async () => {
    const { deps } = stub([RANELAGH], { [RANELAGH_ID]: [forecastPoint()] });

    const response = await getFleetForecast(deps, fleetForecastRequest());

    const body = fleetForecastResponseSchema.parse(jsonBodyOf(response));
    expect(body.attribution).toEqual(openMeteoAttribution);
    expect(body.attribution.text).toBe('Weather data by Open-Meteo.com');
  });

  it('answers 500 rather than a fleet that quietly stops part-way through', async () => {
    // Three sites and room for one more read after the first: the fan-out stops
    // between sites, where the handler can still answer, and refuses to serve a
    // fleet forecast that is short a site — summed hour by hour, a missing site
    // does not read as missing, it reads as a fleet that will generate less.
    const { deps, reads, logged } = stub([
      RANELAGH,
      RATHMINES,
      fleetSite({ id: '9d1f0c2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f', name: 'Portobello mews' }),
    ]);

    const response = await getFleetForecast(deps, fleetForecastRequest({}, countdownDeadline(1)));

    expect(response.statusCode).toBe(500);
    expect(apiErrorSchema.parse(jsonBodyOf(response)).code).toBe('internal');
    expect(reads).toHaveLength(2);
    expect(logged).toEqual([{ event: fleetForecastReadDeadlineEvent, sitesRead: 2, fleetSize: 3 }]);
  });

  it('answers 500 when any one site’s window stopped short, without reading on', async () => {
    const { deps, reads, logged } = stub(
      [RANELAGH, RATHMINES],
      { [RANELAGH_ID]: [forecastPoint()] },
      false,
    );

    const response = await getFleetForecast(deps, fleetForecastRequest());

    expect(response.statusCode).toBe(500);
    expect(apiErrorSchema.parse(jsonBodyOf(response)).code).toBe('internal');
    // Stopped at the first site: the answer cannot become whole by reading more.
    expect(reads).toHaveLength(1);
    expect(logged).toEqual([{ event: fleetForecastReadDeadlineEvent, siteId: RANELAGH_ID }]);
  });

  it('refuses to serve a stored forecast that violates the response contract', async () => {
    // The negative control for `jsonResponse`'s parse. `acPowerKw: -1`
    // type-checks and fails `forecastSchema`'s lower bound, so the handler
    // throws and the boundary answers 500 rather than shipping a 200 the
    // OpenAPI document does not describe.
    const { deps } = stub([RANELAGH], {
      [RANELAGH_ID]: [{ type: 'forecast', forecast: { ...forecast(), acPowerKw: -1 } }],
    });

    await expect(getFleetForecast(deps, fleetForecastRequest())).rejects.toThrow();
  });
});
