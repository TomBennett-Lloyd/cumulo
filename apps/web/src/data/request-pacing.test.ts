import { describe, expect, it, vi } from 'vitest';

import { pacedMap } from './request-pacing';

describe('pacedMap', () => {
  it('launches at most launchesPerSecond workers before the first injected delay resolves', async () => {
    const launched: number[] = [];
    let releaseFirstDelay: (() => void) | undefined;
    const delay = (): Promise<void> =>
      new Promise<void>((resolve) => {
        releaseFirstDelay = resolve;
      });
    const worker = (item: number): Promise<number> => {
      launched.push(item);
      return Promise.resolve(item);
    };

    const pending = pacedMap([1, 2, 3, 4], worker, { launchesPerSecond: 2, delay });
    await vi.waitFor(() => {
      expect(releaseFirstDelay).toBeDefined();
    });

    // The gate is still closed: whatever has been launched is the first batch.
    expect(launched).toEqual([1, 2]);

    releaseFirstDelay?.();
    await expect(pending).resolves.toEqual([1, 2, 3, 4]);
    expect(launched).toEqual([1, 2, 3, 4]);
  });

  it('waits once per batch boundary and not at all for a single batch', async () => {
    const waits: number[] = [];
    const delay = (ms: number): Promise<void> => {
      waits.push(ms);
      return Promise.resolve();
    };

    await pacedMap([1, 2, 3], (item: number) => Promise.resolve(item), {
      launchesPerSecond: 3,
      delay,
    });
    expect(waits).toEqual([]);

    await pacedMap([1, 2, 3, 4, 5], (item: number) => Promise.resolve(item), {
      launchesPerSecond: 2,
      delay,
    });
    expect(waits).toEqual([1000, 1000]);
  });

  it('returns results in input order even when later workers settle first', async () => {
    const settleOrder: number[] = [];
    // Later items resolve sooner, so completion order is the reverse of input order.
    const worker = async (item: number): Promise<string> => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, (5 - item) * 5);
      });
      settleOrder.push(item);
      return `site-${String(item)}`;
    };

    const results = await pacedMap([1, 2, 3, 4], worker, {
      launchesPerSecond: 4,
      delay: () => Promise.resolve(),
    });

    expect(settleOrder).toEqual([4, 3, 2, 1]);
    expect(results).toEqual(['site-1', 'site-2', 'site-3', 'site-4']);
  });

  it('resolves to an empty list for an empty input without ever waiting', async () => {
    const waits: number[] = [];
    const results = await pacedMap<number, number>([], (item) => Promise.resolve(item), {
      launchesPerSecond: 8,
      delay: (ms: number) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });

    expect(results).toEqual([]);
    expect(waits).toEqual([]);
  });

  it('rejects a launchesPerSecond that would make the fan-out never advance', async () => {
    await expect(
      pacedMap([1], (item: number) => Promise.resolve(item), { launchesPerSecond: 0 }),
    ).rejects.toThrow('launchesPerSecond must be a positive integer');
  });

  it('paces with a real timer when no delay is injected', async () => {
    // The production default is the one nobody else exercises (`testing.md`
    // rule 7): every test above neuters it. One batch boundary at the real
    // wait is enough to prove the default is a wait rather than a no-op.
    vi.useFakeTimers();
    try {
      const launched: number[] = [];
      const pending = pacedMap(
        [1, 2],
        (item: number) => {
          launched.push(item);
          return Promise.resolve(item);
        },
        { launchesPerSecond: 1 },
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(launched).toEqual([1]);

      await vi.advanceTimersByTimeAsync(999);
      expect(launched).toEqual([1]);

      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual([1, 2]);
    } finally {
      vi.useRealTimers();
    }
  });
});
