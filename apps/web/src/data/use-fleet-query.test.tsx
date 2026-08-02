// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { FleetSourceResult } from './fleet-data-source';
import { useFleetQuery } from './use-fleet-query';

// Vitest runs without global test hooks, so Testing Library's automatic cleanup never registers
// itself — every rendered hook has to be torn down explicitly.
afterEach(() => {
  cleanup();
});

type StringResult = FleetSourceResult<string>;

const ready = (value: string): StringResult => ({ kind: 'ok', value });

/** A promise whose resolution the test drives, so "slow" and "fast" are exact, not timing-based. */
interface Deferred {
  readonly promise: Promise<StringResult>;
  readonly settle: (result: StringResult) => Promise<void>;
}

const deferred = (): Deferred => {
  let resolvePromise: (result: StringResult) => void = () => undefined;
  const promise = new Promise<StringResult>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    settle: async (result) => {
      await act(async () => {
        resolvePromise(result);
        await promise;
      });
    },
  };
};

/** `renderHook` props, named so both the initial render and every rerender share one contract. */
interface QueryProps {
  readonly query: () => Promise<StringResult>;
  readonly key: readonly unknown[];
  /** Omitted where the test is about the default arm, which must behave as it always has. */
  readonly enabled?: boolean;
}

/**
 * Omitting `enabled` calls the hook with two arguments — the form `SitePanel` uses — so the
 * parameter defaults are genuinely exercised rather than papered over by the helper. Passing
 * `{ enabled: props.enabled ?? true }` unconditionally would mean no test ever reached them, and
 * a signature default flipped to `false` would survive the whole file.
 *
 * Both arms call the one hook exactly once, so the hook order is identical either way.
 */
const renderQuery = (initialProps: QueryProps) =>
  renderHook(
    (props: QueryProps) =>
      props.enabled === undefined
        ? useFleetQuery(props.query, props.key)
        : useFleetQuery(props.query, props.key, { enabled: props.enabled }),
    { initialProps },
  );

/**
 * Lets any already-scheduled effect and microtask run, so "nothing happened" is a settled fact
 * rather than a claim made before the work would have started anyway.
 */
const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
  });
};

/** Wraps a query fn so a test can assert on how many requests were actually spent. */
const counted = (
  answer: () => Promise<StringResult>,
): { readonly query: () => Promise<StringResult>; readonly callCount: () => number } => {
  let calls = 0;
  return {
    query: () => {
      calls += 1;
      return answer();
    },
    callCount: () => calls,
  };
};

describe('useFleetQuery', () => {
  it('reports loading until the source answers, then the data', async () => {
    const first = deferred();
    const { result } = renderQuery({ query: () => first.promise, key: ['sites'] });

    expect(result.current).toEqual({ status: 'loading' });

    await first.settle(ready('sites'));

    expect(result.current).toEqual({ status: 'ready', data: 'sites' });
  });

  it('surfaces an error result as a failed state rather than throwing', async () => {
    const error = { code: 'network', message: 'siteForecasts: boom' } as const;
    const { result } = renderQuery({
      query: () => Promise.resolve<StringResult>({ kind: 'error', error }),
      key: ['forecasts'],
    });

    await waitFor(() => {
      expect(result.current).toEqual({ status: 'failed', error });
    });
  });

  it('carries the error code through, so a view could branch on it', async () => {
    const error = { code: 'rate-limited', message: 'not now', retryAfterSeconds: 30 } as const;
    const { result } = renderQuery({
      query: () => Promise.resolve<StringResult>({ kind: 'error', error }),
      key: ['forecasts'],
    });

    await waitFor(() => {
      expect(result.current.status).toBe('failed');
    });
    expect(result.current.status === 'failed' && result.current.error.code).toBe('rate-limited');
    expect(
      result.current.status === 'failed' &&
        result.current.error.code === 'rate-limited' &&
        result.current.error.retryAfterSeconds,
    ).toBe(30);
  });

  it('refetches when the key changes', async () => {
    const first = deferred();
    const second = deferred();
    const { result, rerender } = renderQuery({ query: () => first.promise, key: ['site-a'] });
    await first.settle(ready('site-a data'));

    rerender({ query: () => second.promise, key: ['site-b'] });

    expect(result.current).toEqual({ status: 'loading' });

    await second.settle(ready('site-b data'));

    expect(result.current).toEqual({ status: 'ready', data: 'site-b data' });
  });

  it('does not refetch when the key is rebuilt with equal values', async () => {
    const first = deferred();
    const unreachable = (): Promise<StringResult> => {
      throw new Error('a re-render with an equal key must not refetch');
    };
    const { result, rerender } = renderQuery({ query: () => first.promise, key: ['site-a', 24] });
    await first.settle(ready('site-a data'));

    rerender({ query: unreachable, key: ['site-a', 24] });

    expect(result.current).toEqual({ status: 'ready', data: 'site-a data' });
  });

  it('discards a superseded response that resolves after its replacement', async () => {
    const slowFirst = deferred();
    const fastSecond = deferred();
    const { result, rerender } = renderQuery({ query: () => slowFirst.promise, key: ['site-a'] });

    rerender({ query: () => fastSecond.promise, key: ['site-b'] });
    await fastSecond.settle(ready('site-b data'));

    expect(result.current).toEqual({ status: 'ready', data: 'site-b data' });

    await slowFirst.settle(ready('site-a data'));

    expect(result.current).toEqual({ status: 'ready', data: 'site-b data' });
  });

  it('starts nothing while disabled', async () => {
    const source = counted(() => Promise.resolve(ready('never asked for')));
    const { result, rerender } = renderQuery({
      query: source.query,
      key: ['site-a'],
      enabled: false,
    });

    rerender({ query: source.query, key: ['site-b'], enabled: false });
    await flush();

    expect(source.callCount()).toBe(0);
    expect(result.current).toEqual({ status: 'loading' });
  });

  it('fires for the current key when enabled flips true', async () => {
    const answer = deferred();
    const source = counted(() => answer.promise);
    const { result, rerender } = renderQuery({
      query: source.query,
      key: ['site-a'],
      enabled: false,
    });

    rerender({ query: source.query, key: ['site-a'], enabled: true });

    expect(source.callCount()).toBe(1);

    await answer.settle(ready('site-a data'));

    expect(result.current).toEqual({ status: 'ready', data: 'site-a data' });
  });

  it('keeps its settled answer when disabled afterwards', async () => {
    const answer = deferred();
    const source = counted(() => answer.promise);
    const { result, rerender } = renderQuery({ query: source.query, key: ['site-a'] });
    await answer.settle(ready('site-a data'));

    rerender({ query: source.query, key: ['site-a'], enabled: false });
    await flush();

    expect(result.current).toEqual({ status: 'ready', data: 'site-a data' });
    expect(source.callCount()).toBe(1);
  });
});
