import {
  apiErrorSchema,
  fleetForecastResponseSchema,
  openMeteoAttribution,
  utcIsoTimestampSchema,
  type FleetSite,
} from '@cumulo/shared';
import type { FleetRollupRow, SeriesPoint } from '@cumulo/storage';
import { describe, expect, it } from 'vitest';

import {
  countdownDeadline,
  fleetOfSize,
  forecast,
  forecastPoint,
  fullBudgetDeadline,
  jsonBodyOf,
  RANELAGH_ID,
  RATHMINES_ID,
  routeRequest,
} from '../api-fixtures';
import type { RequestDeadline } from '../http/request-deadline';

import { fleetRollupFallbackEvent } from './fleet-rollup-read';
import {
  BRISTOL,
  BRISTOL_SITE,
  DUBLIN,
  RANELAGH,
  RATHMINES,
  partial,
  row,
} from './fleet-rollup-fixtures';
import { FLEET_READ_CONCURRENCY } from './fleet-series-read';
import {
  fleetForecastReadDeadlineEvent,
  getFleetForecast,
  type GetFleetForecastDeps,
} from './get-fleet-forecast';

/**
 * The route reads the pre-summed `#FLEET` partition now (#494, ADR 0009), so the questions this
 * suite asks have moved: how many storage commands did one request spend, which arm answered, and
 * does the fallback arm still refuse a fan-out it could not finish.
 *
 * The stub records both reads separately — `rollupReads` and `reads` — because "exactly one storage
 * command on the happy path" is the claim the whole ticket exists to make, and it is only checkable
 * if a fan-out that quietly also ran would be visible.
 */
interface Stub {
  readonly deps: GetFleetForecastDeps;
  /** `kind from to` per roll-up Query, in order. */
  readonly rollupReads: string[];
  /** `siteId from to` per per-site Query, in order: the fallback fan-out as the table saw it. */
  readonly reads: string[];
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
  /** False ⇒ the roll-up Query stopped short of the window, which is a fallback reason. */
  readonly rollupComplete?: boolean;
  readonly pointsBySite?: Readonly<Record<string, readonly SeriesPoint[]>>;
  /** False ⇒ a per-site window stopped short, which is the fan-out's 500. */
  readonly fanOutComplete?: boolean;
}

