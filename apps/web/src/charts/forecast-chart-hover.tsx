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
 * `docs/design/chart-treatment.md` asks for three things here, and each is a
 * separate piece below. The crosshair **snaps to the nearest timestamp**, so
 * the reader aims at a time rather than at a 2px line. **One tooltip lists
 * every series the chart carries, at that timestamp**, so the pointer never has
 * to land on a line or inside the fill to get a number — the series' name in
 * muted text and its value in full contrast beside it, in two columns (#284
 * D12), keyed by a short stroke of the series' own colour rather than a filled
 * box, and an em dash where an hour has no value for a series (#330). And
 * **keyboard focus shows exactly what hover shows**: both routes end at the
 * same `activeIndex`, so there is one readout, not two implementations that
 * drift — one filtered for speech, which is `spokenTooltipRows` below and the
 * only place the two diverge.
 *
 * **The panel follows the pointer; the data snaps.** The crosshair and the rows
 * belong to the nearest sample — a landmark that moves in steps, because that is
 * how often the data actually changes — while the panel itself tracks the
 * pointer continuously, at the rate `useChartHover` bounds it to. Separating
 * the two is #284 D7, and the separation is structural rather than a
 * convention: the position lives on the group's `transform` and the content
 * lives inside a memoised child, so a frame that only moves the panel cannot
 * re-render one of the panel's rows.
 *
 * That memo is one of two layers, and it is the inner one. It guards what is
 * inside the panel; what keeps the rest of the figure — the marks, the legend,
 * the table twin — out of the re-rendering subtree entirely is where the hover
 * state lives, which since #331 is `forecast-chart-hover-boundary.tsx` rather
 * than `ForecastChart`. Read the sentence above as the panel's own guarantee,
 * not the figure's: the figure's is that file's.
 *
 * Positioning is SVG attributes and one `transform` — never a `style` prop,
 * which is a lint error in UI code (`react.md` rule 5), and never a CSS
 * transition either: a transform that already tracks the pointer has nothing to
 * animate, so there is no motion for `prefers-reduced-motion` to reduce.
 * Colour lives entirely in `charts.css`.
 */

/**
 * The range row, which is the one row whose *existence* is a question about the
 * chart rather than about the hour.
 *
 * A band the hour carries is a row with a range in it. A band the hour lacks is
 * a row with an em dash in it wherever the chart carries the quantity at all,
 * and no row whatsoever where it does not — which is the table twin's column
 * rule (#295, `forecast-chart-table.tsx`) applied at the tooltip's own
 * granularity, so the two surfaces gate a series on the same fact. A dash says
 * "nothing at this hour", which is true and worth showing against neighbours
 * that do carry a range; a row of nothing but dashes down every hour a reader
 * could visit would instead be the panel advertising a quantity the series
 * never had.
 */
const bandRows = (
  band: ForecastChartBand | undefined,
  chartHasBand: boolean,
): readonly TooltipRow[] => {
  if (band !== undefined) {
    return [
      {
        seriesClassName: 'forecast-chart-band-bound',
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
 * **An hour with no value dashes its cell** (owner 2026-08-10,
 * [#330](https://github.com/TomBennett-Lloyd/cumulo/issues/330);
 * `design.md` rule 5): absence is a fact about that hour and it reads as the
 * mark absence always reads as here, `formatKw`'s em dash. The row set is then
 * a fact about the chart rather than about the sample, which is what lets the
 * panel's *height* hold still under a moving cursor (`design.md` rule 6) — see
 * `TooltipPanel` below, whose height no longer changes as a reader steps along
 * the series. Height and not the whole geometry: the panel's width is still
 * measured over the rows it holds (`tooltipPanelWidth`), so it does still move
 * as a reader steps between hours whose values are different lengths — see the
 * same note under `TooltipPanel`. `present` is still marked, because speech
 * wants the opposite answer: `spokenTooltipRows` is the one filter, and it is
 * the only one.
 *
 * An overlay appends its row rather than displacing one, so the forecast rows
 * read the same whether or not a second series is on the plot. It goes through
 * this one producer and not around it: the treatment's "the announcement and
 * the tooltip are composed from the same rows" is what stops the spoken readout
 * drifting from the drawn one, and a series added to only one of them is
 * exactly that drift.
 */
const tooltipRows = (
  point: ForecastChartPoint,
  overlay: ChartOverlayReading | undefined,
  chartHasBand: boolean,
): readonly TooltipRow[] => {
  const measured: TooltipRow = {
    seriesClassName: 'forecast-chart-actuals',
    value: formatKw(point.actualKw),
    name: 'Actual',
    present: point.actualKw !== null,
  };
  const median: TooltipRow = {
    seriesClassName: 'forecast-chart-median',
    value: formatKw(point.medianKw),
    name: 'Median',
    // Nullable since #264: an hour behind the horizon on a union x-domain was
    // measured and never forecast, so the spoken readout drops the row rather
    // than announcing a labelled series with an em dash for a value.
    present: point.medianKw !== null,
  };
  const forecast: readonly TooltipRow[] = [measured, median, ...bandRows(point.band, chartHasBand)];
  return overlay === undefined
    ? forecast
    : [
        ...forecast,
        {
          // The series' own class, so the key stroke is the overlay's slot-2
          // hue by construction rather than by a second declaration.
          seriesClassName: 'forecast-chart-overlay',
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
 * same row is dropped, and the two are not in tension: screen readers at
 * default punctuation verbosity voice an em dash as silence, so a dashed row
 * announces a labelled series with no value at all — "Actual" and then nothing.
 * That evidence is #284 D6's and it stands; what #330 reversed is only the half
 * of D6 that acted on the drawn panel, where a dash is legible and a vanishing
 * row is the thing that misleads. The table twin has carried the dash
 * throughout, and the drawn tooltip now agrees with it.
 *
 * One producer, two filters — the treatment's "composed from the same rows"
 * survives it, because a filter is not a second set of rows: nothing can be
 * spoken that was not drawn, and no series can reach one surface without
 * reaching the other.
 */
const spokenTooltipRows = (
  point: ForecastChartPoint,
  overlay: ChartOverlayReading | undefined,
): readonly TooltipRow[] =>
  // `false` and not the drawn gate: the only row the gate adds is a dashed one,
  // which this filter drops either way, so speech is independent of it rather
  // than quietly agreeing with it.
  tooltipRows(point, overlay, false).filter((row) => row.present);

/**
 * The same rows, spoken rather than drawn: the time, then each series as its
 * name and the value that name is carrying.
 *
 * **Name before value since #284 D12**, following the drawn panel's columns
 * rather than the run of text they replaced. The order is not free to differ:
 * `chart-treatment.md` asks the announcement and the tooltip to be composed
 * from the same rows so the two cannot say different things about one sample,
 * and two orderings of the same words are two statements — a reader comparing
 * what they hear with what a sighted colleague is reading should not have to
 * transpose. Spoken, it is also the better half of the bargain: "Median 6.0"
 * names the thing before the number, which is how a label reads aloud.
 *
 * The `role="img"` chart collapses to its `aria-label`, so this string is what
 * a screen reader gets when a reader moves the selection — and it comes from
 * the same producer as the tooltip, so the announcement and the drawn panel
 * cannot say different things about one sample. One producer, two filters
 * since #330: the drawn panel dashes an absent value and this sentence omits
 * it, which are two readings of one row set rather than two row sets — every
 * series reaching speech reached the panel, in the panel's order, and no series
 * can be added to one of them alone. Every word here names data, which
 * `chart-copy.ts` leaves to the component that owns it.
 *
 * The en dashes inside `0.0–2.0` and `P10–P90` stay — both ends of those are
 * present, so a dropped dash still reads ("0.0 2.0 P10 P90"), and respelling a
 * range for speech alone would fork this string from the tooltip it is
 * deliberately one producer with.
 */
export const readoutText = (
  point: ForecastChartPoint,
  spanHours: number,
  overlay: ChartOverlayReading | undefined,
): string =>
  `${tickLabelFor(point.validTimeIso, spanHours)} — ${spokenTooltipRows(point, overlay)
    .map((row) => `${row.name} ${row.value}`)
    .join(', ')}`;

/**
 * Row coordinates are local to the tooltip group, which carries the translate.
 *
 * Two sibling texts rather than one with two `tspan`s (#284 D12): a `tspan`
 * flows after its predecessor, which is exactly the packing a column is not, so
 * a column position has to be an `x` on a text of its own. Both are anchored at
 * their start and take their x from `columns`, measured once per content render
 * over the same rows being drawn — so every name in a panel begins at one x and
 * every value at another, whatever the rows happen to say. `-text` carries the
 * font both need; `-name` and `-value` carry only their contrast.
 *
 * Keyed by `seriesClassName` rather than by `name`, because a name is not unique
 * and never was: an overlay's name is a *site* name, which is free text a visitor
 * types, so a site called "Median" shares a key with the forecast's own median
 * row. The class is one per series by construction — it is the same value that
 * colours the key stroke — so it cannot collide without two rows genuinely being
 * the same series.
 *
 * What the collision actually cost is worth stating precisely, because it is
 * less than it sounds and the fix is still right. No row was ever observed to
 * disappear: on the shapes this chart produces, React reconciled the duplicate
 * keys to the correct four rows with the correct numbers, and a DOM assertion
 * written against the bug passed. What React does emit is a warning that
 * children "may be duplicated and/or omitted — the behavior is unsupported and
 * could change in a future version", which is a promise about future renders
 * rather than a report about this one. That warning is the only observer, and
 * `forecast-chart-hover.test.tsx` asserts it rather than a dropped row, for
 * exactly that reason.
 */
const tooltipRowElement = (
  row: TooltipRow,
  rowIndex: number,
  columns: TooltipColumns,
): ReactElement => {
  const y = tooltipRowY(rowIndex);
  return (
    <g key={row.seriesClassName}>
      <line
        className={row.seriesClassName}
        x1={TOOLTIP_PADDING}
        x2={TOOLTIP_PADDING + KEY_STROKE_LENGTH}
        y1={y}
        y2={y}
      />
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
 * rebuild four rows' worth of elements and hand React a fresh tree to
 * reconcile against the identical text already on screen (#284 D7). What it does
 * **not** save is `tooltipRows` itself — the layer below runs it every frame
 * regardless, because sizing the panel needs the rows before there is anything
 * to memoise. Element construction and reconciliation are the whole
 * saving. Its props are the snapped sample and numbers derived from it, so the
 * shallow compare bites for as long as the sample does — which is why the caller
 * hands it a stable `overlay` reading rather than one rebuilt per render.
 *
 * **Every row is drawn, dashes included** (#330). The filter that used to run
 * here belongs to speech alone, and losing it is what makes this panel's height
 * a constant per chart configuration rather than a number that changes as a
 * reader steps between hours — `chart-treatment.md`'s "height is a constant per
 * chart", and `design.md` rule 6's reference frame gained in that one dimension
 * rather than merely defended.
 *
 * **Height, and only height.** The panel's *width* is still measured over the
 * rows it holds (`tooltipPanelWidth`, the treatment's "The panel sizes to its
 * content"), and a dash is a shorter value string than a range, so stepping
 * from a banded hour to an unbanded one still narrows the panel under the
 * cursor. That is decided behaviour rather than something this change left
 * half-done, and the tension it leaves with rule 6 is logged in
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
 * chrome, so they sit on top, and the pointer target that summons them is the
 * one element after them.
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
  // which is what the table's P10/P90 columns already do with the same question
  // (#295). Memoised on the points, so this O(n) pass runs when the series
  // changes and not once per pointer frame: since #331 the hover state lives in
  // `forecast-chart-hover-boundary.tsx`, and a frame re-renders the hover
  // chrome and the spoken readout with nothing else in the figure rebuilt, so
  // nothing else in that frame walks the points for this pass to ride along
  // with. Every hover-state render in between reuses the memo. Above the early
  // return below, because a hook cannot sit under one.
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
