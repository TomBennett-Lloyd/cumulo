import { useMemo, useRef, type ReactElement } from 'react';
import { UNIT_LABEL_KW, UNIT_LABEL_PERCENT_OF_CAPACITY } from './chart-copy';
import { chartPlot, niceAxisMax, percentAxisMax, sampleXs } from './chart-geometry';
import { loadingCurvePath } from './chart-loading-curve';
import {
  contiguousRuns,
  highestOverlayKw,
  highestValueKw,
  overlayValuesByIndex,
  seriesSpanHours,
  type ChartOverlayColumn,
  type ChartOverlaySeries,
  type ChartScale,
  type ForecastChartPoint,
} from './chart-series';
import {
  axisTitleElements,
  gridElements,
  horizonElements,
  xAxisElements,
} from './forecast-chart-axes';
import { dayBoundaryElements, nightElements } from './forecast-chart-context';
import { chartErrorOverlay, type ChartErrorNotice } from './forecast-chart-error';
import { ForecastChartHoverBoundary } from './forecast-chart-hover-boundary';
import {
  actualsElements,
  bandElements,
  boundElements,
  medianElements,
  overlayElements,
} from './forecast-chart-marks';
import { forecastChartTable } from './forecast-chart-table';
import { useChartWidth } from './use-chart-width';

