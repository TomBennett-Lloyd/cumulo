// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { DataResult } from './provider';
import { useProviderQuery } from './use-provider-query';

// Vitest runs without global test hooks, so Testing Library's automatic cleanup never registers
// itself — every rendered hook has to be torn down explicitly.
afterEach(() => {
  cleanup();
});

type StringResult = DataResult<string>;

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
}

const renderQuery = (initialProps: QueryProps) =>
  renderHook((props: QueryProps) => useProviderQuery(props.query, props.key), { initialProps });

describe('useProviderQuery', () => {
  it('reports loading until the provider answers, then the data', async () => {
    const first = deferred();
    const { result } = renderQuery({ query: () => first.promise, key: ['sites'] });

    expect(result.current).toEqual({ status: 'loading' });

    await first.settle({ status: 'ready', data: 'sites' });

    expect(result.current).toEqual({ status: 'ready', data: 'sites' });
  });

  it('surfaces a failed result as a failed state rather than throwing', async () => {
    const { result } = renderQuery({
      query: () => Promise.resolve({ status: 'failed', error: 'siteForecasts: boom' }),
      key: ['forecasts'],
    });

    await waitFor(() => {
      expect(result.current).toEqual({ status: 'failed', error: 'siteForecasts: boom' });
    });
  });

  it('refetches when the key changes', async () => {
    const first = deferred();
    const second = deferred();
    const { result, rerender } = renderQuery({ query: () => first.promise, key: ['site-a'] });
    await first.settle({ status: 'ready', data: 'site-a data' });

    rerender({ query: () => second.promise, key: ['site-b'] });

    expect(result.current).toEqual({ status: 'loading' });

    await second.settle({ status: 'ready', data: 'site-b data' });

    expect(result.current).toEqual({ status: 'ready', data: 'site-b data' });
  });

  it('does not refetch when the key is rebuilt with equal values', async () => {
    const first = deferred();
    const unreachable = (): Promise<StringResult> => {
      throw new Error('a re-render with an equal key must not refetch');
    };
    const { result, rerender } = renderQuery({ query: () => first.promise, key: ['site-a', 24] });
    await first.settle({ status: 'ready', data: 'site-a data' });

    rerender({ query: unreachable, key: ['site-a', 24] });

    expect(result.current).toEqual({ status: 'ready', data: 'site-a data' });
  });

  it('discards a superseded response that resolves after its replacement', async () => {
    const slowFirst = deferred();
    const fastSecond = deferred();
    const { result, rerender } = renderQuery({ query: () => slowFirst.promise, key: ['site-a'] });

    rerender({ query: () => fastSecond.promise, key: ['site-b'] });
    await fastSecond.settle({ status: 'ready', data: 'site-b data' });

    expect(result.current).toEqual({ status: 'ready', data: 'site-b data' });

    await slowFirst.settle({ status: 'ready', data: 'site-a data' });

    expect(result.current).toEqual({ status: 'ready', data: 'site-b data' });
  });
});
