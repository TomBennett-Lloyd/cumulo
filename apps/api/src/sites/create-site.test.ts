import {
  apiErrorSchema,
  fleetSiteSchema,
  MAX_USER_SITES,
  utcIsoTimestampSchema,
  type FleetSite,
} from '@cumulo/shared';
import {
  StorageError,
  type SeriesCleanupOutcome,
  type OldestUserSiteResult,
} from '@cumulo/storage';
import { describe, expect, it } from 'vitest';

import { jsonBodyOf, RANELAGH_ID, RATHMINES_ID, routeRequest, siteInput } from '../api-fixtures';
import { SERIES_CLEANUP_MAX_ITEMS } from '../request-budget';

import { createSite, createSiteEvictionExhaustedEvent, type CreateSiteDeps } from './create-site';
import { seriesCleanupFailedEvent } from './series-cleanup';

const CREATED_AT = utcIsoTimestampSchema.parse('2026-07-31T09:00:00Z');

/** A third id, for the tests where the index names a different site each look. */
const RINGSEND_ID = '5b2c9d1e-3f4a-4b5c-8d6e-7f8a9b0c1d2e';

/** A cleanup pass that emptied the partition and hit neither of its limits. */
const CLEAN_SWEEP: SeriesCleanupOutcome = {
  deletedCount: 3,
  declinedCount: 0,
  budgetReached: false,
};

/**
 * A fleet the tests drive through its storage answers rather than through a
 * fake table: what matters on this route is the *order* of the three calls and
 * which branch each answer takes, so each scripted answer is one line here.
 */
interface FleetScript {
  /** One answer per attempt: `true` stores the site, `false` reports the cap. */
  readonly creates?: readonly boolean[];
  /**
   * One answer per attempt, as the adapter's own result type: a found id, or
   * `{ found: false }` for an index with nothing in it — the drift case where
   * the counter says full and the index disagrees.
   */
  readonly oldest?: readonly OldestUserSiteResult[];
  /** One answer per attempt: `true` evicted, `false` lost the race. */
  readonly evictions?: readonly boolean[];
  readonly cleanup?: () => Promise<SeriesCleanupOutcome>;
}

interface FleetCalls {
  readonly written: FleetSite[];
  readonly evicted: string[];
  readonly cleaned: string[];
  /** The item budget each pass was handed. */
  readonly budgets: number[];
  readonly logged: Record<string, unknown>[];
  readonly oldestLookups: number[];
}

/**
 * The script's answer for this attempt, holding the last one once the script
 * runs out, so a script states only what changes between attempts.
 */
const answerFor = <T>(answers: readonly T[] | undefined, attempt: number, fallback: T): T =>
  answers?.[Math.min(attempt, answers.length - 1)] ?? fallback;

