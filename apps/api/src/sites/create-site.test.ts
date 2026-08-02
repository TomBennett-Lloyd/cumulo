import { apiErrorSchema, fleetSiteSchema } from '@cumulo/shared';
import { StorageError } from '@cumulo/storage';
import { describe, expect, it } from 'vitest';

import { jsonBodyOf, RANELAGH_ID, RATHMINES_ID, routeRequest, siteInput } from '../api-fixtures';
import { SERIES_CLEANUP_MAX_ITEMS } from '../request-budget';

import { CREATED_AT, scriptedFleet } from './create-site-fixtures';
import { createSite, createSiteStoreExhaustedEvent } from './create-site';
import { seriesCleanupFailedEvent } from './series-cleanup';

/** A third id, for the tests where the index names a different site each look. */
const RINGSEND_ID = '5b2c9d1e-3f4a-4b5c-8d6e-7f8a9b0c1d2e';

const postSite = routeRequest({ method: 'POST', body: siteInput() });

describe('POST /v1/sites', () => {
  it('answers 201 with the created site, id included', async () => {
    const { deps, calls } = scriptedFleet();

    const response = await createSite(deps, postSite);

    expect(response.statusCode).toBe(201);
    const body = fleetSiteSchema.parse(jsonBodyOf(response));
    // The server-assigned id is in the response body — the only legitimate way
    // for the caller to learn it.
    expect(body.id).toBe(RANELAGH_ID);
    expect(calls.written).toEqual([body]);
  });

  it('assigns a fresh id per request rather than reusing one', async () => {
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
    let issued = 0;
    const { deps, calls } = scriptedFleet({}, () => ids[issued++] ?? '');

    await createSite(deps, postSite);
    await createSite(deps, postSite);

    expect(calls.written.map((site) => site.id)).toEqual(ids);
  });

  it('sets the three fields the caller does not own', async () => {
    const { deps, calls } = scriptedFleet();

    await createSite(deps, postSite);

    expect(calls.written[0]?.origin).toBe('user');
    expect(calls.written[0]?.active).toBe(true);
    expect(calls.written[0]?.createdAt).toBe(CREATED_AT);
  });

  it('ignores an id a caller tried to choose', async () => {
    const { deps, calls } = scriptedFleet();
    const attacker = { ...siteInput(), id: '99999999-9999-4999-8999-999999999999' };

    await createSite(deps, routeRequest({ method: 'POST', body: attacker }));

    expect(calls.written[0]?.id).toBe(RANELAGH_ID);
  });

  it('answers 400 naming the offending fields when the body is not a valid site', async () => {
    const { deps, calls } = scriptedFleet();

    const response = await createSite(
      deps,
      routeRequest({ method: 'POST', body: { ...siteInput(), capacityKw: 500, tiltDegrees: -5 } }),
    );

    expect(response.statusCode).toBe(400);
    const body = apiErrorSchema.parse(jsonBodyOf(response));
    expect(body.code).toBe('validation_failed');
    expect(body.details?.map((detail) => detail.path)).toEqual(['tiltDegrees', 'capacityKw']);
    expect(calls.written).toEqual([]);
  });

  it('answers 400 when there is no body at all', async () => {
    const { deps } = scriptedFleet();

    const response = await createSite(deps, routeRequest({ method: 'POST' }));

    expect(response.statusCode).toBe(400);
    expect(apiErrorSchema.parse(jsonBodyOf(response)).code).toBe('validation_failed');
  });

  it('does not look for anything to evict while the fleet is under its cap', async () => {
    const { deps, calls } = scriptedFleet({ creates: ['created'] });

    await createSite(deps, postSite);

    expect(calls.oldestLookups).toEqual([]);
    expect(calls.evicted).toEqual([]);
    expect(calls.cleaned).toEqual([]);
  });

  it('evicts the oldest user site and still answers 201 when the fleet is at its cap', async () => {
    const { deps, calls } = scriptedFleet({ creates: ['cap'] });

    const response = await createSite(deps, postSite);

    expect(response.statusCode).toBe(201);
    expect(fleetSiteSchema.parse(jsonBodyOf(response)).id).toBe(RANELAGH_ID);
    // Exactly one site left, and it is the one the index named — the seed fleet
    // is not in that index at all, so nothing here can reach a seed site.
    expect(calls.evicted).toEqual([RATHMINES_ID]);
    expect(calls.written.map((site) => site.id)).toEqual([RANELAGH_ID]);
  });

  it("deletes the evicted site's series points, so the cap bounds rows and not just sites", async () => {
    const { deps, calls } = scriptedFleet({ creates: ['cap'] });

    await createSite(deps, postSite);

    expect(calls.cleaned).toEqual([RATHMINES_ID]);
    // Bounded, and by the budget derived from the function timeout rather than
    // by anything this handler chose: an unbounded pass after the create has
    // committed is what loses the 201 carrying the new site's id.
    expect(calls.budgets).toEqual([SERIES_CLEANUP_MAX_ITEMS]);
  });

  it('retries the create when the counter says full but the index has nothing to evict', async () => {
    // Counter/index drift: a bare decrement from here would be the corruption,
    // so the route re-attempts the create instead and never reaches eviction.
    const { deps, calls } = scriptedFleet({
      creates: ['cap', 'created'],
      oldest: [{ found: false }],
    });

    const response = await createSite(deps, postSite);

    expect(response.statusCode).toBe(201);
    expect(calls.evicted).toEqual([]);
    expect(calls.written.map((site) => site.id)).toEqual([RANELAGH_ID]);
  });

  it('looks up the oldest site again after losing an eviction race', async () => {
    const { deps, calls } = scriptedFleet({
      creates: ['cap'],
      oldest: [
        { found: true, siteId: RATHMINES_ID },
        { found: true, siteId: RINGSEND_ID },
      ],
      evictions: ['oldest_gone', 'evicted'],
    });

    const response = await createSite(deps, postSite);

    expect(response.statusCode).toBe(201);
    // The second attempt evicted whatever was oldest *then*, not the site the
    // first attempt had already lost the race for.
    expect(calls.evicted).toEqual([RINGSEND_ID]);
  });

  it('retries the create after a counter conflict instead of answering 500', async () => {
    // The regression #29's E2-a measured: a transaction DynamoDB cancelled for
    // contention used to reach the caller as an untyped 500.
    const { deps, calls } = scriptedFleet({ creates: ['conflict', 'created'] });

    const response = await createSite(deps, postSite);

    expect(response.statusCode).toBe(201);
    expect(calls.written.map((site) => site.id)).toEqual([RANELAGH_ID]);
    // A conflict says nothing about the cap, so nothing was looked up to evict.
    expect(calls.oldestLookups).toEqual([]);
    expect(calls.evicted).toEqual([]);
    // Slept before re-issuing rather than hot-retrying into the same winner.
    expect(calls.sleeps).toEqual([25]);
  });

  it('retries the eviction after a conflict and still answers 201', async () => {
    const { deps, calls } = scriptedFleet({
      creates: ['cap'],
      evictions: ['conflict', 'evicted'],
    });

    const response = await createSite(deps, postSite);

    expect(response.statusCode).toBe(201);
    expect(calls.evicted).toEqual([RATHMINES_ID]);
    expect(calls.sleeps).toEqual([25]);
  });

  it('answers 500 naming the exhausted budget when every attempt conflicts', async () => {
    const { deps, calls } = scriptedFleet({ creates: ['conflict'] });

    const response = await createSite(deps, postSite);

    expect(response.statusCode).toBe(500);
    expect(apiErrorSchema.parse(jsonBodyOf(response)).code).toBe('internal');
    expect(calls.written).toEqual([]);
    expect(calls.createAttempts).toHaveLength(12);
    // The curve, at half of each ceiling: 50, 100, 200, then held at 400.
    expect(calls.sleeps).toEqual([25, 50, 100, 200, 200, 200, 200, 200, 200, 200, 200]);
    // The structured line an operator reads: which budget ran out, and on what.
    expect(calls.logged).toEqual([
      {
        event: createSiteStoreExhaustedEvent,
        siteId: RANELAGH_ID,
        attempts: 12,
        lastOutcome: 'conflict',
      },
    ]);
  });

  it('does not retry a StorageError, leaving it for the request boundary', async () => {
    // The negative control on the loop's reach: an unexpected storage failure is
    // not a lost race, so retrying it would spend twelve attempts and 3.5
    // seconds on a call that cannot succeed. It propagates on the first one.
    const { deps, calls } = scriptedFleet({
      createFailure: () =>
        Promise.reject(
          new StorageError(
            { operation: 'createUserSiteWithCap', table: 'cumulo-sites-dev' },
            { cause: new Error('throughput exceeded') },
          ),
        ),
    });

    await expect(createSite(deps, postSite)).rejects.toThrow(StorageError);
    expect(calls.createAttempts).toHaveLength(1);
    expect(calls.sleeps).toEqual([]);
    expect(calls.logged).toEqual([]);
  });

  it('answers 500 and logs when every attempt loses the eviction race', async () => {
    const { deps, calls } = scriptedFleet({ creates: ['cap'], evictions: ['oldest_gone'] });

    const response = await createSite(deps, postSite);

    expect(response.statusCode).toBe(500);
    expect(apiErrorSchema.parse(jsonBodyOf(response)).code).toBe('internal');
    expect(calls.written).toEqual([]);
    expect(calls.logged).toEqual([
      {
        event: createSiteStoreExhaustedEvent,
        siteId: RANELAGH_ID,
        attempts: 12,
        lastOutcome: 'oldest_gone',
      },
    ]);
  });

  it('reports counter/index drift as the loss when the index stays empty', async () => {
    const { deps, calls } = scriptedFleet({ creates: ['cap'], oldest: [{ found: false }] });

    const response = await createSite(deps, postSite);

    expect(response.statusCode).toBe(500);
    expect(calls.logged).toEqual([
      {
        event: createSiteStoreExhaustedEvent,
        siteId: RANELAGH_ID,
        attempts: 12,
        lastOutcome: 'counter_index_drift',
      },
    ]);
  });

  it('gives up after a bounded number of attempts rather than spinning', async () => {
    const { deps, calls } = scriptedFleet({ creates: ['cap'], evictions: ['oldest_gone'] });

    await createSite(deps, postSite);

    expect(calls.oldestLookups).toHaveLength(12);
    expect(calls.createAttempts).toHaveLength(12);
  });

  it('still answers 201 when the series cleanup fails, and says so in the log', async () => {
    // The site exists; its predecessor's orphaned points expire on the 90-day
    // TTL. Answering 500 here would deny a create that demonstrably happened.
    const { deps, calls } = scriptedFleet({
      creates: ['cap'],
      cleanup: () =>
        Promise.reject(
          new StorageError(
            { operation: 'deleteSiteSeries', table: 'cumulo-series-dev' },
            { cause: new Error('throughput exceeded') },
          ),
        ),
    });

    const response = await createSite(deps, postSite);

    expect(response.statusCode).toBe(201);
    expect(calls.logged).toEqual([
      {
        event: seriesCleanupFailedEvent,
        siteId: RATHMINES_ID,
        detail:
          "StorageError: storage operation 'deleteSiteSeries' failed on table 'cumulo-series-dev'",
      },
    ]);
  });
});
