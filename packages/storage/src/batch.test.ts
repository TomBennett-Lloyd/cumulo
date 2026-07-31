import { describe, expect, it } from 'vitest';

import {
  MAX_BACKOFF_DELAY_MS,
  defaultBatchPolicy,
  drainBatches,
  fullJitterDelayMs,
  type BatchPolicy,
} from './batch';

/** A `send` that accepts everything, recording the batches it was handed. */
function acceptingSend(record: string[][]): (batch: string[]) => Promise<string[]> {
  return (batch) => {
    record.push([...batch]);
    return Promise.resolve([]);
  };
}

/** A `send` that never accepts anything, recording every attempt. */
function refusingSend(record: string[][]): (batch: string[]) => Promise<string[]> {
  return (batch) => {
    record.push([...batch]);
    return Promise.resolve([...batch]);
  };
}

function recordingSleep(delays: number[]): (ms: number) => Promise<void> {
  return (ms) => {
    delays.push(ms);
    return Promise.resolve();
  };
}

function requests(count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `req-${String(index)}`);
}

describe('fullJitterDelayMs', () => {
  const nearlyOne = () => 0.999_999;

  it('caps the first retry at exactly the delay base', () => {
    expect(fullJitterDelayMs(1, { baseDelayMs: 1000, maxDelayMs: 20_000, random: nearlyOne })).toBe(
      999,
    );
  });

  it('doubles the window on each subsequent retry', () => {
    const spec = { baseDelayMs: 1000, maxDelayMs: 20_000, random: nearlyOne };
    expect(fullJitterDelayMs(2, spec)).toBe(1999);
    expect(fullJitterDelayMs(3, spec)).toBe(3999);
    expect(fullJitterDelayMs(4, spec)).toBe(7999);
  });

  it('stops growing at the maximum delay', () => {
    const spec = { baseDelayMs: 1000, maxDelayMs: 20_000, random: nearlyOne };
    expect(fullJitterDelayMs(5, spec)).toBe(15_999);
    expect(fullJitterDelayMs(6, spec)).toBe(19_999);
    expect(fullJitterDelayMs(30, spec)).toBe(19_999);
  });

  it('is full jitter, not equal jitter: the low end of the window is zero', () => {
    expect(fullJitterDelayMs(4, { baseDelayMs: 1000, maxDelayMs: 20_000, random: () => 0 })).toBe(
      0,
    );
  });

  it('stays inside its window with the production random source', () => {
    // No injected randomness here: the shipped default has to hold too.
    for (let retryAttempt = 1; retryAttempt <= 8; retryAttempt += 1) {
      const cap = Math.min(200 * 2 ** (retryAttempt - 1), MAX_BACKOFF_DELAY_MS);
      for (let sample = 0; sample < 50; sample += 1) {
        const delay = fullJitterDelayMs(retryAttempt, {
          baseDelayMs: 200,
          maxDelayMs: MAX_BACKOFF_DELAY_MS,
        });
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThan(cap);
      }
    }
  });

  it('rejects a retry attempt that is not a positive integer', () => {
    const spec = { baseDelayMs: 1000, maxDelayMs: 20_000 };
    expect(() => fullJitterDelayMs(0, spec)).toThrow(/positive integer/);
    expect(() => fullJitterDelayMs(-1, spec)).toThrow(/positive integer/);
    expect(() => fullJitterDelayMs(1.5, spec)).toThrow(/positive integer/);
  });
});

