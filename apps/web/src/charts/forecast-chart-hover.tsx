import { memo, useMemo, type ReactElement } from 'react';
import { tickLabelFor, tooltipAnchorX } from './chart-geometry';
import {
  formatKw,
  xAt,
  type ChartOverlayReading,
  type ChartScale,
  type ForecastChartBand,
  type ForecastChartPoint,
} from './chart-series';
import {
  KEY_STROKE_LENGTH,
  TOOLTIP_PADDING,
  TOOLTIP_TIME_Y,
  TOOLTIP_TOP_GAP,
  tooltipColumns,
  tooltipPanelHeight,
  tooltipPanelWidth,
  tooltipRowY,
  type TooltipColumns,
  type TooltipRow,
} from './tooltip-geometry';

/**
 * The chart's hover layer: the crosshair that finds the X, and the tooltip that
 * reads every series at that X. The arithmetic that sizes and lays out the panel
 * is `tooltip-geometry.ts`'s; deciding which sample an input selected, and how
 * often the panel may move, is `chart-hover-input.ts`'s.
 *
 * `docs/design/chart-treatment.md` asks for three things here, each a separate
 * piece below. The crosshair **snaps to the nearest timestamp**, so the reader
 * aims at a time rather than at a hairline. **One tooltip lists every series the
 * chart carries, at that timestamp**, so the pointer never has to land on a line
 * or inside the fill to get a number — name in muted text, value in full
 * contrast beside it, in two columns, keyed by a short stroke of the series'
 * colour, except the range row, which is keyed by the band's own wash and bounds
 * so the panel says what the band is now that the legend sits behind the (i)
 * (owner 2026-08-11, #429) — and an em dash where an hour has no value for a
 * series (#330). And **keyboard focus shows exactly what hover shows**: both
 * routes end at the same `activeIndex`, so there is one readout rather than two
 * implementations that drift — `spokenTooltipRows` below is the only place they
 * diverge.
 *
 * **The panel follows the pointer; the data snaps.** The crosshair and the rows
 * belong to the nearest sample — a landmark that moves in steps, because that is
 * how often the data actually changes — while the panel tracks the pointer
 * continuously, at the rate `useChartHover` bounds it to. The separation is
 * structural rather than a convention: the position lives on the group's
 * `transform` and the content inside a memoised child, so a frame that only
 * moves the panel cannot re-render one of its rows. That memo is the inner of
 * two layers and guards only what is inside the panel; keeping the rest of the
 * figure out of the re-rendering subtree is `forecast-chart-hover-boundary.tsx`'s
 * job, since that is where the hover state lives.
 *
 * Positioning is SVG attributes and one `transform` — never a `style` prop,
 * which is a lint error in UI code (`docs/standards/react.md` rule 5), and never
 * a CSS transition either: a transform that already tracks the pointer has
 * nothing to animate, so there is no motion for `prefers-reduced-motion` to
 * reduce. Colour lives entirely in `charts.css`.
 */

/**
 * A row as it is **drawn**: everything the sizer needs, plus the one thing the
 * sizer has no opinion about — which key names it.
 *
 * `keyKind` is a required literal union rather than an optional `isBand?` flag
 * (`docs/standards/typing.md` rule 4): every producer has to say which key it
 * wants, so a row added later cannot silently inherit the wrong one, and there
 * is no `undefined` arm to interpret. It is ink and nothing else — no arm of
 * `tooltip-geometry.ts` reads it, which is why this extends `TooltipRow` here
 * rather than widening it there. The panel must measure the same width whichever
 * key a row carries, held by `forecast-chart-tooltip.test.tsx`'s
 * width-invariance case: #421 argues the pinned tooltip's coverage of its own
 * hour from this panel's width, and a key that cost width would falsify it.
 */
export interface DrawnTooltipRow extends TooltipRow {
  readonly keyKind: 'line' | 'band';
}

/**
 * The range row, which is the one row whose *existence* is a question about the
 * chart rather than about the hour.
 *
 * A band the hour carries is a row with a range in it. A band the hour lacks is
 * a dashed row wherever the chart carries the quantity at all, and no row
 * whatsoever where it does not — the table twin's column rule
 * (`forecast-chart-table.tsx`) at the tooltip's granularity, so the two surfaces
 * gate a series on the same fact. A dash says "nothing at this hour", worth
 * showing against neighbours that do carry a range; dashes down every hour a
 * reader could visit would instead advertise a quantity the series never had.
 */
