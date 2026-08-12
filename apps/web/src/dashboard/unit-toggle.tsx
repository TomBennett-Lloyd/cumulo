import type { ReactElement } from 'react';

import type { ChartUnit } from './chart-unit';

/*
 * The chart's unit, as two buttons on the fleet panel's controls row.
 *
 * Its own module rather than a fragment inside `FleetPanel.tsx`, on
 * `range-picker.tsx`'s grounds and not merely by analogy with it: that file is
 * the component, its queries and its row, and every other item on that row is
 * already something the row *composes* rather than something it draws. The
 * panel is also at `structure.md` rule 4's ceiling often enough that a second
 * control drawn inline there would be the next thing cut out of it.
 *
 * Presentational (`react.md` rule 4): it owns no state at all, not even the
 * `open` the picker beside it keeps. Which unit is showing and what a press
 * means are `chart-unit.ts`'s and `use-chart-unit.ts`'s, and this control is the
 * two ends of that machine made visible — `aria-pressed` reading the unit out,
 * `onSelect` handing a press back.
 *
 * ## Two buttons, not a switch and not a select
 *
 * `aria-pressed` on ordinary buttons is `range-picker.tsx`'s shape and the
 * app's standing answer to "one choice among a small fixed set" — the same
 * treatment `.theme-toggle` wears. A `<select>` would put two options behind a
 * gesture on a row whose whole design argument is that a control states its
 * value without being opened, and a single switch labelled "%" would leave the
 * unpressed state naming neither unit: a reader meeting a chart in kW would see
 * a control offering percent and no confirmation of what they are looking at.
 * Both units are therefore named on the row at all times, and exactly one of
 * them is pressed.
 *
 * The visible labels are this file's own, and deliberately not
 * `charts/chart-copy.ts`'s pair. That module owns the words the *chart* says
 * about the unit it is drawing — the value axis's title, the table twin's
 * caption, the readout's frame — and those three have to agree with each other
 * or one number reads as two quantities. A button label is not a fourth member
 * of that set: it names a unit the reader can move *to*, in the space a 24px row
 * has, which is why the percent button reads `%` where the chart says
 * `% of capacity`. Importing half the pair — `kW`, which happens to coincide —
 * would make the two look shared while the half that matters diverged, which is
 * the shape `structure.md` rule 7 refuses.
 */

/**
 * What each button says, as a `Record` over the union.
 *
 * A `Record` rather than a literal per button, so a third `ChartUnit` fails to
 * compile until it has a label — the same construction `range-picker.tsx` uses
 * for its windows, and for the same reason: the list below is display order and
 * would only fall silently short.
 */
const UNIT_TOGGLE_LABELS: Record<ChartUnit, string> = { kw: 'kW', percent: '%' };

/**
 * Absolute first, because it is the unit the panel opens in and the one the
 * fleet's own numbers beside it are stated in.
 */
const UNIT_OPTIONS: readonly ChartUnit[] = ['kw', 'percent'];

/**
 * Names the group for assistive technology, where the two buttons alone would be
 * announced as a bare `kW` and `%` with nothing saying what they are of.
 *
 * A visible label is not the alternative: `design.md` rule 2 sends a label whose
 * only job is naming for assistive technology to the accessible name, which is
 * the move the window control's own name already made (#329).
 */
const UNIT_GROUP_LABEL = 'Chart unit';

export interface UnitToggleProps {
  readonly unit: ChartUnit;
  /** The reader's own choice — never the panel's courtesy switch, which no press makes. */
  readonly onSelect: (unit: ChartUnit) => void;
}

export const UnitToggle = ({ unit, onSelect }: UnitToggleProps): ReactElement => (
  <div className="unit-toggle" role="group" aria-label={UNIT_GROUP_LABEL}>
    {UNIT_OPTIONS.map((option) => (
      <button
        key={option}
        type="button"
        className="unit-toggle-button"
        aria-pressed={option === unit}
        onClick={() => {
          onSelect(option);
        }}
      >
        {UNIT_TOGGLE_LABELS[option]}
      </button>
    ))}
  </div>
);
