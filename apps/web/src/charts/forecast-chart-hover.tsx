import type { ReactElement } from 'react';
import { snapToNearestIndex, tickLabelFor, tooltipAnchorX, xForIndex } from './chart-geometry';
import {
  formatKw,
  type ChartOverlayReading,
  type ChartScale,
  type ForecastChartPoint,
} from './chart-series';

/**
 * The chart's hover layer: the crosshair that finds the X, the tooltip that
 * reads every series at that X, and the two pure functions that decide which
 * sample a pointer or a keystroke selected.
 *
 * `docs/design/chart-treatment.md` asks for three things here, and each is a
 * separate piece below. The crosshair **snaps to the nearest timestamp**, so
 * the reader aims at a time rather than at a 2px line. **One tooltip lists
 * every series**, so the pointer never has to land on a line or inside the fill
 * to get a number — value first in full contrast, series name after it in
 * muted text, keyed by a short stroke of the series' own colour rather than a
 * filled box. And **keyboard focus shows exactly what hover shows**: both
 * routes end at the same `activeIndex`, so there is one readout, not two
 * implementations that drift.
 *
 * Positioning is SVG attributes and one `transform` — never a `style` prop,
 * which is a lint error in UI code (`react.md` rule 5). Colour lives entirely
 * in `charts.css`.
 */

/** SVG user units. Geometry — coordinates and extents, not styling. */
const TOOLTIP_WIDTH = 104;
const TOOLTIP_PADDING = 8;
const TOOLTIP_ROW_HEIGHT = 14;
/** Clear of the plot ceiling so the panel border does not sit on the top grid line. */
const TOOLTIP_TOP_GAP = 4;
/** Long enough to read as a stroke of the series, short enough to stay a key. */
const KEY_STROKE_LENGTH = 12;
const KEY_TEXT_GAP = 6;
/** The time label occupies row 0; series rows start below it. */
const FIRST_SERIES_ROW = 1;

