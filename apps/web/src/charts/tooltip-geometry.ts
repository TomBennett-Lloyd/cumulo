/**
 * Pure sizing for the chart's hover tooltip: how wide the panel has to be to
 * hold the words it was given, how tall its visible rows make it, and where each
 * row's centre line sits. No React and no DOM — `forecast-chart-hover.tsx`
 * composes these numbers into SVG attributes, and every one of them is testable
 * without rendering a chart (`structure.md` rule 4: the first cut out of a
 * growing file is its types and its arithmetic).
 *
 * All values are SVG user units. Geometry — coordinates and extents — is not
 * styling, so these are numbers here rather than tokens in `charts.css`; the
 * panel's colour, radius and shadow are that file's, and none of them appear
 * here.
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
/** Long enough to read as a stroke of the series, short enough to stay a key. */
export const KEY_STROKE_LENGTH = 12;
export const KEY_TEXT_GAP = 6;
/** The time label occupies row 0; series rows start below it. */
export const FIRST_SERIES_ROW = 1;
/**
 * Mean advance width of one character of tooltip text at `--text-xs`. The panel
 * is sized by a character *count* rather than by asking the browser, for the
 * reason `HORIZON_LABEL_WIDTH` is estimated in `forecast-chart-axes.tsx`:
 * `getComputedTextLength` needs a laid-out DOM, which would make a pure render
 * depend on the browser and report zero under jsdom. Erring wide only leaves a
 * little air at the right-hand edge; erring narrow clips an overlay's name,
 * which is the failure this sizing exists to prevent.
 *
 * **Trued against a rendered measurement, not guessed.** #284 D6 shipped this at
 * 5.6, and the browser smoke on the demo data caught the clip it caused: with
 * "Manchester rooftop 1" selected as the overlay, the row `2.8 Manchester
 * rooftop 1` (24 characters) drew a right edge at 170.63 user units inside a
 * panel 168.4 wide — 2.23 units of overhang. Text starts at
 * `TOOLTIP_PADDING + KEY_STROKE_LENGTH + KEY_TEXT_GAP` = 26, so that row's real
 * drawn width was 144.63 and its mean advance 6.026 — which also confirms the
 * model itself was sound and only this number was wrong, since 5.6 predicts the
 * observed 168.4 exactly.
 *
 * 6.3 is that measurement plus about 4.5%. The margin is kept rather than
 * rounded away because a mean is not a bound: the font is proportional, so a row
 * of capitals and digits averages wider than the string this was measured on,
 * and a mean-advance model has no way to know which row it is being asked about.
 * At 6.3 the measured row sizes a 185.2-unit panel, ~14.6 units clear.
 *
 * The whole model is provisional. Laying the panel out as real columns —
 * measuring per row instead of multiplying a mean — is #284 D12, and it replaces
 * this constant rather than retuning it.
 */
export const TOOLTIP_CHAR_WIDTH = 6.3;

/** One line of the readout: a colour key, a value, and the series it belongs to. */
export interface TooltipRow {
  /** The series' own class, so the key stroke cannot drift from the line it names. */
  readonly seriesClassName: string;
  readonly value: string;
  readonly name: string;
  /**
   * False where this series has nothing at this sample and `value` is therefore
   * `formatKw`'s em dash. Marked on the row rather than re-derived downstream,
   * so the one producer of the rows is also the one place that knows which of
   * them are real.
   */
  readonly present: boolean;
}

const textWidth = (text: string): number => text.length * TOOLTIP_CHAR_WIDTH;

/**
 * The panel sizes to its content, floored at `TOOLTIP_MIN_WIDTH` and capped at
 * the width of the plot it floats over. A row is a key stroke, a gap, and
 * `value name` as one run of text; the time label starts at the same left
 * padding but carries no key. An overlay's name is a *site* name — free text a
 * visitor types — so the widest row is routinely the one nobody could have
 * guessed at design time, and a fixed width would clip it.
 *
 * **The ceiling is the point of the pair.** `siteSchema` accepts 120 characters
 * of name (`packages/shared/src/site.ts`), and an uncapped panel passes the
 * plot's own width somewhere around 56 of them: the readout would then be wider
 * than the chart it is reading, blanketing the marks it exists to explain, and
 * `tooltipAnchorX` could only pin it to the left plot edge and let the rest hang
 * off the canvas. Capped, a name that long overflows its own panel instead —
 * text spilling past one edge is a legible defect confined to one row, where a
 * panel over the whole plot hides the data. Deliberately bounding the damage
 * rather than fixing it: laying the rows out as measured columns, and eliding
 * what still does not fit, is #284 D12.
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
      ...rows.map(
        (row) =>
          TOOLTIP_PADDING * 2 +
          KEY_STROKE_LENGTH +
          KEY_TEXT_GAP +
          textWidth(`${row.value} ${row.name}`),
      ),
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
 * "the content rendered once". Anything else calling it — the layer wanting the
 * panel's height to place it, a table, a second panel — keeps every assertion
 * green while the probe quietly starts counting something else. Adding a caller
 * is fine; adding one without moving that probe to a seam the new caller does
 * not share is not.
 */
export const tooltipPanelHeight = (visibleRowCount: number): number =>
  TOOLTIP_PADDING * 2 + TOOLTIP_ROW_HEIGHT * (visibleRowCount + FIRST_SERIES_ROW);

/** Centre line of the time label, which occupies row 0. */
export const TOOLTIP_TIME_Y = TOOLTIP_PADDING + TOOLTIP_ROW_HEIGHT / 2;

/** Centre line of a drawn series row, counted over the visible rows only. */
export const tooltipRowY = (rowIndex: number): number =>
  TOOLTIP_PADDING + TOOLTIP_ROW_HEIGHT * (rowIndex + FIRST_SERIES_ROW) + TOOLTIP_ROW_HEIGHT / 2;