const bandRows = (
  band: ForecastChartBand | undefined,
  chartHasBand: boolean,
): readonly DrawnTooltipRow[] => {
  if (band !== undefined) {
    return [
      {
        seriesClassName: 'forecast-chart-band-bound',
        keyKind: 'band',
        value: `${formatKw(band.p10Kw)}–${formatKw(band.p90Kw)}`,
        name: 'P10–P90',
        present: true,
      },
    ];
  }
  if (!chartHasBand) {
    return [];
  }
  return [
    {
      seriesClassName: 'forecast-chart-band-bound',
      keyKind: 'band',
      // Through the formatter rather than as a literal, so this dash is the
      // same mark the table's cells and every other absent value carry by
      // construction instead of by a second spelling of it.
      value: formatKw(null),
      name: 'P10–P90',
      present: false,
    },
  ];
};

/**
 * Every series the chart carries, at one timestamp, in the treatment's order —
 * a row per series rather than a row per value, which is what makes the panel
 * the table twin's row-analogue rather than a list that happens to be near it.
 *
 * **An hour with no value dashes its cell** (owner 2026-08-10, #330;
 * `docs/standards/design.md` rule 5): absence is a fact about that hour and
 * reads as `formatKw`'s em dash. The row set is then a fact about the chart
 * rather than about the sample, which is what holds the panel's *height* still
 * under a moving cursor (rule 6) — height and not the whole geometry, since
 * `tooltipPanelWidth` still measures over the rows held; see `TooltipPanel`.
 * `present` is still marked, because speech wants the opposite answer, and
 * `spokenTooltipRows` is the only filter.
 *
 * An overlay appends its row rather than displacing one, so the forecast rows
 * read the same whether or not a second series is on the plot, and it goes
 * through this one producer: the treatment's "the announcement and the tooltip
 * are composed from the same rows" is what stops the spoken readout drifting
 * from the drawn one.
 */
const tooltipRows = (
  point: ForecastChartPoint,
  overlay: ChartOverlayReading | undefined,
  chartHasBand: boolean,
): readonly DrawnTooltipRow[] => {
  const measured: DrawnTooltipRow = {
    seriesClassName: 'forecast-chart-actuals',
    keyKind: 'line',
    value: formatKw(point.actualKw),
    name: 'Actual',
    present: point.actualKw !== null,
  };
  const median: DrawnTooltipRow = {
    seriesClassName: 'forecast-chart-median',
    keyKind: 'line',
    value: formatKw(point.medianKw),
    name: 'Median',
    // Nullable since #264: an hour behind the horizon on a union x-domain was
    // measured and never forecast, so the spoken readout drops the row rather
    // than announcing a labelled series with an em dash for a value.
    present: point.medianKw !== null,
  };
  const forecast: readonly DrawnTooltipRow[] = [
    measured,
    median,
    ...bandRows(point.band, chartHasBand),
  ];
  return overlay === undefined
    ? forecast
    : [
        ...forecast,
        {
          // The series' own class, so the key stroke is the overlay's slot-2
          // hue by construction rather than by a second declaration.
          seriesClassName: 'forecast-chart-overlay',
          keyKind: 'line',
          value: formatKw(overlay.kw),
          name: overlay.label,
          present: overlay.kw !== null,
        },
      ];
};

/**
 * The rows a reader *hears*, which are fewer than the rows they see.
 *
 * Drawn, an absent value is dashed (#330 — the paragraph above). Spoken, the
 * same row is dropped, and the two are not in tension: screen readers at default
 * punctuation verbosity voice an em dash as silence, so a dashed row announces a
 * labelled series with no value at all — "Actual" and then nothing.
 *
 * One producer, two filters — the treatment's "composed from the same rows"
 * survives it, because a filter is not a second set of rows: nothing can be
 * spoken that was not drawn, and no series can reach one surface without
 * reaching the other.
 */
const spokenTooltipRows = (
  point: ForecastChartPoint,
  overlay: ChartOverlayReading | undefined,
): readonly DrawnTooltipRow[] =>
  // `false` and not the drawn gate: the only row the gate adds is a dashed one,
  // which this filter drops either way, so speech is independent of it rather
  // than quietly agreeing with it.
  tooltipRows(point, overlay, false).filter((row) => row.present);