/** One line of the readout: a colour key, a value, and the series it belongs to. */
interface TooltipRow {
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
 * The same rows, spoken rather than drawn: the time, then each series as its
 * value and the name that value belongs to. The `role="img"` chart collapses to
 * its `aria-label`, so this string is what a screen reader gets when a reader
 * moves the selection — and it comes from `tooltipRows`, so the announcement
 * and the tooltip cannot say different things about one sample. Every word here
 * names data, which `chart-copy.ts` leaves to the component that owns it.
 *
 * An absent row is dropped rather than spoken, for the reason the band row is
 * omitted rather than dashed out: screen readers at default punctuation
 * verbosity say nothing for an em dash, so an unmeasured hour would announce
 * `Actual` as a labelled series with no value at all. The en dashes inside
 * `0.0–2.0` and `P10–P90` stay — both ends of those are present, so a dropped
 * dash still reads ("0.0 2.0 P10 P90"), and respelling a range for speech alone
 * would fork this string from the tooltip it is deliberately one producer with.
 */
export const readoutText = (
  point: ForecastChartPoint,
  spanHours: number,
  overlay: ChartOverlayReading | undefined,
): string =>
  `${tickLabelFor(point.validTimeIso, spanHours)} — ${tooltipRows(point, overlay)
    .filter((row) => row.present)
    .map((row) => `${row.value} ${row.name}`)
    .join(', ')}`;

/**
 * Row coordinates are local to the tooltip group, which carries the translate.
 *
 * Keyed by `seriesClassName` rather than by `name`, because a name is not unique
 * and never was: an overlay's name is a *site* name, which is free text a visitor
 * types, so a site called "Median" collided with the forecast row and React
 * rendered one of the two. The class is one per series by construction — it is
 * the same value that colours the key stroke — so it cannot collide without two
 * rows genuinely being the same series.
 */
const tooltipRowElement = (row: TooltipRow, rowIndex: number): ReactElement => {
  const y = TOOLTIP_PADDING + TOOLTIP_ROW_HEIGHT * (rowIndex + FIRST_SERIES_ROW + 1);
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

export interface ForecastChartHoverLayerProps {
  readonly points: readonly ForecastChartPoint[];
  /** `null` while nothing is hovered or focused — the layer then draws nothing. */
  readonly activeIndex: number | null;
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
 */
export const ForecastChartHoverLayer = (
  props: ForecastChartHoverLayerProps,
): ReactElement | null => {
  const { activeIndex, overlay, points, scale, spanHours } = props;
  const point = activeIndex === null ? undefined : points[activeIndex];
  if (activeIndex === null || point === undefined) {
    return null;
  }

  const crosshairX = xForIndex(activeIndex, scale.pointCount, scale.plot);
  const rows = tooltipRows(point, overlay);
  const panelHeight = TOOLTIP_PADDING * 2 + TOOLTIP_ROW_HEIGHT * (rows.length + FIRST_SERIES_ROW);
  const anchorX = tooltipAnchorX({
    snappedX: crosshairX,
    tooltipWidth: TOOLTIP_WIDTH,
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
        <rect
          className="forecast-chart-tooltip-panel"
          x={0}
          y={0}
          width={TOOLTIP_WIDTH}
          height={panelHeight}
        />
        <text
          className="forecast-chart-tooltip-text forecast-chart-tooltip-time"
          x={TOOLTIP_PADDING}
          y={TOOLTIP_PADDING + TOOLTIP_ROW_HEIGHT}
          dominantBaseline="middle"
        >
          {tickLabelFor(point.validTimeIso, spanHours)}
        </text>
        {rows.map(tooltipRowElement)}
      </g>
    </>
  );
};

export interface PointerIndexParams {
  readonly clientX: number;
  /** The chart's `<svg>`, or `null` before it mounts. */
  readonly svg: SVGSVGElement | null;
  readonly viewBoxWidth: number;
  readonly scale: ChartScale;
}

/**
 * Which sample the pointer is over. The chart scales to its container, so a
 * client-space x means nothing until it is divided by the rendered width and
 * multiplied back into view-box units — the space every mark is drawn in.
 * Nothing measurable to divide by (unmounted, or laid out at zero width) is a
 * `null` readout rather than a NaN crosshair.
 */
export const pointerIndex = ({
  clientX,
  svg,
  viewBoxWidth,
  scale,
}: PointerIndexParams): number | null => {
  if (svg === null) {
    return null;
  }
  const bounds = svg.getBoundingClientRect();
  if (bounds.width <= 0) {
    return null;
  }
  const pointerX = ((clientX - bounds.left) / bounds.width) * viewBoxWidth;
  return snapToNearestIndex({ pointerX, plot: scale.plot, count: scale.pointCount });
};

/**
 * What a keystroke does to the readout. `ignored` is a distinct outcome rather
 * than "no change": it is the caller's signal to leave the browser default
 * alone, so the chart never swallows Tab or a page key it does not act on.
 */
export type HoverKeyAction =
  | { readonly kind: 'ignored' }
  | { readonly kind: 'cleared' }
  | { readonly kind: 'moved'; readonly activeIndex: number };

export interface HoverKeyParams {
  /** `KeyboardEvent.key`. */
  readonly key: string;
  readonly activeIndex: number | null;
  readonly pointCount: number;
}

const IGNORED: HoverKeyAction = { kind: 'ignored' };

const moved = (activeIndex: number): HoverKeyAction => ({ kind: 'moved', activeIndex });

/**
 * Keyboard parity with the pointer: arrows step, Home/End jump, Escape
 * dismisses. Both ends produce the same `activeIndex`, which is why focus
 * shows exactly what hover shows.
 *
 * Entering the series from nothing (after Escape, or focus on an empty
 * readout) lands on the first sample rather than stepping off it, so the first
 * ArrowRight never skips index 0.
 */
export const hoverKeyAction = ({
  key,
  activeIndex,
  pointCount,
}: HoverKeyParams): HoverKeyAction => {
  if (key === 'Escape') {
    return { kind: 'cleared' };
  }
  const lastIndex = pointCount - 1;
  if (lastIndex < 0) {
    return IGNORED;
  }
  switch (key) {
    case 'ArrowRight':
      return moved(activeIndex === null ? 0 : Math.min(lastIndex, activeIndex + 1));
    case 'ArrowLeft':
      return moved(activeIndex === null ? 0 : Math.max(0, activeIndex - 1));
    case 'Home':
      return moved(0);
    case 'End':
      return moved(lastIndex);
    default:
      return IGNORED;
  }
};
