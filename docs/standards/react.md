# React standards

**Trigger:** writing or modifying a React component, hook, or anything involving `useEffect`.

## Rules

1. **Effects synchronize with external systems — nothing else.** Subscriptions, imperative map/chart APIs, timers. Not derived state (compute it during render), not responding to user actions (that's an event handler), not "run this when X changes" choreography (restructure so the data flows down).

2. **`react-hooks/exhaustive-deps` is an error, and the dependency array is never the knob.** If honest dependencies cause an infinite loop or unwanted re-runs, the _structure_ is wrong. The fixes, in order of preference:
   - Derived value? Compute during render; `useMemo` only if measured as expensive.
   - Responding to an interaction? Move the logic into the event handler.
   - Need the latest value inside an effect/callback _without_ re-triggering it? Store it in a ref, updated on render:

     ```ts
     const onSettledRef = useRef(onSettled);
     onSettledRef.current = onSettled;
     useEffect(() => {
       const sub = stream.subscribe((v) => onSettledRef.current(v));
       return () => sub.unsubscribe();
     }, [stream]); // honest deps — callback changes don't resubscribe
     ```

   - Unstable object/function dep? Stabilize it at its source (`useCallback`/`useMemo` there, or move it out of the component), don't omit it here.

3. **Colocate state; lift it only when two components genuinely share it.** Server data is not component state — it belongs to the data-fetching layer (query library, decided when `apps/web` lands), with loading/error modes encoded as a discriminated union (see `typing.md` rule 4).

4. **Components are presentational by default.** Data fetching and domain logic live in hooks/modules; a component that's hard to render in isolation (Storybook-style) is structured wrong.

5. **Design tokens only — lint-enforced, not a convention.** `no-restricted-syntax` in `eslint.config.mjs` and `stylelint.config.mjs` are the rule; read them for the exact scope rather than trusting a paraphrase here. Both run under `pnpm lint`, `packages/ui/src/tokens/tokens.css` is the one exempt file, and disable comments are themselves errors in both linters. So: if a token is missing, the lint error _is_ the design signal — raise it as a design-system issue rather than reaching for a literal.

## Async surface convention (apps/web)

Every panel that waits on data says so the same way. The three states are implemented once in `apps/web/src/dashboard/panel-states.tsx` (`PanelPending`, `PanelEmpty`, `PanelError`) and their wording lives in `apps/web/src/dashboard/state-copy.ts` — reach for those rather than writing a fourth spelling of "loading…".

- **Pending** is a visible label inside an `aria-busy="true"` container — never a live region mounted with its text already in it. A `role="status"` that exists only while it is full has no change to report, so it announces nothing and merely looks accessible (#161).
- **Failed** is `role="alert"` with a message in the panel's own words, plus a retry **only when retrying can work**. These components mount into a tree that is already on screen, so the alert really is a change and really is announced. A retry that re-runs an identical metered request is not a recourse — omit it and let the reader's own controls be the retry.
- **Empty** is plain content, no live semantics, stating the next action where there is one. An empty fleet is a successful answer, not an event.
- **At most one live region per panel.** Announcements compete; two regions in one column means the reader hears whichever won.
- **Completion is not announced.** The arrival of data is the busy container being replaced by the content — that is the signal, and adding a "loaded" announcement on top of it says the same thing twice.
- **A live region never renders inside a `hidden`/`display: none` subtree** — a hidden panel renders its states only once it is revealed, so a failure mounts as a change rather than as an attribute flip nothing announces (`FleetPanel`).
- **A message mounted in response to something the reader did is `role="alert"`** — the add-site refusal arrives because a button was pressed, so it really is a change to a tree already on screen.
- **First paint mounts zero live regions** — pending is `aria-busy` and alerts arrive only as changes, pinned by `Dashboard.test.tsx`'s "first paint mounts zero live regions".
- **An unhandled promise rejection lands at `AppErrorBoundary`**, which gives the rejection nobody awaited the same labelled failure a render throw gets rather than a silent hang.

The map shell composes `MapSurface` (`apps/web/src/map/MapSurface.tsx`) — one column behind the live canvas, the loading placeholder and the load failure — and its placeholder is the same `aria-busy` pending treatment, not a fourth spelling of it.

**Focus follows the context region.** An occupant taking the region focuses its own heading, made focusable with `tabIndex={-1}` and kept out of the tab order — on a marker click, on a creation, and on a deep-link arrival alike, because a region that changes above the reader's focus point is otherwise reachable only by tabbing to it. `Close` hands focus to the closing site's row in the list, rather than letting the button it unmounts drop focus on `body`. A draft cancelled with nothing selected behind it focuses the context region itself: nothing remounts on that path, so the region is the only honest target left. `Dashboard.focus.test.tsx` holds these.

## Why

The effect-dependency hack is the canonical example of suppressing a symptom instead of fixing a cause: the lint rule is reporting a data-flow problem, and deleting the dependency converts a visible loop into a subtle stale-closure bug. The same root-cause principle applies to the whole component layer.