/**
 * The same rows, spoken rather than drawn: the time, then each series as its
 * name and the value that name is carrying.
 *
 * **Name before value**, following the drawn panel's columns. The order is not
 * free to differ: `docs/design/chart-treatment.md` asks the announcement and the
 * tooltip to be composed from the same rows so the two cannot say different
 * things about one sample, and two orderings of the same words are two
 * statements. Spoken it is also the better half of the bargain — a name before
 * its number is how a label reads aloud.
 *
 * The `role="img"` chart collapses to its `aria-label`, so this string is what a
 * screen reader gets when the selection moves. Every word here names data, which
 * `chart-copy.ts` leaves to the component that owns it.
 *
 * The en dashes inside a range value stay — both ends of one are present, so a
 * dropped dash still reads, and respelling a range for speech alone would fork
 * this string from the tooltip it is deliberately one producer with.
 *
 * **The frame carries the unit, and since #291 it has to** (the unit half of
 * `docs/tech-debt.md`'s #235, which this closes). A chart a reader can switch
 * between kW and percent of capacity otherwise announces the same words for two
 * different quantities, with nothing in speech to tell them apart; the drawn
 * tooltip needs no such word because the visible axis title carries it.
 *
 * **Once in the frame, not once per row.** The unit is a fact about the whole
 * sample — every row of one announcement is in one unit by construction — and
 * per row it would have to be threaded into the row producer, the one thing the
 * drawn panel and speech share. Inserted into the sentence *around* the rows,
 * the one-producer/two-filters contract is untouched: no row's text differs
 * between the two surfaces.
 *
 * The clock half of #235 stays open — the readout names the hour and never
 * "UTC", where the axis title and the table twin both do.
 */
export const readoutText = (
  point: ForecastChartPoint,
  spanHours: number,
  overlay: ChartOverlayReading | undefined,
  unitLabel: string,
): string =>
  `${tickLabelFor(point.validTimeIso, spanHours)} (${unitLabel}) — ${spokenTooltipRows(
    point,
    overlay,
  )
    .map((row) => `${row.name} ${row.value}`)
    .join(', ')}`;

/**
 * How tall the band key's wash is drawn — its *only* dimension that is a choice
 * here, since its width is `KEY_STROKE_LENGTH` and must stay so (below). Ink
 * rather than sizing, which is why it lives beside the element it draws instead
 * of in `tooltip-geometry.ts`: no arm of the panel's arithmetic reads it, and a
 * row is `TOOLTIP_ROW_HEIGHT` tall whatever key it carries. Roughly the legend
 * swatch's proportion of its own row, so the two read as the same mark.
 */
const BAND_KEY_HEIGHT = 10;
/**
 * Half a stroke in from each edge, so a 1-unit hairline centred on this line
 * sits exactly inside the wash it bounds rather than half outside it — the same
 * offset `forecast-chart-legend.tsx` gives its own swatch.
 */
const BAND_KEY_BOUND_INSET = 0.5;

/**
 * The mark that names a row's series, in the row's own left gutter.
 *
 * **A band is not a line, and with the legend behind the (i) since 2026-08-11
 * the tooltip is where a reader finds that out.** A line series is keyed by a
 * stroke of its colour; the range row is keyed by the band's own treatment — the
 * wash with a bound hairline top and bottom, `forecast-chart-legend.tsx`'s
 * swatch scaled to this gutter. It reuses the plot's own class names, so the
 * wash and the hairlines have one owner (`charts.css`) and the key cannot drift
 * from the band it names.
 *
 * **It is drawn at the key footprint, not the legend's.** A legend swatch is
 * several times the width `KEY_STROKE_LENGTH` reserves here, and drawing one at
 * its own width would push `nameX` right and widen every panel the chart shows.
 * The panel's width is load-bearing beyond this file — #421's tap contract was
 * argued on how much of its own hour a pinned panel covers — so the key kind
 * changes the ink inside the gutter and nothing about the gutter.
 */
const rowKeyElement = (row: DrawnTooltipRow, y: number): ReactElement => {
  const keyLeft = TOOLTIP_PADDING;
  const keyRight = TOOLTIP_PADDING + KEY_STROKE_LENGTH;

  if (row.keyKind === 'line') {
    return <line className={row.seriesClassName} x1={keyLeft} x2={keyRight} y1={y} y2={y} />;
  }

  const top = y - BAND_KEY_HEIGHT / 2;
  const bottom = y + BAND_KEY_HEIGHT / 2;
  return (
    <>
      <rect
        className="forecast-chart-band"
        x={keyLeft}
        y={top}
        width={KEY_STROKE_LENGTH}
        height={BAND_KEY_HEIGHT}
      />
      <line
        className="forecast-chart-band-bound"
        x1={keyLeft}
        x2={keyRight}
        y1={top + BAND_KEY_BOUND_INSET}
        y2={top + BAND_KEY_BOUND_INSET}
      />
      <line
        className="forecast-chart-band-bound"
        x1={keyLeft}
        x2={keyRight}
        y1={bottom - BAND_KEY_BOUND_INSET}
        y2={bottom - BAND_KEY_BOUND_INSET}
      />
    </>
  );
};

