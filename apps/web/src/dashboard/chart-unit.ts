/**
 * Which unit the fleet chart is drawn in, and who last decided it.
 *
 * A ~4 kW site overlaid on a ~330 kW fleet aggregate is a flat line against the
 * axis on one absolute scale, so selecting a site switches the panel to
 * percent-of-capacity, where the two curves are comparable. That switch is a
 * courtesy, not a mode the reader is locked into — which is the whole reason
 * this is a state machine rather than a boolean. Once a reader has pressed the
 * toggle themselves, the panel must stop moving under them; a machine that only
 * remembered the current unit could not tell "percent because we chose it for
 * them" from "percent because they asked", and would either strand the reader in
 * a unit they left or throw away the one they picked.
 *
 * `revertTo` is that memory, and `null` is its interesting value: it means a
 * manual toggle happened during this selection, so the reader owns the unit and
 * deselecting leaves it exactly where they put it. A non-null `revertTo` is the
 * unit the panel was showing before it took the liberty of switching, and
 * deselecting hands it back.
 *
 * Pure and React-free on purpose (`architecture.md` rule 3): the whole of the
 * semantics is a total function over two small unions and gets tested as a
 * table, while `use-chart-unit.ts` owns nothing but the wiring to a prop and an
 * event handler. It imports nothing from `charts/` either — the dependency runs
 * dashboard → charts, and the chart itself is unit-agnostic apart from its axis
 * title, its percent floor and the word its readout speaks.
 */

/**
 * The two scales the fleet chart's y-axis can carry.
 *
 * `'kw'` is the stored, transported and aggregated unit — everything below the
 * panel seam is in kW and stays there. `'percent'` is a presentation transform
 * applied at that seam, dividing by the capacity contributing to each hour.
 */
export type ChartUnit = 'kw' | 'percent';

/**
 * The unit, plus what the panel owes the reader when the selection ends.
 *
 * `idle` is the fleet on its own: there is no selection, so there is nothing to
 * hand back and the unit is simply whatever was last chosen. `selected` is a
 * selection episode, and it carries the debt: `revertTo` is the unit to restore
 * on deselect, or `null` once the reader has taken the decision back by using
 * the toggle themselves.
 */
export type ChartUnitState =
  | { readonly kind: 'idle'; readonly unit: ChartUnit }
  | {
      readonly kind: 'selected';
      readonly unit: ChartUnit;
      readonly revertTo: ChartUnit | null;
    };

/**
 * The three things that can happen to the unit.
 *
 * `selected` and `deselected` are the *edges* of a selection episode, not a
 * report of the current selection: moving from one site straight to another is
 * one continuous episode and raises neither, so the reader's unit survives a
 * site-to-site move and the panel does not re-apply its courtesy switch on a
 * selection they never left.
 */
export type ChartUnitEvent =
  | { readonly type: 'selected' }
  | { readonly type: 'deselected' }
  | { readonly type: 'toggled'; readonly unit: ChartUnit };

/**
 * Where the panel starts: no selection, absolute kW.
 *
 * kW is the fleet's own unit and the one the aggregate is legible in, so an
 * unselected panel has no reason to normalise. A module constant rather than a
 * fresh object, so re-entering it is a bail-out rather than a re-render.
 */
export const INITIAL_CHART_UNIT_STATE: ChartUnitState = { kind: 'idle', unit: 'kw' };

/**
 * The unit a selection switches to, being the only one both curves fit on.
 *
 * Named rather than inlined because it is the single claim the auto-switch
 * makes, and this declaration owns it (`architecture.md` rule 9).
 *
 * Restatement ledger — a floor, not a census; swept with
 * `command grep -rn "percent" apps/web/src/dashboard` on 2026-08-12:
 * - `chart-unit.test.ts`, the `selected`-from-`idle` and scenario expectations,
 *   which must carry the literal because asserting against this constant would
 *   assert only that the constant equals itself.
 * - `use-chart-unit.test.tsx`, same reason, for the auto-switch scenarios.
 */
const SELECTION_UNIT: ChartUnit = 'percent';

/**
 * The whole state machine: total, pure, and the only place the rules live.
 *
 * The rows, in the order the arms below take them:
 *
 * - `toggled` from `idle` — the reader's choice, and nothing is owed back.
 * - `toggled` from `selected` — the reader claims the episode. `revertTo` goes
 *   to `null` unconditionally, including when they press the unit already
 *   showing: pressing the control *is* the act that ends the panel's licence to
 *   move, and asking whether the value changed would make a reader who
 *   deliberately re-affirmed percent get moved off it later anyway.
 * - `selected` from `idle` — the courtesy switch, remembering the unit it
 *   displaced. When that unit is already percent the switch changes nothing
 *   visible and `revertTo` records percent, so deselecting is equally a no-op.
 * - `selected` from `selected` — idempotent. A site-to-site move should not
 *   reach here at all, and if it does it must not re-arm the courtesy switch
 *   over a reader's manual choice.
 * - `deselected` from `selected` — settle the debt: back to `revertTo`, or stay
 *   put where the reader claimed the episode.
 * - `deselected` from `idle` — idempotent; there was no episode to end.
 *
 * Both idempotent arms return the *same object*, so React bails out of
 * re-rendering rather than committing an identical state.
 */
export const chartUnitTransition = (
  state: ChartUnitState,
  event: ChartUnitEvent,
): ChartUnitState => {
  switch (event.type) {
    case 'toggled':
      return state.kind === 'idle'
        ? { kind: 'idle', unit: event.unit }
        : { kind: 'selected', unit: event.unit, revertTo: null };
    case 'selected':
      return state.kind === 'selected'
        ? state
        : { kind: 'selected', unit: SELECTION_UNIT, revertTo: state.unit };
    case 'deselected':
      return state.kind === 'idle' ? state : { kind: 'idle', unit: state.revertTo ?? state.unit };
  }
  // Every event type is enumerated and every arm returns, so a fourth event
  // becomes a compile error here rather than falling silently through to an
  // unchanged state — the failure mode that would look like a dead control.
};
