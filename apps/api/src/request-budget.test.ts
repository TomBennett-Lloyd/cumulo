import { DYNAMODB_BATCH_WRITE_SIZE, STORAGE_MAX_ATTEMPTS } from '@cumulo/storage';
import { describe, expect, it } from 'vitest';

import {
  API_LAMBDA_TIMEOUT_MS,
  DYNAMODB_REQUEST_WORST_MS,
  SERIES_CLEANUP_MAX_ITEMS,
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

  it('prices one DynamoDB request at every attempt burning its full deadline', () => {
    expect(DYNAMODB_REQUEST_WORST_MS).toBe(7_000);
  });

  it('is derived at the pinned two-attempt retry budget, and says so if that moves', () => {
    // `DYNAMODB_REQUEST_WORST_MS` adds a single base delay for the single
    // retry. At three attempts the backoff curve doubles and that term would be
    // 3,000 ms rather than 1,000 — so a raised budget must re-derive the sum,
    // and this is where it is told.
    expect(STORAGE_MAX_ATTEMPTS).toBe(2);
  });

  it('leaves room for exactly one batch of deletes after the listing query', () => {
    expect(SERIES_CLEANUP_MAX_ITEMS).toBe(DYNAMODB_BATCH_WRITE_SIZE);
  });

  it('keeps a cleanup pass inside the function timeout', () => {
    const listingQuery = 1;
    const deleteBatches = Math.ceil(SERIES_CLEANUP_MAX_ITEMS / DYNAMODB_BATCH_WRITE_SIZE);

    const worstCaseMs = (listingQuery + deleteBatches) * DYNAMODB_REQUEST_WORST_MS;

    expect(worstCaseMs).toBeLessThanOrEqual(API_LAMBDA_TIMEOUT_MS);
    // And the next batch up would not fit — which is the property that makes 25
    // the *largest* honest budget rather than merely a safe one.
    expect(worstCaseMs + DYNAMODB_REQUEST_WORST_MS).toBeGreaterThan(API_LAMBDA_TIMEOUT_MS);
  });

  it('spends its whole delete budget on one round trip rather than several small ones', () => {
    // A budget that was not a whole multiple of the batch size would pay for a
    // round trip it could not fill.
    expect(SERIES_CLEANUP_MAX_ITEMS % DYNAMODB_BATCH_WRITE_SIZE).toBe(0);
  });
});
