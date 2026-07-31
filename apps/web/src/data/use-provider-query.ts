import { useEffect, useRef, useState } from 'react';

import type { DataResult } from './provider';

/**
 * The view-facing state of one provider call.
 *
 * A discriminated union rather than an optional-field bag (`docs/standards/typing.md` rule 4):
 * "loading with stale data" and "failed but also ready" are not states this app has, so they are
 * not representable, and a view that forgets a case fails to compile.
 */
export type QueryState<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly data: T }
  | { readonly status: 'failed'; readonly error: string };

/**
 * One shared `loading` value, so re-running the effect for a new key sets a state React can
 * identify as unchanged instead of forcing a render.
 *
 * `QueryState<never>` is assignable to `QueryState<T>` for every `T` — the union is covariant in
 * its data — so this needs no assertion.
 */
const LOADING: QueryState<never> = { status: 'loading' };

/**
 * Run `query` whenever `key` changes, and report the outcome as a {@link QueryState}.
 *
 * The deliberate v1 stopgap standing in for a server-state library (`docs/standards/react.md`
 * rule 3 defers that choice): no cache, no deduplication, no retry — one in-flight request whose
 * result is dropped if a newer key supersedes it, so a slow response cannot overwrite a fast one
 * that came after it.
 *
 * `key` is what the effect actually depends on; `query` is held in a ref updated during render
 * (`react.md` rule 2's ref pattern), because a caller passing an inline closure would otherwise
 * refetch on every render. The consequence is the caller's contract: **`key` must name every
 * input `query` reads.**
 *
 * A rejected promise is not handled here. `FleetDataProvider` returns expected failures as
 * `failed` results, so a rejection is a bug in the provider and propagates to the boundary
 * (`docs/standards/error-handling.md` rule 1) rather than being caught and disguised as a
 * user-facing error.
 */
export const useProviderQuery = <T>(
  query: () => Promise<DataResult<T>>,
  key: readonly unknown[],
): QueryState<T> => {
  const [state, setState] = useState<QueryState<T>>(LOADING);

  const queryRef = useRef(query);
  queryRef.current = query;

  // Serialized so the effect compares keys by value: callers build the array inline every render.
  const keyToken = JSON.stringify(key);

  useEffect(() => {
    let superseded = false;
    setState(LOADING);

    void queryRef.current().then((result) => {
      if (!superseded) {
        setState(result);
      }
    });

    return () => {
      superseded = true;
    };
  }, [keyToken]);

  return state;
};
