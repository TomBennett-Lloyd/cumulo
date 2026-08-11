// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { forecastChartLegend } from './forecast-chart-legend';

/*
 * The legend's own rules, against the function that renders it.
 *
 * These used to be asserted through `ForecastChart` — the chart drew the legend
 * inside its figure, so the chart's suite was where "no band, no band row" was
 * pinned. The owner's 2026-08-11 round moved the legend behind the fleet panel's
 * (i) (#429), which split one claim into two that are cheaper apart:
 *
 * - **What the legend does with its inputs** is here. It is a pure function of
 *   two arguments, so this file passes them directly rather than arranging a
 *   chart or a panel that happens to produce them — `testing.md` rule 1 asks for
 *   the module's own public surface, and rule 2's cheapness argument applies to
 *   any pure unit, not only to the domain core.
 * - **That the panel hands it the right two** is `FleetPanel.structure.test.tsx`
 *   and `FleetPanel.overlay.test.tsx`, where the legend is opened out of the tip
 *   in every state and the selected site's name is read out of it. Those are the
 *   wiring, and they are the half that would notice this function being called
 *   with a `hasBand` derived from something other than the drawn points.
 *
 * Neither half is sufficient alone, which is why the split is stated rather than
 * left to be inferred: a correct legend wired to the wrong inputs passes every
 * case below, and a panel wiring the right inputs into a legend that ignored
 * them passes every case there.
 */

afterEach(cleanup);

const OVERLAY_LABEL = 'Sunnyside Farm';

/** The rows a reader sees, in document order — which is the order they are drawn in. */
const rowsOf = (container: HTMLElement): readonly string[] =>
  [...container.querySelectorAll('.forecast-chart-legend li')].map((row) => row.textContent.trim());

const renderLegend = (overlayLabel: string | undefined, hasBand: boolean): HTMLElement =>
  render(forecastChartLegend(overlayLabel, hasBand)).container;

describe('forecastChartLegend', () => {
  it('names the two unconditional series, whatever it is asked about', () => {
    /*
     * The floor, and the reason it is a floor: the median and the actuals rows
     * are the fixed set no argument can remove, which is what makes their
     * presence a structural guarantee rather than a property of the data
     * (`docs/design/chart-treatment.md`, "Legend"). Asserted at the argument
     * combination that removes everything removable.
     */
    expect(rowsOf(renderLegend(undefined, false))).toStrictEqual([
      'Forecast (median)',
      'Actuals (simulated)',
    ]);
  });

  it('adds the band’s row at the head when the chart carries a band', () => {
    expect(rowsOf(renderLegend(undefined, true))).toStrictEqual([
      'Forecast (P10–P90, simulated)',
      'Forecast (median)',
      'Actuals (simulated)',
    ]);
  });

  it('appends the overlay after the fixed entries rather than slotting it in', () => {
    // The whole of the append rule: the three fixed rows keep their positions
    // and their order, and the overlay is last. Slotting it into draw order
    // would shift the rows above it on a selection, which is the instability the
    // fixed order exists to prevent (chart-treatment.md, the overlay bullet).
    expect(rowsOf(renderLegend(OVERLAY_LABEL, true))).toStrictEqual([
      'Forecast (P10–P90, simulated)',
      'Forecast (median)',
      'Actuals (simulated)',
      OVERLAY_LABEL,
    ]);
  });

  it('keeps the overlay last over a band-less series, where last is third', () => {
    // The same rule read at the other arm, because "append" and "fourth" are
    // different claims and only the first one is the rule. A legend that put the
    // overlay at a fixed index would pass the case above and fail here.
    expect(rowsOf(renderLegend(OVERLAY_LABEL, false))).toStrictEqual([
      'Forecast (median)',
      'Actuals (simulated)',
      OVERLAY_LABEL,
    ]);
  });

  it('keys every row with a swatch that is hidden from the accessible name', () => {
    /*
     * Identity is never carried by colour alone, so every row has a key — and
     * the key is decoration beside the words, so none of them reaches a screen
     * reader as a second thing to announce. Both halves together: a legend that
     * dropped its swatches passes the second on its own.
     */
    const container = renderLegend(OVERLAY_LABEL, true);
    const keys = [...container.querySelectorAll('.forecast-chart-legend-key')];

    expect(keys).toHaveLength(rowsOf(container).length);
    expect(keys.every((key) => key.getAttribute('aria-hidden') === 'true')).toBe(true);
  });

  it('draws the band’s key as a wash between two bounds, not as a line', () => {
    // The one row whose swatch is not a line key. At swatch size a bare 10% wash
    // is nearly invisible, so the bound stroke does double duty here — the same
    // treatment the tooltip's range row wears since #429 (`chart-treatment.md`).
    const bandKey = renderLegend(undefined, true).querySelector('.forecast-chart-legend-key');

    expect(bandKey?.querySelectorAll('.forecast-chart-band')).toHaveLength(1);
    expect(bandKey?.querySelectorAll('.forecast-chart-band-bound')).toHaveLength(2);
  });
});
