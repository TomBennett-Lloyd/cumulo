/**
 * Pure sizing for the chart's hover tooltip: panel width for the words it was
 * given, height for the rows it draws, and where each row's centre line and two
 * columns sit. No React and no DOM, so every number is testable without
 * rendering a chart (`docs/standards/structure.md` rule 4);
 * `forecast-chart-hover.tsx` composes them into SVG attributes.
 *
 * All values are SVG user units. Geometry is not styling, so these are numbers
 * here rather than tokens in `charts.css`, which owns the panel's colour, radius
 * and shadow.
 */

/**
 * The panel never shrinks below this, whatever its content measures: a readout
 * that resized to hug two short numbers would jitter as the reader moves along
 * the series, and the minimum is what keeps a narrow sample the same shape as
 * its neighbours.
 */
export const TOOLTIP_MIN_WIDTH = 104;
export const TOOLTIP_PADDING = 8;
export const TOOLTIP_ROW_HEIGHT = 14;
/** Clear of the plot ceiling so the panel border does not sit on the top grid line. */
export const TOOLTIP_TOP_GAP = 4;
/**
 * Long enough to read as a mark of the series, short enough to stay a key: with
 * the rows in columns the key is read against the name beside it rather than
 * against a run of text it introduces.
 *
 * Despite the name it is a *footprint*, not a stroke length — most rows key a
 * line and draw one this long, but the range row keys the band and draws a wash
 * between two bound hairlines in the same span (`forecast-chart-hover.tsx`).
 * Every row's key occupies exactly this much of the row, which is what the
 * sizing below computes.
 */
export const KEY_STROKE_LENGTH = 8;
export const KEY_TEXT_GAP = 6;
/**
 * Air between the name column and the value column. Wide enough that a long
 * name and a short one do not run into their neighbours' numbers, narrow enough
 * that a two-word name still reads as belonging to the number on its right.
 */
export const COLUMN_GAP = 10;
/** The time label occupies row 0; series rows start below it. */
export const FIRST_SERIES_ROW = 1;
/**
 * Mean advance width of one character of tooltip text at `--text-xs`. Columns
 * are sized by a character *count* rather than by asking the browser:
 * `getComputedTextLength` needs a laid-out DOM, which would make a pure render
 * depend on the browser and report zero under jsdom. Erring wide only leaves a
 * little air at the right-hand edge; erring narrow clips an overlay's name,
 * which is the failure this sizing exists to prevent.
 *
 * **Trued against a rendered measurement, not guessed**, and re-measured in #463
 * on the face this repo now ships — Inter, owned with its licence by
 * `packages/ui/src/tokens/tokens.css` — where it came out a shade narrower than
 * the platform face the original reading was taken on, and was left alone. The
 * constant sits a few percent above that measurement on purpose: a mean is not a
 * bound, the font is proportional, and a row of capitals and digits averages
 * wider than the string this was fitted to.
 *
 * A column is a character count times this number, and the count is taken per
 * column, over names alone or values alone. The single `value name` run each row
 * used to be is what the mean fitted worst: it mixed tabular digits with
 * proportional prose, so one number had to cover both and the widest row decided
 * a width every row paid for.
 *
 * Known and deliberately unfixed, so the next reader does not have to find it
 * again: the *value* column's content is tabular digits, whose mean advance at
 * this size is above this constant on both faces, so a value column has always
 * been modelled narrow and the panel absorbs the difference in
 * `TOOLTIP_PADDING` rather than clipping. A per-column constant is the fix, and
 * it is a decision about the column model rather than a font change. Tracked as
 * #470.
 */
export const TOOLTIP_CHAR_WIDTH = 6.3;

