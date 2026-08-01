import { canonicalFleetSeed, generateFleet, locationId, MAX_USER_SITES } from '@cumulo/shared';
import { describe, expect, it } from 'vitest';

import {
  CYCLE_DEADLINE_MS,
  FETCH_WORST_MS,
  INGESTION_LAMBDA_TIMEOUT_MS,
  LOCATION_WORST_MS,
  MAX_LOCATIONS_PER_CYCLE,
  PUBLISH_WORST_MS,
  SHUTDOWN_MARGIN_MS,
  STORE_BATCHES_PER_LOCATION,
  STORE_SEND_WORST_MS,
  STORE_WORST_MS,
  backoffCeilingMs,
} from './cycle-budget';
import { FETCH_MAX_ATTEMPTS } from './open-meteo/fetch-forecast';

/**
 * The budget is computed from imported constants, so these tests pin it against
 * the *literals* — the numbers `infra/ingestion/lambda.tf`'s rationale quotes
 * and a reviewer checks by hand. That is the point of asserting both ways: the
 * module proves the arithmetic follows from the effects' own configuration, and
 * these assertions prove the arithmetic still lands where the deployed timeout
 * was argued from. Changing a retry count or a request timeout anywhere in the
 * three effects fails here, which is the notification the previous
 * comment-only derivation never sent.
 */

describe('backoffCeilingMs', () => {
  it('sums the doubling caps of every retry a policy allows', () => {
    // Four attempts is three retries: 1×, 2×, 4× the base.
    expect(backoffCeilingMs(4, 1_000)).toBe(7_000);
    expect(backoffCeilingMs(3, 200)).toBe(600);
    expect(backoffCeilingMs(2, 1_000)).toBe(1_000);
  });

  it('a policy that never retries costs no backoff', () => {
    expect(backoffCeilingMs(1, 5_000)).toBe(0);
  });

  it('rejects an attempt count that is not a positive integer', () => {
    // A violated invariant, not a domain outcome (error-handling rule 1): a
    // budget silently computed from a nonsense policy is worse than no budget.
    expect(() => backoffCeilingMs(0, 100)).toThrow(/positive integer/);
    expect(() => backoffCeilingMs(1.5, 100)).toThrow(/positive integer/);
  });
});

describe('the per-location worst case', () => {
  it('prices a fetch at both attempts plus the full jitter window', () => {
    expect(FETCH_MAX_ATTEMPTS).toBe(2);
    expect(FETCH_WORST_MS).toBe(21_000);
  });

  it("splits a location's 48-hour horizon into two BatchWriteItem round trips", () => {
    expect(STORE_BATCHES_PER_LOCATION).toBe(2);
  });

  it('prices one batch write at two SDK attempts plus the pinned storage backoff', () => {
    // 2 × 3 s + 1 s. The 6 s of request timeout is the term #115 added: before
    // the storage client pinned one, this was unbounded. The attempt count is
    // two rather than four because #122 left throttling to the drain layer.
    expect(STORE_SEND_WORST_MS).toBe(7_000);
  });

  it('prices a store at the drain attempts over the collapsed send worst case, which is the dominant term', () => {
    // 2 batches × (3 drain attempts × 7 s + 0.6 s of drain backoff).
    expect(STORE_WORST_MS).toBe(43_200);
    expect(STORE_WORST_MS).toBeGreaterThan(FETCH_WORST_MS + PUBLISH_WORST_MS);
  });

  it('prices a publish at three attempts plus the SDK throttling backoff', () => {
    expect(PUBLISH_WORST_MS).toBe(10_500);
  });

  it('sums all three effects, none of them priced at zero', () => {
    // The defect #115 named: the old budget counted the fetch and nothing else.
    expect(LOCATION_WORST_MS).toBe(74_700);
    expect(LOCATION_WORST_MS).toBe(FETCH_WORST_MS + STORE_WORST_MS + PUBLISH_WORST_MS);
    expect(FETCH_WORST_MS).toBeGreaterThan(0);
    expect(STORE_WORST_MS).toBeGreaterThan(0);
    expect(PUBLISH_WORST_MS).toBeGreaterThan(0);
  });
});

