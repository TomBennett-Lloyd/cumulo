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

Every surface that waits on data says so the same way — panels, the map region, the app boundary and the add-site form alike. The three states are implemented once in `apps/web/src/dashboard/panel-states.tsx` (`PanelPending`, `PanelEmpty`, `PanelError`), and the app's async-state and failure wording lives in `apps/web/src/dashboard/state-copy.ts` — reach for those rather than writing a fourth spelling of "loading…". Chart _chrome_ wording (the words a chart says about itself, like its clock) has its own owner, `apps/web/src/charts/chart-copy.ts`, a deliberate sibling. `apps/web/src/dashboard/state-copy-contract.test.ts` sweeps the app for phrase classes that drift back inline, so an inlined pending label or failure sentence fails a gate, not just a review.

- **Pending** is a visible label inside an `aria-busy="true"` container — never a live region mounted with its text already in it. A `role="status"` that exists only while it is full has no change to report, so it announces nothing and merely looks accessible (#161).
- **Failed** is `role="alert"` with a message in the panel's own words, plus a retry **only when retrying can work**. These components mount into a tree that is already on screen, so the alert really is a change and really is announced. A retry that re-runs an identical metered request is not a recourse — omit it and let the reader's own controls be the retry.
- **Empty** is plain content, no live semantics, stating the next action where there is one. An empty fleet is a successful answer, not an event.
- **At most one live region per panel.** Announcements compete; two regions in one panel means the reader hears whichever won. In a panel showing a chart, that one region is the chart's own readout (`.forecast-chart-readout`, `docs/design/chart-treatment.md`) — mounted empty with the chart and filled only when a reader moves the selection, so the panel spends its single budget on the sample the reader asked for.
- **Completion is not announced.** The arrival of data is the busy container being replaced by the content — that is the signal, and adding a "loaded" announcement on top of it says the same thing twice.
- **A live region never renders inside a `hidden`/`display: none` subtree** — it was never on screen, so the later reveal is an attribute change rather than a DOM change and assistive technology reports nothing at either moment (#161). A panel that can be hidden therefore renders its states only once it is revealed. `apps/web` has no such panel today: the fleet panel was the motivating one and stopped being hidden when the reading stopped swapping (#265), which is a reason the rule is easy to reintroduce unnoticed rather than a reason to drop it.
- **A message mounted in response to something the reader did is `role="alert"`** — the add-site refusal arrives because a button was pressed, so it really is a change to a tree already on screen.
- **First paint mounts zero live regions** — pending is `aria-busy` and alerts arrive only as changes, pinned by `Dashboard.test.tsx`'s "first paint mounts zero live regions".
- **An unhandled promise rejection lands at `AppErrorBoundary`**, which gives the rejection nobody awaited the same labelled failure a render throw gets rather than a silent hang.

The map shell composes `MapSurface` (`apps/web/src/map/MapSurface.tsx`) — one column behind the live canvas, the loading placeholder and the load failure — and its placeholder is the same `aria-busy` pending treatment, not a fourth spelling of it.

**Focus follows the reader, never the address bar.** A surface that opens because somebody pressed something focuses its own heading, made focusable with `tabIndex={-1}` and kept out of the tab order — a marker press, a row press, a search hit and a creation all qualify, and so does whatever opener is added next, because the test is that the page changed in answer to an action and a reader who kept their focus on the control they pressed would reach the new surface only by tabbing to it. A surface that opens because the URL said so focuses **nothing**. That asymmetry is the settled answer to [#260](https://github.com/TomBennett-Lloyd/cumulo/issues/260), and it is not a special case for page load: the selected site's card mounts when the fleet listing resolves, which on a `?site=` link can be seconds in, so a move there takes focus from somebody who did nothing to ask for it (WCAG 3.2.5). `Dashboard` carries the distinction beside the selection itself (`dashboard/selection-origin.ts`) rather than letting each surface guess.

**A surface that leaves owes a landing, and it owes it to whoever it took the focus from.** The site card captures `document.activeElement` as it opens and restores it on unmount, so a marker press lands back on the marker and a row press back on the row without the dashboard knowing which happened; a card that never took the focus returns none. The capture happens inside the mount effect, after React has flushed the commit's unmount cleanups, which is what puts a newly created site's landing on the map's add-site control rather than on a submit button that has already left the document. An opener no longer in the document is not chased.

**A modal owes its own landing, because the platform stops paying it.** The add-site draft is a `<dialog>` over the page and closes by being unmounted — a removed dialog never runs the close steps, so the browser's usual focus restoration never happens. It returns focus to the map control that opened it, from the dialog's effect cleanup rather than its `cancel` handler: on the Escape path the browser is still restoring focus while `cancel` is dispatched, and would overwrite a focus set there.

`Dashboard.focus.test.tsx` and `map/SitePopoverCard.test.tsx` hold all of this as far as `document.activeElement` goes; the ring a reader actually sees, and the deep link arriving over a real network, are `e2e/keyboard-focus.spec.ts`'s.

## Why

The effect-dependency hack is the canonical example of suppressing a symptom instead of fixing a cause: the lint rule is reporting a data-flow problem, and deleting the dependency converts a visible loop into a subtle stale-closure bug. The same root-cause principle applies to the whole component layer.