/** One line of the readout: a colour key, the series' name, and its value. */
export interface TooltipRow {
  /**
   * The series' own class, so the key cannot drift from the ink it names — a
   * line for most rows, a wash between two bound hairlines for the range row.
   * What shape the key is painted in is `forecast-chart-hover.tsx`'s to decide;
   * nothing here reads this.
   */
  readonly seriesClassName: string;
  readonly value: string;
  readonly name: string;
  /**
   * False where this series has nothing at this sample and `value` is therefore
   * `formatKw`'s em dash. Marked on the row rather than re-derived downstream,
   * so the one producer of the rows is also the one place that knows which of
   * them are real.
   *
   * **What it decides is speech, not ink** (#330): such a row is *drawn*, dash
   * and all, because an absence a reader can see is the honest thing to show
   * (`docs/standards/design.md` rule 5) — and *skipped* when the same rows are
   * spoken, because a screen reader at default punctuation verbosity voices an
   * em dash as silence, so announcing one announces a labelled series with no
   * value.
   */
  readonly present: boolean;
}

const textWidth = (text: string): number => text.length * TOOLTIP_CHAR_WIDTH;

/** Widest of one column's cells, and zero for a panel with no series rows. */
const columnWidth = (cells: readonly string[]): number => Math.max(0, ...cells.map(textWidth));

/**
 * The name column never clamps below this, even where the plot leaves it less.
 * Four characters is not a readable name; it is the point below which the panel
 * has stopped being two columns at all, and the floor exists so that a plot too
 * narrow to hold the pair degrades to both columns overflowing rather than to
 * the two texts stacking at one x.
 */
const MIN_NAME_COLUMN_WIDTH = TOOLTIP_CHAR_WIDTH * 4;

/** Where each of a row's two texts starts, and what the pair asks the panel for. */
export interface TooltipColumns {
  /** Left edge of the name column: past the key stroke and its gap. */
  readonly nameX: number;
  /** Left edge of the value column: past the widest name the panel has room for. */
  readonly valueX: number;
  /** Width the columns need, left padding through right padding. */
  readonly panelContentWidth: number;
}

/**
 * Two columns measured over the rows they will actually hold, which is why a row
 * is two texts rather than one run.
 *
 * Every name starts at `nameX` and every value at `valueX`, so a reader scanning
 * the panel reads a list of series and a list of numbers. The value column is
 * placed past the *widest* name rather than past each row's own name, which is
 * the whole difference between columns and per-row packing: packing puts every
 * number somewhere else and makes comparing two of them an eye-movement rather
 * than a glance.
 *
 * **`plotWidth` is here because a column has to be laid out inside the panel it
 * will be drawn in.** `tooltipPanelWidth` caps the panel at the plot, so the
 * width the names *ask* for is not always the width they get, and a name column
 * measured without that ceiling puts `valueX` past the panel's right edge — at
 * the longest name `siteSchema` accepts (`packages/shared/src/site.ts`), far
 * enough past to draw the whole value column off the plot. Clamped, the name
 * column gives up its width first and the **name** is what overflows, which is
 * the arrangement `tooltipPanelWidth` below claims: the number a reader came for
 * stays on screen, and the label they can infer from the key stroke is what runs
 * past the edge — under the value column as well as past the panel, one defect
 * rather than two, retired by the elision this file does not yet do.
 *
 * The names decide where the values go, and the values only decide how far the
 * panel reaches — which is why the width returned here is the second column's
 * right edge plus padding, not a maximum over rows.
 */
export const tooltipColumns = (rows: readonly TooltipRow[], plotWidth: number): TooltipColumns => {
  const nameX = TOOLTIP_PADDING + KEY_STROKE_LENGTH + KEY_TEXT_GAP;
  const valueWidth = columnWidth(rows.map((row) => row.value));
  const roomForNames = plotWidth - nameX - COLUMN_GAP - valueWidth - TOOLTIP_PADDING;
  const nameWidth = Math.min(
    columnWidth(rows.map((row) => row.name)),
    Math.max(MIN_NAME_COLUMN_WIDTH, roomForNames),
  );
  const valueX = nameX + nameWidth + COLUMN_GAP;
  return { nameX, valueX, panelContentWidth: valueX + valueWidth + TOOLTIP_PADDING };
};

