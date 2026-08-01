import { describe, expect, it } from 'vitest';

import { describeThrown } from './thrown-detail';

/**
 * Every caller puts this string into an outcome an operator reads — ingestion's
 * `unreachable` adapter detail, a location's `failed` detail — so what is asserted
 * here is that the two facts an operator needs survive: what kind of failure it
 * was, and what it said.
 */
describe('describeThrown', () => {
  it('names the error class and its message', () => {
    expect(describeThrown(new TypeError('fetch failed'))).toBe('TypeError: fetch failed');
  });

  it('keeps a subclass name rather than flattening it to Error', () => {
    class QueueDoesNotExist extends Error {
      override readonly name = 'QueueDoesNotExist';
    }

    expect(describeThrown(new QueueDoesNotExist('no such queue'))).toBe(
      'QueueDoesNotExist: no such queue',
    );
  });

  it('a non-Error throw is reported as one instead of rendering undefined', () => {
    // The case a naive `.message` loses: the incident becomes the string
    // "undefined" and nothing points back at the code that threw.
    expect(describeThrown('boom')).toBe('non-Error thrown (string)');
    expect(describeThrown(undefined)).toBe('non-Error thrown (undefined)');
  });
});
