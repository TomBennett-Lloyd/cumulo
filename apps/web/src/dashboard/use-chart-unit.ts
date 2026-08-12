import type { Site } from '@cumulo/shared';
import { useCallback, useState } from 'react';

import {
  chartUnitTransition,
  INITIAL_CHART_UNIT_STATE,
  type ChartUnit,
  type ChartUnitState,
} from './chart-unit';

/**
 * What the fleet panel needs to draw and drive its unit toggle.
 *
 * A named type rather than an inline shape (`typing.md` rule 6) — the panel and
 * the toggle control both conform to it, so they are visibly the same contract
 * rather than accidentally alike.
 */
export interface ChartUnitControl {
  /** The unit the chart's points, axis title and readout are all in right now. */
  readonly unit: ChartUnit;
  /** What the toggle calls when the reader picks a unit themselves. */
  readonly onToggle: (unit: ChartUnit) => void;
}

/**
 * Drives `chart-unit.ts` from the dashboard's selection and the panel's toggle.
 *
 * `selectedSiteId` is the site whose overlay is on the chart, `null` for the
 * fleet on its own. The hook watches the *edges* of that prop rather than its
 * value: only the transitions in and out of "something is selected" raise
 * events, so a move from one site to another is one continuous episode — no
 * second courtesy switch, and a reader's manual choice survives it. That is
 * what makes the id itself uninteresting here, and why nothing but its nullity
 * is read.
 *
 * **No `useEffect`** (`react.md` rule 1). "Switch the unit when the selection
 * changes" is exactly the choreography that rule refuses: an effect would paint
 * the old unit first and correct it a frame later, and the dependency array
 * would become the place the rules quietly lived. This is React's documented
 * adjust-state-on-prop-change instead — compare the prop against the last value
 * this hook acted on, and if they differ, set state *during render*. React
 * discards the in-progress output and re-runs the component immediately, before
 * anything is committed or painted, so the reader only ever sees the settled
 * unit. The loop terminates because the same render that dispatches also stores
 * the new boolean, so the next pass finds them equal.
 *
 * `wasSelecting` seeds to `false` rather than to the prop, so a selection that
 * is already present on the first render — a `?site=` deep link, whose card
 * mounts whenever the fleet listing resolves — gets the same courtesy switch a
 * pressed marker gets. Seeding it from the prop would leave the machine `idle`
 * while a site was on the chart, and the eventual deselect would then be a
 * no-op against a state that never opened an episode.
 */
export const useChartUnit = (selectedSiteId: Site['id'] | null): ChartUnitControl => {
  const [state, setState] = useState<ChartUnitState>(INITIAL_CHART_UNIT_STATE);
  /**
   * Whether anything was selected the last time this hook raised an event.
   *
   * The boolean and not the id: the id is what changes on a site-to-site move,
   * and storing it would make that move look like the end of one episode and
   * the start of another.
   */
  const [wasSelecting, setWasSelecting] = useState(false);

  const isSelecting = selectedSiteId !== null;
  /**
   * The adjustment this render owes, or `null` when the prop has not moved.
   *
   * Held as a value rather than applied and re-read, because `state` still
   * holds the pre-event machine for the rest of this pass — returning it would
   * report the unit the reader is about to stop seeing.
   */
  const adjustment =
    isSelecting === wasSelecting
      ? null
      : chartUnitTransition(state, { type: isSelecting ? 'selected' : 'deselected' });

  if (adjustment !== null) {
    // Guarded on the boolean rather than on the adjustment differing from
    // `state`: the idempotent arms return the same object, and keying the
    // bookkeeping off identity would leave `wasSelecting` behind on the day one
    // of those arms is reached.
    setWasSelecting(isSelecting);
    setState(adjustment);
  }

  const onToggle = useCallback((unit: ChartUnit) => {
    // The reader's own act, so it belongs in the event handler (`react.md`
    // rule 1). The functional form reads the committed machine, which is the
    // one any render-time adjustment has already settled into.
    setState((previous) => chartUnitTransition(previous, { type: 'toggled', unit }));
  }, []);

  return { unit: (adjustment ?? state).unit, onToggle };
};