/**
 * The panel sizes to its content, floored at `TOOLTIP_MIN_WIDTH` and capped at
 * the width of the plot it floats over. The content is the two columns above;
 * the time label is the one thing outside them, starting at the same left
 * padding but carrying no key, so it gets an arm of its own here. An overlay's
 * name is a *site* name — free text a visitor types — so the widest name is
 * routinely one nobody could have guessed at design time, and a fixed width
 * would clip it.
 *
 * **The ceiling is the point of the pair.** An uncapped panel passes the plot's
 * own width at **76 characters of name, measured at the 560-unit plot a
 * default-width chart draws, over a forecast tooltip's four rows**. Both
 * qualifiers carry weight, and leaving them off is how this figure drifted into
 * two disagreeing numbers in two files: the threshold moves with the plot it is
 * quoted against, and with the widest *value* in the panel, since the value
 * column's width comes out of what the names may have — the unit toggle (#291)
 * moves it for that second reason, and no threshold is quoted per unit here on
 * purpose. `tooltip-geometry.test.ts` owns both numbers, measuring them through
 * this function in *"takes 76 characters of site name to outgrow the plot a
 * default-width chart draws"*, so a margin change fails a case rather than
 * ageing a sentence; this docblock is the one place they are written in prose
 * (`docs/standards/architecture.md` rule 9).
 *
 * Past that length the readout would be wider than the chart it is reading,
 * blanketing the marks it exists to explain, and `tooltipAnchorX` could only pin
 * it to the left plot edge and let the rest hang off the canvas. Capped, a name
 * that long overflows its own panel instead — text spilling past one edge is a
 * legible defect confined to one row, where a panel over the whole plot hides
 * the data. Columns did not retire this arm: no arrangement of two columns fits
 * the longest name `siteSchema` accepts into a panel narrower than they are, and
 * until the overflowing name is elided the cap is what bounds the damage. Which
 * half overflows is `tooltipColumns`' choice rather than this function's — the
 * clamp there is what keeps the value column inside the capped panel.
 *
 * The ceiling outranks the floor where the two disagree, which is a plot
 * narrower than `TOOLTIP_MIN_WIDTH` — a panel that cannot be placed inside the
 * plot at all is worse than one below its minimum shape.
 */
export const tooltipPanelWidth = (
  timeLabel: string,
  rows: readonly TooltipRow[],
  plotWidth: number,
): number =>
  Math.min(
    plotWidth,
    Math.max(
      TOOLTIP_MIN_WIDTH,
      TOOLTIP_PADDING * 2 + textWidth(timeLabel),
      tooltipColumns(rows, plotWidth).panelContentWidth,
    ),
  );

/**
 * Height for the rows that are actually drawn, padded equally top and bottom.
 * Symmetry is the whole point: with the time label's centre one padding plus
 * half a row below the ceiling, this puts the last row's centre exactly that far
 * above the floor.
 *
 * **Warning — this export is a test seam, and a second caller silently breaks
 * it.** `forecast-chart-tooltip.test.tsx` proves that moving the tooltip does
 * not re-render its content by counting calls to this function, which works only
 * because the memoised panel is the one thing that calls it: "one call" means
 * "the content rendered once". Any other caller keeps every assertion green
 * while the probe quietly counts something else. Adding a caller is fine; adding
 * one without moving that probe to a seam the new caller does not share is not.
 */
export const tooltipPanelHeight = (drawnRowCount: number): number =>
  TOOLTIP_PADDING * 2 + TOOLTIP_ROW_HEIGHT * (drawnRowCount + FIRST_SERIES_ROW);

/** Centre line of the time label, which occupies row 0. */
export const TOOLTIP_TIME_Y = TOOLTIP_PADDING + TOOLTIP_ROW_HEIGHT / 2;

/** Centre line of a series row, counted over the drawn rows. */
export const tooltipRowY = (rowIndex: number): number =>
  TOOLTIP_PADDING + TOOLTIP_ROW_HEIGHT * (rowIndex + FIRST_SERIES_ROW) + TOOLTIP_ROW_HEIGHT / 2;