describe('drainBatches', () => {
  const instantPolicy: BatchPolicy = {
    maxAttempts: 3,
    baseDelayMs: 200,
    sleep: () => Promise.resolve(),
  };

  it('sends nothing at all for an empty request list', async () => {
    const sent: string[][] = [];
    const outcome = await drainBatches(acceptingSend(sent), [], 25, instantPolicy);

    expect(outcome).toEqual({ status: 'complete' });
    expect(sent).toEqual([]);
  });

  it('splits 60 requests into three batches of at most 25', async () => {
    const sent: string[][] = [];
    const outcome = await drainBatches(acceptingSend(sent), requests(60), 25, instantPolicy);

    expect(outcome).toEqual({ status: 'complete' });
    expect(sent.map((batch) => batch.length)).toEqual([25, 25, 10]);
    expect(sent.flat()).toEqual(requests(60));
  });

  it('resubmits only what the previous attempt left unprocessed', async () => {
    const sent: string[][] = [];
    let call = 0;
    const send = (batch: string[]): Promise<string[]> => {
      sent.push([...batch]);
      call += 1;
      return Promise.resolve(call === 1 ? batch.slice(2) : []);
    };

    const outcome = await drainBatches(send, requests(4), 25, instantPolicy);

    expect(outcome).toEqual({ status: 'complete' });
    expect(sent).toEqual([
      ['req-0', 'req-1', 'req-2', 'req-3'],
      ['req-2', 'req-3'],
    ]);
  });

  it('reports the exact leftovers rather than a clean run when a batch never drains', async () => {
    const sent: string[][] = [];
    const outcome = await drainBatches(refusingSend(sent), requests(2), 25, instantPolicy);

    expect(outcome).toEqual({ status: 'partial', unprocessed: ['req-0', 'req-1'] });
    expect(sent).toHaveLength(instantPolicy.maxAttempts);
  });

  it('backs off between attempts within the policy window', async () => {
    const delays: number[] = [];
    const policy: BatchPolicy = { maxAttempts: 3, baseDelayMs: 200, sleep: recordingSleep(delays) };

    await drainBatches(refusingSend([]), requests(1), 25, policy);

    // One sleep per retry — never before the first send.
    expect(delays).toHaveLength(2);
    expect(delays[0]).toBeGreaterThanOrEqual(0);
    expect(delays[0]).toBeLessThan(200);
    expect(delays[1]).toBeGreaterThanOrEqual(0);
    expect(delays[1]).toBeLessThan(400);
  });

  it('keeps attempting later batches after an earlier one gives up', async () => {
    const send = (batch: string[]): Promise<string[]> =>
      Promise.resolve(batch.filter((request) => request === 'req-0'));

    const outcome = await drainBatches(send, requests(4), 2, instantPolicy);

    expect(outcome).toEqual({ status: 'partial', unprocessed: ['req-0'] });
  });

  it('lets a send rejection propagate untouched for the adapter to wrap', async () => {
    const failure = new Error('connection reset');
    const send = (): Promise<string[]> => Promise.reject(failure);

    await expect(drainBatches(send, requests(1), 25, instantPolicy)).rejects.toBe(failure);
  });

  it('refuses a batch size or attempt budget that cannot describe a real batch', async () => {
    const sent: string[][] = [];
    await expect(drainBatches(acceptingSend(sent), requests(1), 0, instantPolicy)).rejects.toThrow(
      /batchSize/,
    );
    await expect(
      drainBatches(acceptingSend(sent), requests(1), 25, { ...instantPolicy, maxAttempts: 0 }),
    ).rejects.toThrow(/maxAttempts/);
    await expect(
      drainBatches(acceptingSend(sent), requests(1), 25, { ...instantPolicy, baseDelayMs: -1 }),
    ).rejects.toThrow(/baseDelayMs/);
    expect(sent).toEqual([]);
  });

  it('honours the shipped policy — three real attempts with real timers', async () => {
    // No injected sleep and no injected attempt count: this is the configuration
    // the adapters actually run (docs/standards/testing.md rule 7).
    const sent: string[][] = [];
    const started = Date.now();
    const outcome = await drainBatches(refusingSend(sent), requests(1), 25, defaultBatchPolicy);

    expect(outcome).toEqual({ status: 'partial', unprocessed: ['req-0'] });
    expect(sent).toHaveLength(3);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
