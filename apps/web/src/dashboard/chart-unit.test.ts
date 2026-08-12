import { describe, expect, it } from 'vitest';

import {
  chartUnitTransition,
  INITIAL_CHART_UNIT_STATE,
  type ChartUnit,
  type ChartUnitEvent,
  type ChartUnitState,
} from './chart-unit';

/**
 * The machine is six rows over two states and three events, so the table below
 * is the whole of its behaviour rather than a sample of it — every row gets an
 * explicit case, including the two idempotent ones that do nothing.
 *
 * The scenario block underneath is not more coverage of the same rows: it is
 * the part a row-by-row reading cannot see, because what the reader experiences
 * is a *chain* — a courtesy switch, then a toggle, then a deselect — and the
 * question "did the panel move under somebody who had already decided" is only
 * asked across three transitions.
 *
 * Both blocks spell `'percent'` and `'kw'` as literals rather than importing the
 * machine's own constant: a test that asserted against `SELECTION_UNIT` would
 * assert that the constant equals itself and would pass unchanged if the
 * auto-switch started switching to kW (`chart-unit.ts`'s restatement ledger).
 */

/** A selection episode already under way, with the given debt outstanding. */
const selectedWith = (unit: ChartUnit, revertTo: ChartUnit | null): ChartUnitState => ({
  kind: 'selected',
  unit,
  revertTo,
});

/** Folds a chain of events over the machine — how a reader's session reads. */
const applyEvents = (from: ChartUnitState, events: readonly ChartUnitEvent[]): ChartUnitState =>
  events.reduce(chartUnitTransition, from);

describe('chartUnitTransition', () => {
  describe('the transition table', () => {
    it('starts the panel unselected and in absolute kW', () => {
      expect(INITIAL_CHART_UNIT_STATE).toStrictEqual({ kind: 'idle', unit: 'kw' });
    });

    it('takes the toggled unit while idle', () => {
      expect(
        chartUnitTransition({ kind: 'idle', unit: 'kw' }, { type: 'toggled', unit: 'percent' }),
      ).toStrictEqual({ kind: 'idle', unit: 'percent' });
    });

    it('takes the toggled unit while idle in the other direction too', () => {
      expect(
        chartUnitTransition({ kind: 'idle', unit: 'percent' }, { type: 'toggled', unit: 'kw' }),
      ).toStrictEqual({ kind: 'idle', unit: 'kw' });
    });

    it('switches to percent on selection, remembering the unit it displaced', () => {
      expect(chartUnitTransition({ kind: 'idle', unit: 'kw' }, { type: 'selected' })).toStrictEqual(
        selectedWith('percent', 'kw'),
      );
    });

    it('remembers percent as the displaced unit when percent was already showing', () => {
      expect(
        chartUnitTransition({ kind: 'idle', unit: 'percent' }, { type: 'selected' }),
      ).toStrictEqual(selectedWith('percent', 'percent'));
    });

    it('ignores a deselection while already idle', () => {
      const idle: ChartUnitState = { kind: 'idle', unit: 'percent' };

      // Same object, not merely an equal one: an idempotent event must not
      // hand React a new state to commit.
      expect(chartUnitTransition(idle, { type: 'deselected' })).toBe(idle);
    });

    it('drops the debt when the reader toggles during a selection', () => {
      expect(
        chartUnitTransition(selectedWith('percent', 'kw'), { type: 'toggled', unit: 'kw' }),
      ).toStrictEqual(selectedWith('kw', null));
    });

    it('drops the debt even when the reader toggles to the unit already showing', () => {
      expect(
        chartUnitTransition(selectedWith('percent', 'kw'), { type: 'toggled', unit: 'percent' }),
      ).toStrictEqual(selectedWith('percent', null));
    });

    /*
     * The mutation target. Replacing `revertTo ?? unit` with `unit` in the
     * `deselected` arm makes deselection keep percent, which no other case in
     * this file distinguishes from a correct revert.
     */
    it('reverts to the pre-selection unit on deselect when the reader never toggled', () => {
      expect(
        chartUnitTransition(selectedWith('percent', 'kw'), { type: 'deselected' }),
      ).toStrictEqual({ kind: 'idle', unit: 'kw' });
    });

    it('stays on the reader-chosen unit on deselect once the debt is dropped', () => {
      expect(chartUnitTransition(selectedWith('kw', null), { type: 'deselected' })).toStrictEqual({
        kind: 'idle',
        unit: 'kw',
      });
    });

    it('ignores a second selection while a selection is already under way', () => {
      const episode = selectedWith('kw', null);

      expect(chartUnitTransition(episode, { type: 'selected' })).toBe(episode);
    });
  });

  describe('what a reader lives through', () => {
    it('normalises the axis the moment a site is selected', () => {
      expect(applyEvents(INITIAL_CHART_UNIT_STATE, [{ type: 'selected' }]).unit).toBe('percent');
    });

    it('hands the axis back on deselect when the reader only ever watched', () => {
      expect(
        applyEvents(INITIAL_CHART_UNIT_STATE, [{ type: 'selected' }, { type: 'deselected' }]).unit,
      ).toBe('kw');
    });

    /*
     * The discriminating chain: the reader flips to kW to read absolutes, flips
     * back to percent, then closes the site. Ending on percent proves the
     * revert was cancelled by the *act* of toggling rather than by the value
     * landing somewhere different — a machine keying off the value would hand
     * back kW here and undo a choice the reader made twice.
     */
    it('leaves the axis where a reader put it, even back on the auto-chosen unit', () => {
      expect(
        applyEvents(INITIAL_CHART_UNIT_STATE, [
          { type: 'selected' },
          { type: 'toggled', unit: 'kw' },
          { type: 'toggled', unit: 'percent' },
          { type: 'deselected' },
        ]).unit,
      ).toBe('percent');
    });

    it('keeps a manual choice through a move from one site to another', () => {
      // A site-to-site move raises no event at all, so the chain that models it
      // is the chain without one — and a stray `selected` here is exactly the
      // bug this asserts against.
      expect(
        applyEvents(INITIAL_CHART_UNIT_STATE, [
          { type: 'selected' },
          { type: 'toggled', unit: 'kw' },
          { type: 'deselected' },
        ]).unit,
      ).toBe('kw');
    });

    it('makes the auto-switch a no-op for a reader already reading percent', () => {
      expect(
        applyEvents(INITIAL_CHART_UNIT_STATE, [
          { type: 'toggled', unit: 'percent' },
          { type: 'selected' },
          { type: 'deselected' },
        ]).unit,
      ).toBe('percent');
    });
  });
});