/**
 * Row coordinates are local to the tooltip group, which carries the translate.
 *
 * Two sibling texts rather than one with two `tspan`s: a `tspan` flows after its
 * predecessor, which is exactly the packing a column is not, so a column
 * position has to be an `x` on a text of its own. Both are anchored at their
 * start and take their x from `columns`, so every name in a panel begins at one
 * x and every value at another, whatever the rows say. `-text` carries the font
 * both need; `-name` and `-value` carry only their contrast.
 *
 * Keyed by `seriesClassName` rather than by `name`, because a name is not
 * unique: an overlay's name is a *site* name, free text a visitor types, so a
 * site called "Median" would share a key with the forecast's own median row. The
 * class is one per series by construction, so it cannot collide without two rows
 * genuinely being the same series.
 *
 * What the collision cost is worth stating, because it is less than it sounds
 * and the fix is still right: no row was ever observed to disappear, and the
 * only observer is React's warning that duplicate-keyed children "may be
 * duplicated and/or omitted" in a future version — a promise about future
 * renders rather than a report about this one. `forecast-chart-hover.test.tsx`
 * asserts that warning rather than a dropped row, for exactly that reason.
 */
const tooltipRowElement = (
  row: DrawnTooltipRow,
  rowIndex: number,
  columns: TooltipColumns,
): ReactElement => {
  const y = tooltipRowY(rowIndex);
  return (
    <g key={row.seriesClassName}>
      {rowKeyElement(row, y)}
      <text
        className="forecast-chart-tooltip-text forecast-chart-tooltip-name"
        x={columns.nameX}
        y={y}
        dominantBaseline="middle"
      >
        {row.name}
      </text>
      <text
        className="forecast-chart-tooltip-text forecast-chart-tooltip-value"
        x={columns.valueX}
        y={y}
        dominantBaseline="middle"
      >
        {row.value}
      </text>
    </g>
  );
};

interface TooltipPanelProps {
  /** The snapped sample — the only thing that decides what the panel says. */
  readonly point: ForecastChartPoint;
  readonly spanHours: number;
  readonly overlay: ChartOverlayReading | undefined;
  /**
   * Computed by the layer, because the same number clamps the panel inside the
   * plot: one measurement, spent on the rect and on the anchor.
   */
  readonly panelWidth: number;
  /**
   * The ceiling that measurement was taken under, passed as well as its result
   * because the columns are laid out against the ceiling rather than against
   * the panel: `tooltipColumns` needs it to know how much of the name column a
   * capped panel can actually hold. A number and not the columns themselves —
   * a fresh object per frame would defeat the memo this panel exists inside.
   */
  readonly plotWidth: number;
  /**
   * Whether the chart carries a band at any hour — which decides whether an
   * unbanded hour gets a dashed range row or none at all (`tooltipRows`).
   * A boolean and not the points it is derived from, for the same reason
   * `plotWidth` is a number: the memo below compares props shallowly, and a
   * primitive is the shape that comparison can actually see through.
   */
  readonly chartHasBand: boolean;
}

/**
 * What the tooltip says, with no idea where it is. Memoised on purpose and not
 * as an optimisation reflex: a pointer sweeping one sample's span moves this
 * panel once per frame at the rate `POINTER_FRAME_MS` sets
 * (`chart-hover-input.ts`), and every one of those frames would otherwise
 * rebuild the rows' elements and hand React a fresh tree to reconcile against
 * the identical text already on screen. What it does **not** save is
 * `tooltipRows` itself — the layer below runs it every frame regardless, because
 * sizing the panel needs the rows before there is anything to memoise. Its props
 * are the snapped sample and numbers derived from it, so the shallow compare
 * bites for as long as the sample does — which is why the caller hands it a
 * stable `overlay` reading rather than one rebuilt per render.
 *
 * **Every row is drawn, dashes included** (#330), which is what makes this
 * panel's height a constant per chart configuration rather than a number that
 * changes as a reader steps between hours — `docs/design/chart-treatment.md`'s
 * "height is a constant per chart", and `docs/standards/design.md` rule 6's
 * reference frame gained in that one dimension rather than merely defended.
 *
 * **Height, and only height.** `tooltipPanelWidth` still measures over the rows
 * held, and a dash is a shorter value string than a range, so stepping from a
 * banded hour to an unbanded one still narrows the panel under the cursor. That
 * is decided behaviour, and the tension it leaves with rule 6 is logged in
 * `docs/tech-debt.md` for the owner rather than settled here.
 */
