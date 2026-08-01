import { describe, expect, it } from 'vitest';

import { apiErrorCodeSchema, apiErrorSchema, type ApiErrorCode } from './api-error';

const codes: readonly ApiErrorCode[] = [
  'validation_failed',
  'not_found',
  'forbidden',
  'rate_limited',
  'internal',
];

const validationFailure = {
  code: 'validation_failed',
  message: 'Invalid site',
  details: [{ path: 'capacityKw', message: 'Too big: expected number to be <=50' }],
};

describe('apiErrorCodeSchema', () => {
  it.each(codes)('round-trips the %s code', (code) => {
    const result = apiErrorCodeSchema.safeParse(code);

    expect(result.success).toBe(true);
    expect(result.data).toBe(code);
  });

  it('rejects a code outside the set the API speaks', () => {
    // `unauthorized` specifically: the API has no credentials to demand, so a
    // refusal on policy is `forbidden` and there is no 401 anywhere in the
    // contract. A code added here to mean "log in" would be a contract this
    // service cannot honour.
    expect(apiErrorCodeSchema.safeParse('unauthorized').success).toBe(false);
  });

  // The set is the contract, so it is pinned rather than sampled: `apiErrorStatus`
  // in the API is an exhaustive `Record<ApiErrorCode, number>`, and every code
  // added here has to be given a status and a documented meaning before it can
  // reach a caller. A code added without that fails here first.
  it('speaks exactly the five codes the status mapping covers', () => {
    expect([...apiErrorCodeSchema.options].sort()).toEqual([
      'forbidden',
      'internal',
      'not_found',
      'rate_limited',
      'validation_failed',
    ]);
  });
});

describe('apiErrorSchema', () => {
  it.each(codes)('accepts a bare %s body — details are optional', (code) => {
    const result = apiErrorSchema.safeParse({ code, message: 'Something went wrong' });

    expect(result.success).toBe(true);
    expect(result.data?.details).toBeUndefined();
  });

  it('carries the field-level reasons a validation failure needs to be actionable', () => {
    const result = apiErrorSchema.safeParse(validationFailure);

    expect(result.success).toBe(true);
    expect(result.data?.details).toEqual([
      { path: 'capacityKw', message: 'Too big: expected number to be <=50' },
    ]);
  });

  it('rejects a body whose code is not one the API defines', () => {
    expect(apiErrorSchema.safeParse({ code: 'teapot', message: 'nope' }).success).toBe(false);
  });

  it('rejects an empty message — an error the caller cannot read is not an error body', () => {
    expect(apiErrorSchema.safeParse({ code: 'internal', message: '' }).success).toBe(false);
  });

  it.each(['code', 'message'])('rejects a body missing %s', (field) => {
    const partial = Object.fromEntries(
      Object.entries(validationFailure).filter(([name]) => name !== field),
    );

    expect(apiErrorSchema.safeParse(partial).success).toBe(false);
  });

  it('rejects a detail entry that is not a path/message pair', () => {
    const result = apiErrorSchema.safeParse({
      ...validationFailure,
      details: [{ path: ['capacityKw'], message: 'paths are flattened to strings on the wire' }],
    });

    expect(result.success).toBe(false);
  });
});