const scriptedFleet = (
  script: FleetScript = {},
  newSiteId: () => string = () => RANELAGH_ID,
): { deps: CreateSiteDeps; calls: FleetCalls } => {
  const calls: FleetCalls = {
    written: [],
    evicted: [],
    cleaned: [],
    budgets: [],
    logged: [],
    oldestLookups: [],
  };
  let createAttempt = 0;
  let evictAttempt = 0;

  const deps: CreateSiteDeps = {
    sites: {
      createUserSiteWithCap: (site, cap) => {
        const created = answerFor(script.creates, createAttempt, true);
        createAttempt += 1;
        if (created) {
          calls.written.push(site);
          return Promise.resolve({ created: true });
        }
        expect(cap).toBe(MAX_USER_SITES);
        return Promise.resolve({ created: false, reason: 'cap' });
      },
      oldestUserSite: () => {
        const answer = answerFor(script.oldest, calls.oldestLookups.length, {
          found: true,
          siteId: RATHMINES_ID,
        });
        calls.oldestLookups.push(calls.oldestLookups.length);
        return Promise.resolve(answer);
      },
      evictAndCreateUserSite: (evictSiteId, site) => {
        const evicted = answerFor(script.evictions, evictAttempt, true);
        evictAttempt += 1;
        if (!evicted) {
          return Promise.resolve({ evicted: false, reason: 'oldest_gone' });
        }
        calls.evicted.push(evictSiteId);
        calls.written.push(site);
        return Promise.resolve({ evicted: true });
      },
    },
    series: {
      deleteSiteSeries: (siteId, maxItems) => {
        calls.cleaned.push(siteId);
        calls.budgets.push(maxItems);
        return script.cleanup?.() ?? Promise.resolve(CLEAN_SWEEP);
      },
    },
    now: () => CREATED_AT,
    newSiteId,
    log: (entry) => calls.logged.push(entry),
  };

  return { deps, calls };
};

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
    const { deps, calls } = scriptedFleet({ creates: [true] });

    await createSite(deps, postSite);

    expect(calls.oldestLookups).toEqual([]);
    expect(calls.evicted).toEqual([]);
    expect(calls.cleaned).toEqual([]);
  });

  it('evicts the oldest user site and still answers 201 when the fleet is at its cap', async () => {
    const { deps, calls } = scriptedFleet({ creates: [false] });

    const response = await createSite(deps, postSite);

    expect(response.statusCode).toBe(201);
    expect(fleetSiteSchema.parse(jsonBodyOf(response)).id).toBe(RANELAGH_ID);
    // Exactly one site left, and it is the one the index named — the seed fleet
    // is not in that index at all, so nothing here can reach a seed site.
    expect(calls.evicted).toEqual([RATHMINES_ID]);
    expect(calls.written.map((site) => site.id)).toEqual([RANELAGH_ID]);
  });

  it("deletes the evicted site's series points, so the cap bounds rows and not just sites", async () => {
    const { deps, calls } = scriptedFleet({ creates: [false] });

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
      creates: [false, true],
      oldest: [{ found: false }],
    });

    const response = await createSite(deps, postSite);

    expect(response.statusCode).toBe(201);
    expect(calls.evicted).toEqual([]);
    expect(calls.written.map((site) => site.id)).toEqual([RANELAGH_ID]);
  });

  it('looks up the oldest site again after losing an eviction race', async () => {
    const { deps, calls } = scriptedFleet({
      creates: [false],
      oldest: [
        { found: true, siteId: RATHMINES_ID },
        { found: true, siteId: RINGSEND_ID },
      ],
      evictions: [false, true],
    });

    const response = await createSite(deps, postSite);

    expect(response.statusCode).toBe(201);
    // The second attempt evicted whatever was oldest *then*, not the site the
    // first attempt had already lost the race for.
    expect(calls.evicted).toEqual([RINGSEND_ID]);
  });

  it('answers 500 and logs when three consecutive attempts all lose the race', async () => {
    const { deps, calls } = scriptedFleet({ creates: [false], evictions: [false] });

    const response = await createSite(deps, postSite);

    expect(response.statusCode).toBe(500);
    expect(apiErrorSchema.parse(jsonBodyOf(response)).code).toBe('internal');
    expect(calls.written).toEqual([]);
    expect(calls.logged).toEqual([
      { event: createSiteEvictionExhaustedEvent, siteId: RANELAGH_ID, attempts: 3 },
    ]);
  });

  it('gives up after a bounded number of attempts rather than spinning', async () => {
    const { deps, calls } = scriptedFleet({ creates: [false], evictions: [false] });

    await createSite(deps, postSite);

    expect(calls.oldestLookups).toHaveLength(3);
  });

  it('still answers 201 when the series cleanup fails, and says so in the log', async () => {
    // The site exists; its predecessor's orphaned points expire on the 90-day
    // TTL. Answering 500 here would deny a create that demonstrably happened.
    const { deps, calls } = scriptedFleet({
      creates: [false],
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