/**
 * The forecast chart, drawn to `docs/design/chart-treatment.md`: a P10–P90 band
 * as a 10% wash with hairline bounds, the median on top, measured actuals in
 * near-ink last, a horizon rule where the measurements stop, and the table twin
 * the treatment requires of every chart.
 *
 * **The legend is not here, and since 2026-08-11 it is not this component's at
 * all.** The owner's design round put it behind the (i) that already carries the
 * chart's description, so the caller renders `forecast-chart-legend.tsx` into
 * that popover and this file draws only what is on the canvas. The treatment's
 * rule is discharged one press away rather than under the plot — a legend in
 * every state, not a legend on every chart (`docs/design/chart-treatment.md`,
 * "Legend").
 *
 * Presentational only — no fetching, no domain imports. Points arrive as plain
 * ISO strings and numbers, which branded `UtcIsoTimestamp` values satisfy.
 *
 * **The numbers carry the chart's display unit, and the `unit` prop names it**
 * (#291). Absent, they are kW, which is what every value in this product is
 * stored, served and schema'd in. Present, they are percentages of capacity,
 * already normalised by the caller at the panel seam — a ~4 kW site overlaid on
 * a ~330 kW fleet is a flat line on an absolute axis, and re-expressing both
 * against their own capacity is what makes the pair readable on one scale
 * (`docs/design/chart-treatment.md`, "One value axis"). The unit is presentation
 * and reaches this component's arithmetic exactly twice: the percent axis's
 * fixed maximum, and the chrome that says which unit is showing. Everything
 * between is unit-agnostic, which is why the `*Kw` field spellings are
 * unchanged — a rename is its own change — and the contract that the values
 * carry the *selected* unit is stated on `ForecastChartPoint`
 * (`chart-series.ts`).
 *
 * Two rules from the token preview carry over: no literal colours or sizes
 * (every visual value is a class consuming a token, in `charts.css`), and the
 * numbers below are geometry — SVG user units, and values in the display unit
 * above — not styling.
 *
 * **A null value breaks its line, and is never bridged.** A missing band or
 * measurement inside the series is a partial result and reads as one: band and
 * actuals are drawn once per contiguous run, so a straight segment is never
 * painted across a gap to imply a value that was never modelled or measured
 * (`docs/standards/error-handling.md` rule 5; `docs/tech-debt.md`, 2026-07-31).
 * A run left with a single sample becomes a marker rather than disappearing —
 * `forecast-chart-marks.tsx` holds that rule. It is a rule about *nulls* rather
 * than about gaps in general: an hour absent from the series carries no null for
 * a run to break at, so the marks are still drawn across it — `contiguousRuns`
 * in `chart-series.ts` says why, and `docs/tech-debt.md` (2026-08-11,
 * "`contiguousRuns` splits on array adjacency, not on time adjacency") owns it.
 *
 * **An overlay is one more series, not a second chart.** The optional `overlay`
 * prop puts a second series on the same value axis in slot 2 — the treatment's
 * fixed categorical order, slot 1 reserved for the forecast everywhere in the
 * product. One axis, never two: a second y-scale would invent a correlation the
 * data does not contain (`docs/design/chart-treatment.md`). It is joined onto
 * this series' x-domain once and then flows to the mark, the table column and
 * the readout from that one join. The legend takes its label straight off the
 * same `ChartOverlaySeries` this prop carries, so the two cannot disagree about
 * what the overlay is *called*; what the join decides is what it *says at an
 * hour*, which no legend row asks.
 *
 * **Loading is a mark on the canvas, not a sentence over it** (#448) — one more
 * path inside the plot, a stylised solar day that traces itself and restarts
 * (`chart-loading-curve.ts` for the shape, `charts.css` for the motion). A
 * notice *above* the chart changes the panel's height when it arrives and again
 * when it goes, so the page jumps twice per read; a mark inside the plot
 * occupies the box the chart already has. It is decoration to assistive
 * technology, and the state stays machine-readable through `aria-busy` on
 * `.fleet-panel-body` (`apps/web/src/dashboard/fleet-panel-body.tsx`, and
 * `docs/standards/react.md`'s Pending bullet).
 *
 * **A total failure is an overlay too, in the same box** (#452): a warning
 * triangle, a sentence and the recourse, positioned inside the figure for the
 * reason the loading trace is drawn inside the plot — an absolutely positioned
 * child cannot change the figure's height, so nothing on the page moves when the
 * state arrives or leaves. `forecast-chart-error.tsx` draws it and holds the
 * argument for why it is not `PanelError`; the wording is the caller's, because
 * this folder spells no state copy of its own.
 *
 * `loading` and `error` are never both set. The caller's state arms are mutually
 * exclusive by construction — a read is out, or it came back and failed — and
 * that is deliberately *not* re-enforced here: this component would have to
 * invent a resolution for a combination no caller can produce, and a mode flag
 * over two independent by-presence props is the shape
 * `docs/standards/structure.md` rule 7 refuses. Two props rather than one
 * `state` union for the same reason they are two mechanisms: the wait is a
 * `<path>` among the marks, the failure is text-bearing HTML over the figure.
 *
 * **The readout has one source of truth, and it is not this file.** Pointer and
 * keyboard both settle on an `activeIndex`, which
 * `forecast-chart-hover-boundary.tsx` holds and `forecast-chart-hover.tsx`
 * draws, so there is no separate keyboard rendering path to drift from the hover
 * one. The pointer carries one thing the keyboard cannot — a continuous position
 * the panel follows and the crosshair ignores — and it is a second field beside
 * the index rather than a second selection. It sits one level down rather than
 * here because moving the panel must not re-run this body.
 *
 * **The chart is drawn 1:1 with the width it is rendered at.** `useChartWidth`
 * measures the figure and the view box takes that width, so one SVG user unit is
 * one pixel and an axis label is the same size here as everywhere else on the
 * page. The height does not follow: `CHART_VIEW_BOX_HEIGHT` is an owned
 * constant, because a value axis that rescaled on every resize would be a
 * different chart at every window size. The unit is the one thing allowed to
 * rescale it, because switching unit is a reader asking for a different reading
 * rather than a window changing size.
 *
 * **The table twin is a panel of its own, after the figure** — the owner's
 * 2026-08-11 ask. It is the same numbers in another form, offered *after* the
 * chart rather than appended to it, so this component returns a fragment: the
 * figure, then the disclosure as its next sibling, both landing in whatever
 * layout the caller provides (`apps/web/src/dashboard/fleet-panel.css`'s
 * `.fleet-panel-body` grid today). There is one disclosure, closed by default,
 * and `forecast-chart-table.tsx` owns the argument for it.
 *
 * **What the figure holds is a stated contract**: the plot and the announcement
 * about it wherever there is a chart to read —
 * `[svg.forecast-chart, p.forecast-chart-readout]`, in that order, with
 * `.forecast-chart-details` as the figure's next sibling. The order is not
 * cosmetic: the readout is the region a reader meets *after* the plot it
 * describes, which is what `docs/design/chart-treatment.md`'s live-region bullet
 * states, and #410 asked for it to be pinned rather than read off this file.
 * `apps/web/src/dashboard/FleetPanel.structure.test.tsx` pins it in every state
 * of the panel.
 *
 * `div.forecast-chart-error` is a **suffix** to that pair in the one state that
 * has it, and a suffix is what keeps the contract a contract: the two elements
 * stay in their order and stay the whole of the figure, and the failure appends
 * rather than displacing either. Last rather than first for the same reason it
 * is an `alert` at all — it announces by arriving, so putting it ahead of the
 * plot would reorder the figure for every reader to serve a state most never
 * reach.
 *
 * **Two names, because there are two things to name**: the disclosure is named
 * by its `<summary>` — what a reader meets while it is closed and what they
 * press — and the table by its `<caption>`, which states which window and which
 * units the numbers are in. Folding the caption into the summary would leave one
 * of the two nameless and the other saying two things at once.
 *
 * **The time of day is a layer, not a sentence.** Hours the whole fleet is dark
 * get a wash behind the series and each UTC midnight a hairline, so the diurnal
 * shape of the curve reads against its cause without a word of copy
 * (`docs/standards/design.md` rule 10). `forecast-chart-context.tsx` draws both;
 * whether an hour is the fleet's night is decided far from here and arrives on
 * the point.
 *
 * This file is composition and nothing else — `forecast-chart-axes.tsx`,
 * `-marks.tsx`, `-context.tsx`, `-hover.tsx` and `-table.tsx` each draw a piece
 * of the treatment and are named after it, well inside
 * `docs/standards/structure.md` rule 4's ceiling. `-legend.tsx` sits in the same
 * folder without being one of this file's pieces: it draws a key for a chart
 * rather than a part of one. `-hover-boundary.tsx` is the one named after
 * something other than a piece of the drawing — it draws no mark, and the seam
 * it marks is where re-rendering stops.
 */

