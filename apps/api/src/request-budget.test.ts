import {
  DYNAMODB_BATCH_WRITE_SIZE,
  STORAGE_COMMAND_WORST_MS,
  STORAGE_MAX_ATTEMPTS,
} from '@cumulo/storage';
import { describe, expect, it } from 'vitest';

import {
  API_GATEWAY_INTEGRATION_TIMEOUT_MS,
  API_LAMBDA_TIMEOUT_MS,
  API_RESPONSE_MARGIN_MS,
  SERIES_CLEANUP_MAX_ITEMS,
  hasBudgetForStorageCommands,
} from './request-budget';

/**
 * The budget's job is to be *wrong loudly* when one of the numbers it is
 * derived from moves. These tests are the alarms: each one fails on a change
 * that would otherwise leave the cleanup silently mis-sized.
 */
describe('API request budget', () => {
  it('mirrors the deployed function timeout', () => {
    // The other half of this pair is `pnpm check:infra-mirrors`, which compares
    // this constant against `aws_lambda_function.api`'s `timeout` in
    // `infra/api/lambda.tf`. This assertion is what makes the literal itself
    // deliberate; the gate is what makes the two files agree.
    expect(API_LAMBDA_TIMEOUT_MS).toBe(15_000);
  });

  it('sits below the gateway integration ceiling it was chosen against', () => {
    // The inequality `check-infra-mirrors.sh` records as inexpressible: its
    // records are equalities between two files, and this bound belongs to AWS.
    // Held here instead — the mirror gate keeps the constant equal to the
    // deployed timeout, so a Terraform change that raised the function past
    // 30 s reaches this assertion and fails, rather than reaching production
    // and being cut off by the gateway with no Lambda evidence behind it.
    expect(API_LAMBDA_TIMEOUT_MS).toBeLessThan(API_GATEWAY_INTEGRATION_TIMEOUT_MS);
  });

  it('is sized at the pinned two-attempt retry budget, and says so if that moves', () => {
    // `STORAGE_COMMAND_WORST_MS` is 7,000 only while a command gets two
    // attempts; at three it is 12,000, the cleanup's command budget floors to
    // one, and a pass would list rows it has no budget to delete. Storage's own
    // test pins the 7,000; this one pins the premise *this* file's arithmetic
    // rests on, so raising the attempt count fails in both places.
    expect(STORAGE_MAX_ATTEMPTS).toBe(2);
  });

  it('leaves room for exactly one batch of deletes after the listing query', () => {
    expect(SERIES_CLEANUP_MAX_ITEMS).toBe(DYNAMODB_BATCH_WRITE_SIZE);
  });

  it('keeps a cleanup pass inside the function timeout', () => {
    const listingQuery = 1;
    const deleteBatches = Math.ceil(SERIES_CLEANUP_MAX_ITEMS / DYNAMODB_BATCH_WRITE_SIZE);

    const worstCaseMs = (listingQuery + deleteBatches) * STORAGE_COMMAND_WORST_MS;

    expect(worstCaseMs).toBeLessThanOrEqual(API_LAMBDA_TIMEOUT_MS);
    // And the next batch up would not fit — which is the property that makes 25
    // the *largest* honest budget rather than merely a safe one.
    expect(worstCaseMs + STORAGE_COMMAND_WORST_MS).toBeGreaterThan(API_LAMBDA_TIMEOUT_MS);
  });

  it('spends its whole delete budget on one round trip rather than several small ones', () => {
    // A budget that was not a whole multiple of the batch size would pay for a
    // round trip it could not fill.
    expect(SERIES_CLEANUP_MAX_ITEMS % DYNAMODB_BATCH_WRITE_SIZE).toBe(0);
  });
});

/**
 * The predicate every looping term asks before its next command. Its whole
 * content is one boundary, so these tests are that boundary from both sides:
 * an off-by-one here is a command started with no time to finish it, which is
 * the gateway 504 the deadline exists to prevent.
 */
describe('hasBudgetForStorageCommands', () => {
  const oneCommandThresholdMs = STORAGE_COMMAND_WORST_MS + API_RESPONSE_MARGIN_MS;

  it('refuses one command at exactly its threshold and permits it one millisecond later', () => {
    expect(oneCommandThresholdMs).toBe(8_000);
    expect(hasBudgetForStorageCommands(8_000, 1)).toBe(false);
    expect(hasBudgetForStorageCommands(8_001, 1)).toBe(true);
  });

  it('refuses a command whose own worst case would consume every millisecond left', () => {
    // 7,000 ms remaining buys a command that takes 7,000 ms and leaves nothing
    // to answer with — the margin is on top of the command, not inside it.
    expect(hasBudgetForStorageCommands(STORAGE_COMMAND_WORST_MS, 1)).toBe(false);
  });

  it('permits one command at the full invocation budget', () => {
    expect(hasBudgetForStorageCommands(API_LAMBDA_TIMEOUT_MS, 1)).toBe(true);
  });

  it('will not buy two worst-case commands even with the whole timeout left', () => {
    // 2 × 7,000 + 1,000 = 15,000, which the timeout exactly fails to exceed.
    // The same arithmetic the module header states about coinciding worst
    // cases, asserted rather than described.
    expect(hasBudgetForStorageCommands(API_LAMBDA_TIMEOUT_MS, 2)).toBe(false);
    expect(hasBudgetForStorageCommands(API_LAMBDA_TIMEOUT_MS + 1, 2)).toBe(true);
  });

  it('refuses a deadline that has already passed', () => {
    expect(hasBudgetForStorageCommands(0, 1)).toBe(false);
    expect(hasBudgetForStorageCommands(-1_000, 1)).toBe(false);
  });

  it('throws on a command count that describes no work', () => {
    // A violated invariant rather than a `false`: a caller asking for zero, a
    // fraction of a command or a negative number of them has a bug, and
    // answering "no budget" would hide it behind an ordinary refusal.
    expect(() => hasBudgetForStorageCommands(API_LAMBDA_TIMEOUT_MS, 0)).toThrow(/positive integer/);
    expect(() => hasBudgetForStorageCommands(API_LAMBDA_TIMEOUT_MS, 1.5)).toThrow(
      /positive integer/,
    );
    expect(() => hasBudgetForStorageCommands(API_LAMBDA_TIMEOUT_MS, -1)).toThrow(
      /positive integer/,
    );
  });
});
