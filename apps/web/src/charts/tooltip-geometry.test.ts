import { describe, expect, it } from 'vitest';
import { chartPlot } from './chart-geometry';
import {
  COLUMN_GAP,
  TOOLTIP_CHAR_WIDTH,
  tooltipColumns,
  tooltipPanelWidth,
} from './tooltip-geometry';
import type { TooltipRow } from './tooltip-geometry';
import { DEFAULT_CHART_WIDTH } from './use-chart-width';

/**
 * The tooltip's arithmetic, called directly.
 *
 * Everything this module does was previously proven only through whole-chart
 * renders (`forecast-chart-tooltip.test.tsx`), which is the right place for
 * what the panel *looks* like and the wrong one for the two edges below: both
 * are cases a rendered chart cannot reach. The overflow threshold is a property
 * of a plot width no viewport has to have, and the name column's floor only
 * binds at a plot narrower than any the app draws — so a render suite either
 * cannot express them or has to fake a viewport to do it, while the functions
 * themselves take the width as an argument (`testing.md` rule 2: the pure core
 * gets cheap, direct tests).
 *
 * Deliberately narrow in scope. Where the columns are drawn, which rows survive
 * and how the panel is anchored stay with the render suite; nothing here asserts
 * a fact that suite already covers, and nothing here touches `tooltipPanelHeight`,
 * whose one-caller property is a live test seam documented on the export itself.
 */

const row = (value: string, name: string): TooltipRow => ({
  seriesClassName: 'forecast-chart-median',
  value,
  name,
  present: true,
});

/** The time label is `tickLabelFor`'s shortest output; never the widest arm. */
const TIME_LABEL = '06:00';

/**
 * The plot the threshold below is quoted at: the one a default-width chart
 * draws, which is what `tooltip-geometry.ts`'s docblock names as the basis for
 * its figure. Derived rather than written out, so a change to either margin
 * fails the case that owns the number rather than silently restating it.
 */
const DEFAULT_PLOT = chartPlot(DEFAULT_CHART_WIDTH);
const DEFAULT_PLOT_WIDTH = DEFAULT_PLOT.right - DEFAULT_PLOT.left;

/** No ceiling at all, so a call measures what the content asks for. */
const UNCAPPED = Number.POSITIVE_INFINITY;

/** The forecast tooltip as a site chart draws it, under a name of `length`. */
const rowsUnderName = (length: number): readonly TooltipRow[] => [
  row('0.9', 'Actual'),
  row('1.0', 'Median'),
  row('0.0–2.0', 'P10–P90'),
  row('2.5', 'S'.repeat(length)),
];

describe('tooltipPanelWidth', () => {
  /*
   * The number `tooltip-geometry.ts` quotes for "how long a name outgrows the
   * plot", pinned where it is stated rather than left as prose. It drifted into
   * two different figures in two documents precisely because it is width- and
   * row-dependent and neither site said so, so this case fixes both halves: the
   * width it holds at, and the row shape it is measured over.
   */
  it('takes 75 characters of site name to outgrow the plot a default-width chart draws', () => {
    // The basis, asserted so the threshold below cannot quietly change meaning:
    // a margin change moves this, and the case that owns the figure is the one
    // that should fail.
    expect(DEFAULT_PLOT_WIDTH).toBe(552);

    const wants = (length: number): number =>
      tooltipPanelWidth(TIME_LABEL, rowsUnderName(length), UNCAPPED);

    expect(wants(74)).toBeLessThanOrEqual(DEFAULT_PLOT_WIDTH);
    expect(wants(75)).toBeGreaterThan(DEFAULT_PLOT_WIDTH);

    // And through the shipped call, ceiling included: at 74 the panel is still
    // sized by its content, at 75 it is the plot's width and the name is being
    // clamped. Asserted here too because the threshold is only interesting as a
    // statement about what the reader gets.
    expect(tooltipPanelWidth(TIME_LABEL, rowsUnderName(74), DEFAULT_PLOT_WIDTH)).toBeLessThan(
      DEFAULT_PLOT_WIDTH,
    );
    expect(tooltipPanelWidth(TIME_LABEL, rowsUnderName(75), DEFAULT_PLOT_WIDTH)).toBe(
      DEFAULT_PLOT_WIDTH,
    );
  });
});

describe('tooltipColumns', () => {
  /*
   * The floor on the name column, which no rendered chart reaches: it binds
   * below about 109 units of plot, and the narrowest viewport the app is built
   * for leaves the chart several times that. Its whole job is the shape of the
   * degradation past that point, so that is what this asserts.
   */
  it('floors the name column rather than crush or cross it on a plot too narrow for both', () => {
    const rows = [row('0.0–2.0', 'P10–P90'), row('1.0', 'Median')];
    const nameColumnWidth = (plotWidth: number): number => {
      const columns = tooltipColumns(rows, plotWidth);
      return columns.valueX - columns.nameX - COLUMN_GAP;
    };

    // Four characters at the tooltip's own character unit: the width is stated
    // here as the policy it is, rather than imported from the module, which
    // would assert nothing. Below the floor the name column stops tracking the
    // room available — which is the floor, observed rather than read.
    //
    // To a tolerance because the width is recovered by subtracting two of the
    // module's own numbers, and 22 + 25.2 + 10 − 22 − 10 is 25.200000000000003
    // in binary floating point. Six decimal places is far finer than the pixel
    // these units become, so nothing a reader could see hides inside it.
    const floor = 4 * TOOLTIP_CHAR_WIDTH;
    expect(nameColumnWidth(90)).toBeCloseTo(floor, 6);
    expect(nameColumnWidth(40)).toBeCloseTo(floor, 6);

    // The degradation is "both columns overflow the panel", never "the columns
    // collapse onto one x" and never "the value column crosses to the left of
    // the name it belongs to" — either of which is what an unfloored clamp
    // produces once the room it divides goes small, then negative.
    const columns = tooltipColumns(rows, 40);
    expect(columns.valueX).toBeGreaterThan(columns.nameX);
    expect(columns.panelContentWidth).toBeGreaterThan(40);

    // And the floor is a floor, not a fixed width: given room, the column takes
    // what its longest name asks for.
    expect(nameColumnWidth(DEFAULT_PLOT_WIDTH)).toBeCloseTo(
      'P10–P90'.length * TOOLTIP_CHAR_WIDTH,
      6,
    );
  });
});