const TooltipPanel = memo(
  ({
    chartHasBand,
    overlay,
    panelWidth,
    plotWidth,
    point,
    spanHours,
  }: TooltipPanelProps): ReactElement => {
    const rows = tooltipRows(point, overlay, chartHasBand);
    const columns = tooltipColumns(rows, plotWidth);
    return (
      <>
        <rect
          className="forecast-chart-tooltip-panel"
          x={0}
          y={0}
          width={panelWidth}
          height={tooltipPanelHeight(rows.length)}
        />
        <text
          className="forecast-chart-tooltip-text forecast-chart-tooltip-time"
          x={TOOLTIP_PADDING}
          y={TOOLTIP_TIME_Y}
          dominantBaseline="middle"
        >
          {tickLabelFor(point.validTimeIso, spanHours)}
        </text>
        {rows.map((row, rowIndex) => tooltipRowElement(row, rowIndex, columns))}
      </>
    );
  },
);

export interface ForecastChartHoverLayerProps {
  readonly points: readonly ForecastChartPoint[];
  /** `null` while nothing is hovered or focused — the layer then draws nothing. */
  readonly activeIndex: number | null;
  /**
   * Where the pointer is, in SVG user units, or `null` when the selection came
   * from the keyboard. The panel follows this; the crosshair never does.
   */
  readonly pointerX: number | null;
  readonly scale: ChartScale;
  readonly spanHours: number;
  /**
   * The overlay at the active sample, or `undefined` where the chart carries no
   * overlay. Required-and-nullable rather than optional, like `activeIndex`
   * above: the chart is the one caller and always knows the answer.
   */
  readonly overlay: ChartOverlayReading | undefined;
}

/**
 * Drawn above every mark and below nothing: the crosshair and the readout are
 * chrome, so they sit on top. The one element after them is the plot's pointer
 * target — a hit surface over the marks rather than what summons this layer,
 * since the handlers that do live on the `<svg>` in
 * `forecast-chart-hover-boundary.tsx`.
 *
 * The crosshair marks the **snapped** sample and the panel follows the
 * **pointer**, clamped into the plot by the same `tooltipAnchorX` that has
 * always kept it on the canvas. A keyboard selection has no pointer, so the
 * panel falls back to the crosshair — arrow keys step between landmarks and the
 * readout steps with them.
 */
export const ForecastChartHoverLayer = (
  props: ForecastChartHoverLayerProps,
): ReactElement | null => {
  const { activeIndex, overlay, pointerX, points, scale, spanHours } = props;
  // A fact about the chart, so it is answered from the whole series rather than
  // from the sample: the panel carries a range row at every hour or at none,
  // which is what the table's P10/P90 columns do with the same question.
  // Memoised on the points, so this O(n) pass runs when the series changes and
  // not once per pointer frame — a hover frame rebuilds only the chrome and the
  // spoken readout, so nothing else in it walks the points for this pass to ride
  // along with. Above the early return below, because a hook cannot sit under
  // one.
  const chartHasBand = useMemo(() => points.some((p) => p.band !== undefined), [points]);
  const point = activeIndex === null ? undefined : points[activeIndex];
  if (activeIndex === null || point === undefined) {
    return null;
  }

  const crosshairX = xAt(scale, activeIndex);
  const plotWidth = scale.plot.right - scale.plot.left;
  const panelWidth = tooltipPanelWidth(
    tickLabelFor(point.validTimeIso, spanHours),
    tooltipRows(point, overlay, chartHasBand),
    plotWidth,
  );
  const anchorX = tooltipAnchorX({
    followX: pointerX ?? crosshairX,
    tooltipWidth: panelWidth,
    plot: scale.plot,
  });
  const anchorY = scale.plot.top + TOOLTIP_TOP_GAP;

  return (
    <>
      <line
        className="forecast-chart-crosshair"
        x1={crosshairX}
        x2={crosshairX}
        y1={scale.plot.top}
        y2={scale.plot.bottom}
      />
      <g
        className="forecast-chart-tooltip"
        transform={`translate(${String(anchorX)}, ${String(anchorY)})`}
      >
        <TooltipPanel
          point={point}
          spanHours={spanHours}
          overlay={overlay}
          panelWidth={panelWidth}
          plotWidth={plotWidth}
          chartHasBand={chartHasBand}
        />
      </g>
    </>
  );
};