describe('the cycle deadline', () => {
  it('leaves the function timeout unreachable by construction', () => {
    // The load-bearing property of the whole design: the last location the
    // cycle can start finishes, and the summary flushes, before AWS kills the
    // invocation. If this identity ever fails, a cycle can be killed mid-loop
    // and #115's original failure shape is back.
    expect(CYCLE_DEADLINE_MS + LOCATION_WORST_MS + SHUTDOWN_MARGIN_MS).toBe(
      INGESTION_LAMBDA_TIMEOUT_MS,
    );
    expect(CYCLE_DEADLINE_MS).toBe(220_300);
  });

  it('is long enough to be worth having', () => {
    // A negative or trivial deadline would make every cycle skip everything
    // while still passing the identity above — the identity alone is not
    // enough. At 220 s a healthy cycle (well under a second per location) has
    // room for far more locations than the cap allows.
    expect(CYCLE_DEADLINE_MS).toBeGreaterThan(0);
    expect(CYCLE_DEADLINE_MS).toBeGreaterThan(LOCATION_WORST_MS / 2);
  });

  it('mirrors the deployed Lambda timeout', () => {
    // A mirror of `infra/ingestion/lambda.tf`. This assertion pins the literal
    // so that a change to it is a deliberate one; what pins it to *Terraform*
    // is `pnpm check:infra-mirrors` in the `verify` composite (#123), which
    // reads both files. Vitest cannot do that job — it would have to parse HCL
    // — and a green suite here has never meant the deployed timeout agrees.
    expect(INGESTION_LAMBDA_TIMEOUT_MS).toBe(300_000);
  });
});

describe('the location cap', () => {
  /** Open-Meteo's free tier, as CLAUDE.md states it. */
  const DAILY_CALL_ALLOWANCE = 10_000;
  const CYCLES_PER_DAY = 24;

  it('keeps a full day of full cycles inside a quarter of the daily allowance', () => {
    const callsPerDay = MAX_LOCATIONS_PER_CYCLE * CYCLES_PER_DAY;

    expect(callsPerDay).toBe(2_400);
    expect(callsPerDay / DAILY_CALL_ALLOWANCE).toBeLessThanOrEqual(0.25);
  });

  it('stays inside the allowance even if every location needs its retry', () => {
    // The headroom that matters: a bad day is when every fetch retries, and
    // #16's archive backfill draws on the same quota.
    const worstCallsPerDay = MAX_LOCATIONS_PER_CYCLE * CYCLES_PER_DAY * FETCH_MAX_ATTEMPTS;

    expect(worstCallsPerDay).toBeLessThan(DAILY_CALL_ALLOWANCE);
  });

  it('clears every fleet size this repo has committed to', () => {
    // 12 from docs/design/fleet-simulation.md's canonical fleet, ~30 from ADR
    // 0002's assumed scale — and room above both for #17's visitor sites,
    // which is why ingestion enforces its own bound rather than inheriting one.
    expect(MAX_LOCATIONS_PER_CYCLE).toBeGreaterThan(30);
  });

  /**
   * The cross-check that closes the loop on #17's visitor sites, now that
   * `MAX_USER_SITES` bounds how many of them exist at once.
   *
   * It lives on the ingestion side because this is the only side of the
   * dependency edge that can see both numbers: `@cumulo/shared` owns the cap and
   * cannot import an app (architecture rule 1), so the cap's own test can only
   * restate 100 as a literal. Here it is the constant itself, which is what
   * makes raising *either* number a red build rather than a silent deferral —
   * a full fleet that exceeded this cap would not fail, it would quietly skip
   * locations every hour as `location-cap` and be visible only in the report.
   */
  it('leaves room for a full user-site cap on top of the seed fleet, with no location deferred', () => {
    const seedLocations = new Set(generateFleet(canonicalFleetSeed).map((site) => locationId(site)))
      .size;

    expect(seedLocations + MAX_USER_SITES).toBeLessThanOrEqual(MAX_LOCATIONS_PER_CYCLE);
  });
});
