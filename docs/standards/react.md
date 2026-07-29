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

5. **Design tokens only.** No arbitrary colors, sizes, or spacing in components — everything comes from the design system (gated ticket; see CLAUDE.md). If a token is missing, that's a design-system issue, not a license to hardcode.

## Why

The effect-dependency hack is the canonical example of suppressing a symptom instead of fixing a cause: the lint rule is reporting a data-flow problem, and deleting the dependency converts a visible loop into a subtle stale-closure bug. The same root-cause principle applies to the whole component layer.
