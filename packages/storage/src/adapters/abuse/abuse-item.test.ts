import { describe, expect, it } from 'vitest';

import { blockKey, rateWindowKey, toBlockItem, toBlockedUntil, toRequestCount } from './abuse-item';

/**
 * The key format carries the real risk on this table: one hash key holds two
 * row kinds for arbitrarily many client addresses, so the only thing keeping
 * one address's rows from colliding with another's is the shape of the string.
 * It is pure, so it is pinned directly (`docs/standards/testing.md` rule 2).
 */

const IP = '203.0.113.7';

describe('rateWindowKey', () => {
  it('names the kind, the address and the window it counts', () => {
    expect(rateWindowKey(IP, 1_800_000_060)).toBe('RATE#203.0.113.7#1800000060');
  });

  it('gives each window of one address its own item', () => {
    expect(rateWindowKey(IP, 1_800_000_060)).not.toBe(rateWindowKey(IP, 1_800_000_120));
  });

  it('keeps an IPv6 address in one piece', () => {
    expect(rateWindowKey('2001:db8::1', 60)).toBe('RATE#2001:db8::1#60');
  });
});

describe('blockKey', () => {
  it('gives an address exactly one block row, distinct from its counters', () => {
    expect(blockKey(IP)).toBe('BLOCK#203.0.113.7');
    expect(blockKey(IP)).not.toBe(rateWindowKey(IP, 60));
  });
});

describe('address validation', () => {
  it('refuses an address that could address another address’s row', () => {
    // '#' is the delimiter, so an address containing one could be read back as
    // a different (address, window) pair — one client's requests counted
    // against another's budget.
    expect(() => rateWindowKey('203.0.113.7#1800000060', 60)).toThrow(/client address/);
    expect(() => blockKey('a#b')).toThrow(/client address/);
    expect(() => blockKey('')).toThrow(/client address/);
  });
});

describe('toBlockItem', () => {
  it('sets the TTL to the instant the block stops meaning anything', () => {
    expect(toBlockItem(IP, 1_800_003_600)).toEqual({
      pk: 'BLOCK#203.0.113.7',
      blockedUntil: 1_800_003_600,
      expiresAt: 1_800_003_600,
    });
  });
});

describe('toRequestCount', () => {
  it('reads the post-increment count DynamoDB returns', () => {
    expect(toRequestCount({ requestCount: 31, expiresAt: 1_800_000_180 })).toBe(31);
  });

  it('refuses a count that cannot be compared to a threshold', () => {
    // A string or a fraction here would mean this row was written by something
    // other than `incrementRateWindow`; comparing it to a limit would produce a
    // silently wrong verdict instead of an error.
    expect(() => toRequestCount({ requestCount: '31' })).toThrow();
    expect(() => toRequestCount({ requestCount: 1.5 })).toThrow();
    expect(() => toRequestCount(undefined)).toThrow();
  });
});

describe('toBlockedUntil', () => {
  it('reads the block instant and ignores the TTL copy of it', () => {
    expect(toBlockedUntil({ pk: 'BLOCK#x', blockedUntil: 42, expiresAt: 42 })).toBe(42);
  });

  it('refuses a row that carries no block instant', () => {
    expect(() => toBlockedUntil({ pk: 'BLOCK#x', expiresAt: 42 })).toThrow();
  });
});