export type {
  ChartOverlayPoint,
  ChartOverlaySeries,
  ForecastChartBand,
  ForecastChartPoint,
} from './chart-series';
export type { ChartErrorNotice } from './forecast-chart-error';

export interface ForecastChartProps {
  /** May be empty — the chart then draws bare chrome; sorted ascending by `validTimeIso`. */
  readonly points: readonly ForecastChartPoint[];
  readonly ariaLabel: string;
  readonly tableCaption: string;
  /**
   * One more series on the same value axis, in its own time base — the chart
   * joins it onto `points`' x-domain, and the caller has already put both in the
   * unit `unit` names. Omitted, the chart renders exactly what it
   * rendered before overlays existed: no mark, no legend row, no table column,
   * and nothing in the readout.
   */
  readonly overlay?: ChartOverlaySeries;
  /**
   * The chart is waiting for its numbers, and says so by drawing rather than by
   * saying anything (#448; the docblock's Loading paragraph above).
   *
   * `true` or absent, never `false`. Every optional prop on this interface is
   * set **by presence**, and that is the contract rather than a style: under
   * `exactOptionalPropertyTypes` an absent optional prop and one explicitly set
   * to `undefined` are different values, and what each promises is about the
   * absent one — a chart rendered without the prop emits exactly what it emitted
   * before that state existed.
   */
  readonly loading?: true;
  /**
   * The chart's data path failed outright, and the figure says so over its own
   * box (#452; the docblock's total-failure paragraph above). By presence, as
   * `loading` is.
   *
   * Which failures reach it is the caller's question and deliberately not asked
   * here: a partial answer still has a chart to draw and must not route into
   * this (`docs/standards/error-handling.md` rule 5), and
   * `apps/web/src/dashboard/FleetPanel.tsx` is where that boundary is drawn.
   */
  readonly error?: ChartErrorNotice;
  /**
   * The values on `points` are percentages of capacity rather than kW, and the
   * chart's chrome says so (#291; the display-unit paragraph above). By
   * presence, as `loading` is.
   *
   * A one-member union rather than a `'kw' | 'percent'` pair or a boolean, so
   * that kW stays the absence and no caller has to spell the default. The
   * caller's own two-state type stops at the panel seam — this folder learns
   * only that a chart is in the other unit, which keeps the dependency direction
   * dashboard → charts.
   */
  readonly unit?: 'percent';
}

