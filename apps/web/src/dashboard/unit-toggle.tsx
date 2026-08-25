import type { ReactElement } from 'react';

import type { ChartUnit } from './chart-unit';

/*
 * The chart's unit, as one button on the fleet panel's controls row.
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
 * two ends of that machine made visible — its label reading the unit out,
 * `onSelect` handing a press back.
 *
 * ## One button, and why it stopped being two
 *
 * This shipped as two `aria-pressed` chips — `range-picker.tsx`'s shape, and the
 * app's standing answer to "one choice among a small fixed set". It was rebuilt
 * as a single button on measurement, not on taste. Two chips cost 70.31px of a
 * row that has four other items in it, and at 320px on a font stack whose glyphs
 * run wide — Linux's `sans-serif` fallback, which CI renders in and some readers
 * browse in — the row wrapped to a second line. It may not: `fleet-panel.css`
 * derives the row's height as its tallest item's, and `chart-geometry.ts`
 * derives `CHART_VIEW_BOX_HEIGHT` from a stack that includes that row on the
 * argument that it stays one line. A control that breaks the derivation two
 * files away at the narrowest width in common use is the control that yields.
 *
 * The old note argued that a single switch labelled `%` would leave the reader
 * meeting a kW chart with a control offering percent and no confirmation of what
 * they were looking at. That objection is answered rather than overruled: this
 * button is labelled with the unit that **is showing**, not the one a press
 * moves to, so the row still states the chart's unit at rest. What a press does
 * is carried by the accessible name, which names both — the state and the
 * destination — because a label that reads only `kW` tells a reader who cannot
 * see the chart nothing about what pressing it would do.
 *
 * The visible labels are this file's own, and deliberately not
 * `charts/chart-copy.ts`'s pair. That module owns the words the *chart* says
 * about the unit it is drawing — the value axis's title, the table twin's
 * caption, the readout's frame — and those three have to agree with each other
 * or one number reads as two quantities. A button label is not a fourth member
 * of that set: it names a unit in the space a 24px row has, which is why this
 * button reads `%` where the chart says `% of capacity`. Importing half the
 * pair — `kW`, which happens to coincide — would make the two look shared while
 * the half that matters diverged, which is the shape `structure.md` rule 7
 * refuses.
 */

/**
 * What the button says, as a `Record` over the union.
 *
 * A `Record` rather than a literal per unit, so a third `ChartUnit` fails to
 * compile until it has a label — the same construction `range-picker.tsx` uses
 * for its windows.
 */
const UNIT_TOGGLE_LABELS: Record<ChartUnit, string> = { kw: 'kW', percent: '%' };

/**
 * The unit a press moves to, as a total map over the union.
 *
 * Total rather than a ternary, for the reason the labels are: a third unit is a
 * compile error here rather than a silent two-thirds of a cycle.
 */
const NEXT_UNIT: Record<ChartUnit, ChartUnit> = { kw: 'percent', percent: 'kw' };

/**
 * The unit named in full, for the accessible name alone.
 *
 * `%` is legible on a row beside a chart whose axis is titled; read aloud with
 * nothing around it, it is not. These are this control's own words for the same
 * reason the labels are — and the percent spelling matches what the chart says
 * so that a reader hearing both hears one quantity, not two.
 */
const UNIT_SPOKEN: Record<ChartUnit, string> = { kw: 'kW', percent: '% of capacity' };

/**
 * Names the control for assistive technology: what is showing, and what a press
 * would do.
 *
 * Both halves, because either alone misleads. A name that read only the current
 * unit would announce a button whose effect is unstated; one that read only the
 * destination would announce `% of capacity` on a chart drawn in kW. The visible
 * label is contained in the name in both states, which is what WCAG 2.5.3 asks
 * of a control whose visible text is shorter than its name.
 */
const unitToggleName = (unit: ChartUnit): string =>
  `Chart unit: ${UNIT_SPOKEN[unit]}. Press to show ${UNIT_SPOKEN[NEXT_UNIT[unit]]}.`;

export interface UnitToggleProps {
  readonly unit: ChartUnit;
  /** The reader's own choice — never the panel's courtesy switch, which no press makes. */
  readonly onSelect: (unit: ChartUnit) => void;
}

export const UnitToggle = ({ unit, onSelect }: UnitToggleProps): ReactElement => (
  <button
    type="button"
    className="unit-toggle"
    aria-label={unitToggleName(unit)}
    onClick={() => {
      onSelect(NEXT_UNIT[unit]);
    }}
  >
    {UNIT_TOGGLE_LABELS[unit]}
  </button>
);
