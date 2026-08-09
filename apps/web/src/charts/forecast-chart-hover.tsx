import { memo, type ReactElement } from 'react';
import { tickLabelFor, tooltipAnchorX, xForIndex } from './chart-geometry';
import {
  formatKw,
  type ChartOverlayReading,
  type ChartScale,
  type ForecastChartPoint,
} from './chart-series';
import {
  KEY_STROKE_LENGTH,
  KEY_TEXT_GAP,
  TOOLTIP_PADDING,
  TOOLTIP_TIME_Y,
  TOOLTIP_TOP_GAP,
  tooltipPanelHeight,
  tooltipPanelWidth,
  tooltipRowY,
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
 * every series present at that timestamp**, so the pointer never has to land on
 * a line or inside the fill to get a number — value first in full contrast,
 * series name after it in muted text, keyed by a short stroke of the series'
 * own colour rather than a filled box. And **keyboard focus shows exactly what
 * hover shows**: both routes end at the same `activeIndex`, so there is one
 * readout, not two implementations that drift.
 *
 * **The panel follows the pointer; the data snaps.** The crosshair and the rows
 * belong to the nearest sample — a landmark that moves in steps, because that is
 * how often the data actually changes — while the panel itself tracks the
 * pointer continuously, at the rate `useChartHover` bounds it to. Separating
 * the two is #284 D7, and the separation is structural rather than a
 * convention: the position lives on the group's `transform` and the content
 * lives inside a memoised child, so a frame that only moves the panel cannot
 * re-render a single row.
 *
 * Positioning is SVG attributes and one `transform` — never a `style` prop,
 * which is a lint error in UI code (`react.md` rule 5), and never a CSS
 * transition either: a transform that already tracks the pointer has nothing to
 * animate, so there is no motion for `prefers-reduced-motion` to reduce.
 * Colour lives entirely in `charts.css`.
 */

/**
 * Every series at one timestamp, in the treatment's order. The band row is
 * omitted rather than dashed out when the point carries no uncertainty: an
 * absent row says "not modelled", an em-dashed one would imply a range of
 * nothing.
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
): readonly TooltipRow[] => {
  const { band } = point;
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
    present: true,
  };
  const forecast: readonly TooltipRow[] =
    band === undefined
      ? [measured, median]
      : [
          measured,
          median,
          {
            seriesClassName: 'forecast-chart-band-bound',
            value: `${formatKw(band.p10Kw)}–${formatKw(band.p90Kw)}`,
            name: 'P10–P90',
            present: true,
          },
        ];
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
 * The rows a reader actually gets, drawn and spoken alike. An absent row is
 * dropped rather than dashed out (#284 D6): the em dash was chrome that said
 * nothing a screen reader could hear and nothing a reader needed to see, and
 * dropping it in one place rather than two is what keeps the two readouts the
 * same statement. The table twin still carries the dash — it is a grid, and a
 * grid with a hole in it is a different thing from a list with a row missing.
 */
const visibleTooltipRows = (
  point: ForecastChartPoint,
  overlay: ChartOverlayReading | undefined,
): readonly TooltipRow[] => tooltipRows(point, overlay).filter((row) => row.present);

/**
 * The same rows, spoken rather than drawn: the time, then each series as its
 * value and the name that value belongs to. The `role="img"` chart collapses to
 * its `aria-label`, so this string is what a screen reader gets when a reader
 * moves the selection — and it comes from the same producer as the tooltip, so
 * the announcement and the drawn panel cannot say different things about one
 * sample. Every word here names data, which `chart-copy.ts` leaves to the
 * component that owns it.
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
  `${tickLabelFor(point.validTimeIso, spanHours)} — ${visibleTooltipRows(point, overlay)
    .map((row) => `${row.value} ${row.name}`)
    .join(', ')}`;

/**
 * Row coordinates are local to the tooltip group, which carries the translate.
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
const tooltipRowElement = (row: TooltipRow, rowIndex: number): ReactElement => {
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
        className="forecast-chart-tooltip-text"
        x={TOOLTIP_PADDING + KEY_STROKE_LENGTH + KEY_TEXT_GAP}
        y={y}
        dominantBaseline="middle"
      >
        <tspan className="forecast-chart-tooltip-value">{row.value}</tspan>{' '}
        <tspan className="forecast-chart-tooltip-name">{row.name}</tspan>
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
}

/**
 * What the tooltip says, with no idea where it is. Memoised on purpose and not
 * as an optimisation reflex: a pointer sweeping one sample's span moves this
 * panel once per frame at the rate `POINTER_FRAME_MS` sets
 * (`chart-hover-input.ts`), and every one of those frames would otherwise
 * rebuild four rows' worth of elements and hand React a fresh tree to
 * reconcile against the identical text already on screen (#284 D7). What it does
 * **not** save is `tooltipRows` itself — the layer below runs `visibleTooltipRows`
 * every frame regardless, because sizing the panel needs the rows before there
 * is anything to memoise. Element construction and reconciliation are the whole
 * saving. Its props are the snapped sample and numbers derived from it, so the
 * shallow compare bites for as long as the sample does — which is why the caller
 * hands it a stable `overlay` reading rather than one rebuilt per render.
 */
const TooltipPanel = memo(
  ({ overlay, panelWidth, point, spanHours }: TooltipPanelProps): ReactElement => {
    const rows = visibleTooltipRows(point, overlay);
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
        {rows.map(tooltipRowElement)}
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
  const point = activeIndex === null ? undefined : points[activeIndex];
  if (activeIndex === null || point === undefined) {
    return null;
  }

  const crosshairX = xForIndex(activeIndex, scale.pointCount, scale.plot);
  const panelWidth = tooltipPanelWidth(
    tickLabelFor(point.validTimeIso, spanHours),
    visibleTooltipRows(point, overlay),
    scale.plot.right - scale.plot.left,
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
        />
      </g>
    </>
  );
};