export const ForecastChart = (props: ForecastChartProps): ReactElement => {
  const { points } = props;
  const figureRef = useRef<HTMLElement>(null);
  // The figure rather than the svg: the svg's own width is `100%` of this box
  // (`charts.css`), so measuring the container is measuring the chart without
  // asking an element about a size this render is about to give it.
  const width = useChartWidth(figureRef);
  // Joined once and read by every consumer below, so the mark, the table column
  // and the readout can never disagree about what the overlay says at an hour.
  //
  // Memoised for identity rather than for speed: two shallow compares below the
  // boundary watch this object — the reading `ForecastChartHoverBoundary`
  // memoises against it, and through that the memoised tooltip panel — and both
  // survive a re-render of this body only while the join keeps its identity.
  // Rebuilt each time, they would redraw a panel that has nothing new to say.
  const overlay = useMemo<ChartOverlayColumn | undefined>(
    () =>
      props.overlay === undefined
        ? undefined
        : { label: props.overlay.label, values: overlayValuesByIndex(points, props.overlay) },
    [props.overlay, points],
  );
  // An overlay running above the forecast would otherwise be drawn off the top
  // of the plot. With no overlay this is `highestValueKw` unchanged, which is
  // seeded at 0 and so cannot be lowered by the second argument.
  const peakKw = Math.max(
    highestValueKw(points),
    overlay === undefined ? 0 : highestOverlayKw(overlay.values),
  );
  const plot = chartPlot(width);
  // The x mapping, computed once here and read below through `xAt`: it is
  // time-proportional and therefore a property of the series rather than of each
  // mark's index, and a second consumer deriving it again is a second chance to
  // derive it differently.
  // The one place the display unit reaches the arithmetic: a percent axis always
  // shows capacity, where a kW axis has no such landmark and is drawn to its own
  // series (`chart-geometry.ts`'s `percentAxisMax`).
  const percent = props.unit !== undefined;
  const scale: ChartScale = {
    plot,
    axisMaxKw: percent ? percentAxisMax(peakKw) : niceAxisMax(peakKw),
    xs: sampleXs(points, plot),
  };
  const spanHours = seriesSpanHours(points);
  const bandRuns = contiguousRuns(points.length, (index) => points[index]?.band !== undefined);
  // Three series, one rule: each is drawn once per contiguous run of hours it
  // actually has a value for — the median included, since a union x-domain gives
  // it hours with no forecast on them.
  const medianRuns = contiguousRuns(points.length, (index) => points[index]?.medianKw != null);
  const actualRuns = contiguousRuns(points.length, (index) => points[index]?.actualKw != null);
  const lastMeasuredIndex = actualRuns.at(-1)?.indices.at(-1);

  return (
    <>
      <figure className="forecast-chart-figure" ref={figureRef}>
        {/* The chrome, handed down rather than drawn here: the boundary owns the
            `<svg>` these go inside, because it owns the hover state that moves
            the panel over them. They are elements by the time they cross it, so
            a pointer frame reconciles straight past them and never re-runs the
            producers below.

            Draw order is back to front, and the order is the argument: the night
            wash is backmost, since it is what everything else is drawn
            *against*; the day boundaries sit immediately above the grid because
            they are the same kind of thing, chrome the reader consults, and
            belong under every data mark; actuals are drawn last of the data and
            win every overlap, so an added series never covers the measurement;
            and the hover chrome with its pointer target sits above all of it.
            The loading trace is among the marks rather than over them, which
            costs nothing to argue — the only state that renders it is the state
            with no series yet. */}
        <ForecastChartHoverBoundary
          points={points}
          ariaLabel={props.ariaLabel}
          width={width}
          scale={scale}
          spanHours={spanHours}
          overlay={overlay}
          unitLabel={percent ? UNIT_LABEL_PERCENT_OF_CAPACITY : UNIT_LABEL_KW}
        >
          {nightElements(points, scale)}
          {gridElements(scale)}
          {/* The wait, drawn (#448). `pathLength` is normalised to 1 so the dash
              pattern in `charts.css` is a fraction of the path rather than a
              length that would have to be re-derived at every column width, and
              the path is decoration: `aria-hidden`, so the `role="img"` above
              keeps its one name and no reader is told about a curve that means
              nothing. */}
          {props.loading === undefined ? null : (
            <path
              className="forecast-chart-loading-trace"
              d={loadingCurvePath(plot)}
              pathLength={1}
              aria-hidden
            />
          )}
          {dayBoundaryElements(points, scale)}
          {bandElements(points, bandRuns, scale)}
          {boundElements(points, bandRuns, scale)}
          {lastMeasuredIndex === undefined ? null : horizonElements(lastMeasuredIndex, scale)}
          {medianElements(points, medianRuns, scale)}
          {overlay === undefined ? null : overlayElements(overlay.values, scale)}
          {actualsElements(points, actualRuns, scale, lastMeasuredIndex)}
          {xAxisElements(points, scale)}
          {axisTitleElements(scale.plot, percent)}
        </ForecastChartHoverBoundary>
        {/* The total failure, over everything above it and inside the same box
            (#452). After the boundary rather than among the marks because it is
            HTML and they are SVG, and over the plot rather than above it because
            `charts.css` takes it out of flow — the whole of the no-jump claim:
            an absolutely positioned child cannot alter the figure's height. It
            is inside the figure so that a reader who has scrolled to the chart
            finds the explanation where the chart is. */}
        {props.error === undefined ? null : chartErrorOverlay(props.error)}
      </figure>

      {/* The twin, a sibling of the figure rather than inside it: the drawing is
          one thing and the numbers behind a press another (docblock above). The
          caller's grid spaces the two; `charts.css` gives this one its
          surface. */}
      {forecastChartTable({ points, spanHours, caption: props.tableCaption, overlay })}
    </>
  );
};