const stub = (input: StubInput): Stub => {
  const rollupReads: string[] = [];
  const reads: string[] = [];
  const logged: Record<string, unknown>[] = [];

  return {
    rollupReads,
    reads,
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
        querySeriesRange: (siteId, from, to) => {
          reads.push(`${siteId} ${from} ${to}`);
          return Promise.resolve({
            points: [...(input.pointsBySite?.[siteId] ?? [])],
            complete: input.fanOutComplete ?? true,
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
    const { deps, rollupReads, reads, logged } = stub({
      sites: [RANELAGH, RATHMINES],
      rollupRows: [row(DUBLIN, [RANELAGH, RATHMINES], partial())],
    });

    const response = await getFleetForecast(deps, fleetForecastRequest());

    expect(response.statusCode).toBe(200);
    // The claim the ticket exists to make: one Query, and no fan-out behind it.
    expect(rollupReads).toEqual([`forecast ${NOW} ${TWO_DAYS_AFTER_NOW}`]);
    expect(reads).toEqual([]);
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
    const { deps, rollupReads, reads } = stub({ sites: [RANELAGH, RATHMINES] });

    const response = await getFleetForecast(deps, fleetForecastRequest({ hours: '8760' }));

    expect(response.statusCode).toBe(400);
    const body = apiErrorSchema.parse(jsonBodyOf(response));
    expect(body.code).toBe('validation_failed');
    expect(body.details?.[0]?.path).toBe('hours');
    expect(rollupReads).toEqual([]);
    expect(reads).toEqual([]);
  });

  it('answers 200 with an empty array for a fleet with no sites, reading nothing', async () => {
    // An empty fleet is an answer about the fleet's size, not a missing resource — and it must
    // still carry the attribution, because a client that renders "no forecast yet" beside a chart
    // is still rendering the chart. A fleet of nothing has no partition state to consult, so this
    // arm does not fall back and does not read.
    const { deps, rollupReads, reads, logged } = stub({ sites: [] });

    const response = await getFleetForecast(deps, fleetForecastRequest());

    expect(response.statusCode).toBe(200);
    const body = fleetForecastResponseSchema.parse(jsonBodyOf(response));
    expect(body.points).toEqual([]);
    expect(body.attribution).toEqual(openMeteoAttribution);
    expect(rollupReads).toEqual([]);
    expect(reads).toEqual([]);
    expect(logged).toEqual([]);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('credits Open-Meteo in the roll-up arm', async () => {
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

/**
 * The activity predicate, asserted on both arms because the whole point of #531 is that one
 * narrowing serves both: `activeFleetSites` is applied inside `readFleetForecastAggregate`, so there
 * is no arrangement of the route in which the expected-partial set, the fan-out's site list and the
 * nameplate divisor disagree about which sites the fleet has.
 *
 * Unreachable in production today — no path sets `active: false` — which is why these are the cases
 * that keep it decided rather than rediscovered.
 */
describe('GET /v1/fleet/forecast, over a fleet holding an inactive site', () => {
  const DEACTIVATED_BRISTOL = { ...BRISTOL_SITE, active: false };

  it('expects no partial from the inactive site\u2019s location, so the roll-up still answers', async () => {
    const { deps, rollupReads, reads, logged } = stub({
      sites: [RANELAGH, DEACTIVATED_BRISTOL],
      rollupRows: [row(DUBLIN, [RANELAGH], partial())],
    });

    const response = await getFleetForecast(deps, fleetForecastRequest());

    expect(response.statusCode).toBe(200);
    // Counting Bristol as expected would pin the route on `incomplete` for ever: ingestion has
    // stopped publishing for a location with no active site, so nothing can ever write that partial.
    expect(rollupReads).toHaveLength(1);
    expect(reads).toEqual([]);
    expect(logged).toEqual([]);
  });

  it('neither reads nor divides by the inactive site on the fan-out arm', async () => {
    const { deps, reads } = stub({
      sites: [RANELAGH, DEACTIVATED_BRISTOL],
      pointsBySite: {
        [RANELAGH_ID]: [forecastPoint({ acPowerKw: 2.8 })],
        [BRISTOL_SITE.id]: [forecastPoint({ siteId: BRISTOL_SITE.id, acPowerKw: 9.9 })],
      },
    });

    const body = fleetForecastResponseSchema.parse(
      jsonBodyOf(await getFleetForecast(deps, fleetForecastRequest())),
    );

    // The site list this arm iterates is the narrowed one, so Bristol's partition is never read and
    // its nameplate never reaches the divisor the `%`-of-capacity view reads. A divisor counting a
    // site the pipeline has stopped forecasting for reports a fleet under-performing against
    // capacity that cannot generate.
    expect(reads).toEqual([`${RANELAGH_ID} ${NOW} ${TWO_DAYS_AFTER_NOW}`]);
    expect(body.points.map((point) => point.acPowerKw)).toEqual([2.8]);
    expect(body.points.map((point) => point.contributingSiteCount)).toEqual([1]);
    expect(body.points.map((point) => point.contributingCapacityKw)).toEqual([RANELAGH.capacityKw]);
  });

  it('answers a wholly deactivated fleet the way it answers an empty one, reading nothing', async () => {
    const { deps, rollupReads, reads, logged } = stub({
      sites: [{ ...RANELAGH, active: false }],
      rollupRows: [row(DUBLIN, [RANELAGH], partial())],
    });

    const response = await getFleetForecast(deps, fleetForecastRequest());

    expect(response.statusCode).toBe(200);
    expect(fleetForecastResponseSchema.parse(jsonBodyOf(response)).points).toEqual([]);
    // Not a filtered-to-nothing sum of the partition: the fleet a read answers for is empty, so
    // there is no partition state that could change the answer and no billed read worth spending.
    expect(rollupReads).toEqual([]);
    expect(reads).toEqual([]);
    expect(logged).toEqual([]);
  });
});

describe('GET /v1/fleet/forecast, falling back to the fan-out', () => {
  it('answers 500 rather than a fleet that quietly stops part-way through', async () => {
    // One site more than a batch holds, and a request with no time left: the fan-out stops between
    // batches, where the handler can still answer, and refuses to serve a fleet forecast that is
    // short a site. The event name is this route's own, which is the half `fleet-series-read.test.ts`
    // cannot prove from inside the shared module.
    const fleet = fleetOfSize(FLEET_READ_CONCURRENCY + 1);
    const { deps, reads, logged } = stub({ sites: fleet });

    const response = await getFleetForecast(deps, fleetForecastRequest({}, countdownDeadline(0)));

    expect(response.statusCode).toBe(500);
    expect(apiErrorSchema.parse(jsonBodyOf(response)).code).toBe('internal');
    expect(reads).toHaveLength(FLEET_READ_CONCURRENCY);
    expect(logged.at(-1)).toEqual({
      event: fleetForecastReadDeadlineEvent,
      sitesRead: FLEET_READ_CONCURRENCY,
      fleetSize: fleet.length,
    });
  });

  it('answers 500 when any one site\u2019s window stopped short, without reading on', async () => {
    const { deps, reads, logged } = stub({
      sites: [RANELAGH, RATHMINES],
      pointsBySite: { [RANELAGH_ID]: [forecastPoint()] },
      fanOutComplete: false,
    });

    const response = await getFleetForecast(deps, fleetForecastRequest());

    expect(response.statusCode).toBe(500);
    expect(apiErrorSchema.parse(jsonBodyOf(response)).code).toBe('internal');
    // Both sites share one batch, so both were read \u2014 and the refusal names the first in site
    // order. No further batch is started: the answer cannot become whole by reading more.
    expect(reads).toHaveLength(2);
    expect(logged.at(-1)).toEqual({
      event: fleetForecastReadDeadlineEvent,
      siteId: RANELAGH_ID,
    });
  });

  it('serves the fleet the fan-out summed, credited, when nothing has been rolled up yet', async () => {
    const { deps, logged } = stub({
      sites: [RANELAGH, RATHMINES],
      pointsBySite: {
        [RANELAGH_ID]: [{ type: 'forecast', forecast: forecast({ acPowerKw: 2.8 }) }],
        [RATHMINES_ID]: [
          { type: 'forecast', forecast: forecast({ siteId: RATHMINES_ID, acPowerKw: 1.6 }) },
        ],
      },
    });

    const body = fleetForecastResponseSchema.parse(
      jsonBodyOf(await getFleetForecast(deps, fleetForecastRequest())),
    );

    // Summed server-side, which is what the browser used to do with these rows. The arm's own
    // conditions \u2014 which partition states fall back, and what each logs \u2014 are
    // `fleet-rollup-read.test.ts`; what is proved here is that the route serves this arm's answer
    // through the same envelope, attribution included.
    expect(body.points.map((point) => point.acPowerKw)).toEqual([4.4]);
    expect(body.attribution).toEqual(openMeteoAttribution);
    expect(logged[0]).toMatchObject({ event: fleetRollupFallbackEvent, reason: 'absent' });
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
