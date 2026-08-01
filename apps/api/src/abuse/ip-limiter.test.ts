import type { BlockStatus } from '@cumulo/storage';
import { describe, expect, it } from 'vitest';

import {
  BLOCK_SECONDS,
  IpLimiter,
  MAX_LIMITED_REQUESTS_PER_WINDOW,
  RATE_WINDOW_SECONDS,
  type IpDecision,
} from './ip-limiter';

/**
 * The limiter is tested against an **in-memory implementation** of the abuse
 * table rather than against call assertions on a mock
 * (`docs/standards/testing.md` rule 3): the interesting behaviour is what a
 * caller is told after n requests, and a fake that actually counts is the only
 * thing that can answer that. The two call counters exist for the one claim
 * that is genuinely about I/O — that a cached block costs none.
 */
class FakeAbuseStore {
  private readonly counts = new Map<string, number>();
  private readonly blocks = new Map<string, number>();
  private readonly now: () => number;

  incrementCalls = 0;
  getBlockCalls = 0;

  constructor(now: () => number) {
    this.now = now;
  }

  incrementRateWindow(ip: string, windowStartEpochSeconds: number): Promise<number> {
    this.incrementCalls += 1;
    // Keyed by window exactly as the real row is, so a limiter that computed
    // the wrong window start would visibly get a fresh counter here.
    const key = `${ip}#${String(windowStartEpochSeconds)}`;
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return Promise.resolve(next);
  }

  getBlock(ip: string): Promise<BlockStatus> {
    this.getBlockCalls += 1;
    const until = this.blocks.get(ip);
    // Mirrors the adapter: an elapsed block reads as no block, because TTL
    // deletion is not punctual.
    return Promise.resolve(
      until !== undefined && until > this.now()
        ? { blocked: true, blockedUntilEpochSeconds: until }
        : { blocked: false },
    );
  }

  putBlock(ip: string, blockedUntilEpochSeconds: number): Promise<void> {
    this.blocks.set(ip, blockedUntilEpochSeconds);
    return Promise.resolve();
  }
}

/** A store whose every read fails, for the fail-closed case. */
class FailingAbuseStore {
  getBlock(): Promise<BlockStatus> {
    return Promise.reject(new Error('storage: cumulo-abuse getBlock failed'));
  }

  incrementRateWindow(): Promise<number> {
    return Promise.reject(new Error('storage: cumulo-abuse incrementRateWindow failed'));
  }

  putBlock(): Promise<void> {
    return Promise.reject(new Error('storage: cumulo-abuse putBlock failed'));
  }
}

const IP = '203.0.113.1';
const OTHER_IP = '203.0.113.2';

/** A window boundary, so "within one window" is arithmetic a reader can check. */
const WINDOW_START = 1_800_000_000;

/**
 * A limiter, its store and a clock a test can move, built together because all
 * three have to agree about "now".
 */
const limiterAt = (
  startEpochSeconds: number,
): {
  readonly limiter: IpLimiter;
  readonly store: FakeAbuseStore;
  readonly setNow: (epochSeconds: number) => void;
} => {
  let current = startEpochSeconds;
  const now = (): number => current;
  const store = new FakeAbuseStore(now);
  return {
    limiter: new IpLimiter({ abuse: store, nowEpochSeconds: now }),
    store,
    setNow: (epochSeconds) => {
      current = epochSeconds;
    },
  };
};

const checkTimes = async (limiter: IpLimiter, ip: string, times: number): Promise<IpDecision[]> => {
  const decisions: IpDecision[] = [];
  for (let i = 0; i < times; i += 1) {
    decisions.push(await limiter.check(ip));
  }
  return decisions;
};

