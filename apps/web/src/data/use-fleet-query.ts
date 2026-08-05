import { useEffect, useRef, useState } from 'react';

import type { FleetDataError, FleetSourceResult } from './fleet-data-source';

/**
 * The view-facing state of one fleet call.
 *
 * A discriminated union rather than an optional-field bag (`docs/standards/typing.md` rule 4):
 * "loading with stale data" and "failed but also ready" are not states this app has, so they are
 * not representable, and a view that forgets a case fails to compile.
 *
 * The failed arm carries the source's own {@link FleetDataError} rather than a flattened message,
 * so a view that wants to say something different about a rate limit than about a broken payload
 * still can. Today's views render only `error.message`; the code is there for the day one of them
 * offers a retry.
 */
export type QueryState<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly data: T }
  | { readonly status: 'failed'; readonly error: FleetDataError };

/**
 * One shared `loading` value, so re-running the effect for a new key sets a state React can
 * identify as unchanged instead of forcing a render.
 *
 * `QueryState<never>` is assignable to `QueryState<T>` for every `T` — the union is covariant in
 * its data — so this needs no assertion.
 */
const LOADING: QueryState<never> = { status: 'loading' };

/** Caller-facing knobs for {@link useFleetQuery}. Optional as a whole — omitting it fetches. */
export interface FleetQueryOptions {
  /**
   * Whether this query is allowed to spend a request. Defaults to `true`.
   *
   * A caller sets it to `false` while the answer is not worth paying for yet. `FleetPanel` is the
   * only shipped caller and gates all three of its queries: the fleet's sum on there being a fleet
   * to sum, and the selected site's overlay on that site having a first forecast at all — asking a
   * minutes-old site for its window would spend metered requests to be told what the dashboard's
   * poll is already asking. (It gated on a reveal latch until #265, which is where the "#178"
   * this used to cite went.)
   *
   * It gates the *request*, never the hook: `useFleetQuery` is still called unconditionally on
   * every render (`docs/standards/react.md` — `enabled` is a value, not a conditional hook).
   */
  readonly enabled?: boolean;
}

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
 * A rejected promise is not handled here. `FleetDataSource` returns expected failures as
 * `error` results, so a rejection is a bug in the source and propagates to the boundary
 * (`docs/standards/error-handling.md` rule 1) rather than being caught and disguised as a
 * user-facing error.
 *
 * While `enabled` is false, no request starts and the state is not touched. So: a query never
 * enabled reports its initial `loading`; key changes while disabled start nothing; flipping
 * false→true fires the query for the key current at that moment; and flipping true→false after a
 * result has landed starts nothing and **keeps** that result, because the disabled run returns
 * before the `loading` reset rather than after it.
 *
 * Disabling while a request is still in flight is the one lossy case: the response is discarded
 * as superseded and the state stays `loading` until the key or `enabled` changes again. A shipped
 * caller reaches it now — `FleetPanel`'s overlay ties `enabled` to a live condition (the selected
 * site having a first forecast), which goes true→false whenever a reader deselects or moves to a
 * site whose forecast has not arrived, and can do so with the previous site's request still out.
 *
 * That is survivable *there* and only because of how that caller reads the result: it draws an
 * overlay only from a `ready` state, so a stranded `loading` renders nothing rather than a spinner
 * nobody can clear, and the very condition that stranded it is the one that means "no overlay".
 * The state is also not stranded for long: the site is part of that query's key, so returning to
 * it is a key change and re-fires. A caller that would *show* the wait owns that spinner, and
 * should key off the condition instead of gating on it.
 */
export const useFleetQuery = <T>(
  query: () => Promise<FleetSourceResult<T>>,
  key: readonly unknown[],
  { enabled = true }: FleetQueryOptions = {},
): QueryState<T> => {
  const [state, setState] = useState<QueryState<T>>(LOADING);

  const queryRef = useRef(query);
  queryRef.current = query;

  // Serialized so the effect compares keys by value: callers build the array inline every render.
  const keyToken = JSON.stringify(key);

  useEffect(() => {
    // Before the `loading` reset, deliberately: a caller that disables a settled query keeps its
    // answer, rather than watching it revert to a `loading` that nothing will ever resolve.
    if (!enabled) {
      return;
    }

    let superseded = false;
    setState(LOADING);

    void queryRef.current().then((result) => {
      if (!superseded) {
        // The source's result shape and the view's state are deliberately not the same type: a
        // view has a `loading` the source never returns, and the translation is one line here
        // rather than a shape both layers have to keep agreeing about.
        setState(
          result.kind === 'ok'
            ? { status: 'ready', data: result.value }
            : { status: 'failed', error: result.error },
        );
      }
    });

    return () => {
      superseded = true;
    };
  }, [keyToken, enabled]);

  return state;
};
