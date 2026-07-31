import { describe, expect, it } from 'vitest';

import { apiErrorCodeSchema, apiErrorSchema, type ApiErrorCode } from './api-error';

const codes: readonly ApiErrorCode[] = ['validation_failed', 'not_found', 'internal'];

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

  it('rejects a code outside the three the API speaks', () => {
    expect(apiErrorCodeSchema.safeParse('rate_limited').success).toBe(false);
  });

  // Not decoration: `rate_limited` above is the specific absence that matters.
  // Throttled responses come from the gateway's stage limit before the Lambda
  // runs, so they never carry this body — clients map 429 on the status. A code
  // added here without that carve-out being revisited fails this test.
  it('speaks exactly the three codes the status mapping covers', () => {
    expect([...apiErrorCodeSchema.options].sort()).toEqual([
      'internal',
      'not_found',
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