describe('IpLimiter', () => {
  it('admits requests up to the limit and refuses the one after it', async () => {
    const { limiter } = limiterAt(WINDOW_START);

    const decisions = await checkTimes(limiter, IP, MAX_LIMITED_REQUESTS_PER_WINDOW + 1);

    expect(decisions.slice(0, MAX_LIMITED_REQUESTS_PER_WINDOW)).toEqual(
      Array.from({ length: MAX_LIMITED_REQUESTS_PER_WINDOW }, () => ({ allowed: true })),
    );
    expect(decisions.at(-1)).toEqual({ allowed: false, retryAfterSeconds: BLOCK_SECONDS });
  });

  it('going over is a block, not a busy minute: the next window is refused too', async () => {
    // The distinction that makes this worth having. A plain window counter
    // would let an abuser resume at full speed one second later.
    const { limiter, setNow } = limiterAt(WINDOW_START);
    await checkTimes(limiter, IP, MAX_LIMITED_REQUESTS_PER_WINDOW + 1);

    setNow(WINDOW_START + RATE_WINDOW_SECONDS + 1);
    const decision = await limiter.check(IP);

    expect(decision.allowed).toBe(false);
  });

  it('refuses a blocked address from the container cache, with no further reads', async () => {
    const { limiter, store } = limiterAt(WINDOW_START);
    await checkTimes(limiter, IP, MAX_LIMITED_REQUESTS_PER_WINDOW + 1);
    const readsWhenBlocked = store.getBlockCalls;
    const incrementsWhenBlocked = store.incrementCalls;

    await checkTimes(limiter, IP, 5);

    // Not one extra call of either kind: a caller that has just earned an hour
    // is the caller most likely to keep calling, and re-learning the same fact
    // from DynamoDB is how a defence becomes a bill.
    expect(store.getBlockCalls).toBe(readsWhenBlocked);
    expect(store.incrementCalls).toBe(incrementsWhenBlocked);
  });

  it('a cold container learns a block from the table rather than starting fresh', async () => {
    // The other half of the cache being a cache: Lambda replaces containers,
    // and a block that only lived in memory would be a block a redeploy lifts.
    const warm = limiterAt(WINDOW_START);
    await checkTimes(warm.limiter, IP, MAX_LIMITED_REQUESTS_PER_WINDOW + 1);

    const cold = new IpLimiter({
      abuse: warm.store,
      nowEpochSeconds: () => WINDOW_START + 100,
    });

    expect(await cold.check(IP)).toEqual({
      allowed: false,
      retryAfterSeconds: BLOCK_SECONDS - 100,
    });
  });

  it('lets an address back in once its block has run out', async () => {
    const { limiter, setNow } = limiterAt(WINDOW_START);
    await checkTimes(limiter, IP, MAX_LIMITED_REQUESTS_PER_WINDOW + 1);

    setNow(WINDOW_START + BLOCK_SECONDS + 1);

    expect(await limiter.check(IP)).toEqual({ allowed: true });
  });

  it('counts each address separately, so one abuser does not refuse everyone else', async () => {
    // The property the gateway throttle cannot give us: it treats all callers
    // as one queue, which is why this layer exists at all (ADR 0006).
    const { limiter } = limiterAt(WINDOW_START);
    await checkTimes(limiter, IP, MAX_LIMITED_REQUESTS_PER_WINDOW + 1);

    expect(await limiter.check(OTHER_IP)).toEqual({ allowed: true });
  });

  it('fixed windows admit up to twice the limit across a boundary — accepted, not a bug', async () => {
    // Documented in `ip-limiter.ts` and in ADR 0006: 30 at the end of one
    // window and 30 at the start of the next are two full windows and neither
    // trips. This test exists so the tolerance is a stated property rather than
    // a surprise, and so tightening it later is a visible change here.
    const { limiter, setNow } = limiterAt(WINDOW_START + RATE_WINDOW_SECONDS - 1);
    const before = await checkTimes(limiter, IP, MAX_LIMITED_REQUESTS_PER_WINDOW);

    setNow(WINDOW_START + RATE_WINDOW_SECONDS);
    const after = await checkTimes(limiter, IP, MAX_LIMITED_REQUESTS_PER_WINDOW);

    expect([...before, ...after].every((decision) => decision.allowed)).toBe(true);
  });

  it('fails closed: a storage failure propagates instead of admitting the request', async () => {
    // Deliberate (ADR 0006): fail-open would let whatever is already breaking
    // DynamoDB switch the abuse protection off, at the moment it is most wanted.
    const limiter = new IpLimiter({
      abuse: new FailingAbuseStore(),
      nowEpochSeconds: () => WINDOW_START,
    });

    await expect(limiter.check(IP)).rejects.toThrow('cumulo-abuse');
  });

  it('never asks a client to retry in zero seconds, even if the clocks disagree', async () => {
    // `retry-after: 0` reads as "retry now", straight back into the block that
    // just refused — and `rateLimitedResponse` throws on a non-positive value,
    // so a limiter that produced one would 500 rather than 429.
    const store = new FakeAbuseStore(() => WINDOW_START);
    await store.putBlock(IP, WINDOW_START + 1);
    const limiter = new IpLimiter({ abuse: store, nowEpochSeconds: () => WINDOW_START + 1 });

    expect(await limiter.check(IP)).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });
});
