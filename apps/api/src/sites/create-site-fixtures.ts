import { MAX_USER_SITES, utcIsoTimestampSchema, type FleetSite } from '@cumulo/shared';
import type { OldestUserSiteResult } from '@cumulo/storage';
import { expect } from 'vitest';

import { RANELAGH_ID, RATHMINES_ID } from '../api-fixtures';

import type { CreateSiteDeps } from './create-site';

/**
 * The scripted fleet `create-site.test.ts` drives the route through.
 *
 * A test double rather than a fake table, because what matters on this route is
 * the *order* of its three storage calls and which branch each answer takes —
 * so each scripted answer is one line, and the retry loop's behaviour under
 * contention is expressible as a vocabulary of per-attempt outcomes.
 *
 * Its own module because `create-site.test.ts` is at the 300-line ceiling
 * (`docs/standards/structure.md` rule 4: when a file grows, the first cut is its
 * types and fixtures) — not because anything else uses it. The delete route's
 * test scripts its own fleet; the two share a shape but not an intent, and merging
 * them would couple two routes' contention models (rule 7).
 */

/** The route's clock, fixed: `utcIsoTimestampSchema`'s exact accepted form. */
export const CREATED_AT = utcIsoTimestampSchema.parse('2026-07-31T09:00:00Z');

export interface FleetScript {
  /**
   * One answer per attempt, in the adapter's own vocabulary: the site was
   * stored, the cap refused it, or a concurrent transaction got the row and
   * DynamoDB cancelled this one.
   */
  readonly creates?: readonly ('created' | 'cap' | 'conflict')[];
  /**
   * One answer per attempt, as the adapter's own result type: a found id, or
   * `{ found: false }` for an index with nothing in it — the drift case where
   * the counter says full and the index disagrees.
   */
  readonly oldest?: readonly OldestUserSiteResult[];
  /** One answer per attempt: evicted, beaten to the same site, or cancelled. */
  readonly evictions?: readonly ('evicted' | 'oldest_gone' | 'conflict')[];
  /**
   * Makes `createUserSiteWithCap` *reject* rather than answer — the shape a
   * storage failure that is nobody's expected outcome arrives in, as opposed to
   * the three above.
   */
  readonly createFailure?: () => Promise<never>;
}

export interface FleetCalls {
  readonly written: FleetSite[];
  readonly evicted: string[];
  readonly logged: Record<string, unknown>[];
  readonly oldestLookups: number[];
  /** One entry per `createUserSiteWithCap` call — how the budget was spent. */
  readonly createAttempts: number[];
  /** Every backoff the route slept, in order: the curve as it actually ran. */
  readonly sleeps: number[];
}

/**
 * The script's answer for this attempt, holding the last one once the script
 * runs out, so a script states only what changes between attempts.
 */
const answerFor = <T>(answers: readonly T[] | undefined, attempt: number, fallback: T): T =>
  answers?.[Math.min(attempt, answers.length - 1)] ?? fallback;

export const scriptedFleet = (
  script: FleetScript = {},
  newSiteId: () => string = () => RANELAGH_ID,
): { deps: CreateSiteDeps; calls: FleetCalls } => {
  const calls: FleetCalls = {
    written: [],
    evicted: [],
    logged: [],
    oldestLookups: [],
    createAttempts: [],
    sleeps: [],
  };
  let evictAttempt = 0;

  const deps: CreateSiteDeps = {
    sites: {
      createUserSiteWithCap: (site, cap) => {
        const attempt = calls.createAttempts.length;
        calls.createAttempts.push(attempt);
        if (script.createFailure !== undefined) {
          return script.createFailure();
        }
        const outcome = answerFor(script.creates, attempt, 'created');
        if (outcome === 'created') {
          calls.written.push(site);
          return Promise.resolve({ created: true });
        }
        expect(cap).toBe(MAX_USER_SITES);
        return Promise.resolve({ created: false, reason: outcome });
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
        const outcome = answerFor(script.evictions, evictAttempt, 'evicted');
        evictAttempt += 1;
        if (outcome !== 'evicted') {
          return Promise.resolve({ evicted: false, reason: outcome });
        }
        calls.evicted.push(evictSiteId);
        calls.written.push(site);
        return Promise.resolve({ evicted: true });
      },
    },
    now: () => CREATED_AT,
    newSiteId,
    log: (entry) => calls.logged.push(entry),
    // Recorded and resolved rather than actually waited: what a test can prove
    // about a backoff is the sequence of delays, and sleeping them would price
    // the exhaustion cases at seconds each.
    sleep: (ms) => {
      calls.sleeps.push(ms);
      return Promise.resolve();
    },
    // Full jitter is `floor(random × cap)`, so a fixed 0.5 turns each recorded
    // sleep into exactly half its ceiling — the curve, readable in the numbers.
    random: () => 0.5,
  };

  return { deps, calls };
};
