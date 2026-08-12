import { useMemo, useRef, type ReactElement } from 'react';
import { chartPlot, niceAxisMax, sampleXs } from './chart-geometry';
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
 * chart's description — in their words, *"the legend can go in the (i)
 * section"* — so the caller renders `forecast-chart-legend.tsx` into that
 * popover and this file draws only what is on the canvas. `FleetPanel.tsx` is
 * the one caller today and owns the two inputs the legend reads, which are the
 * same two facts this body derives for the plot: whether any drawn point carries
 * a band, and the overlay's label. The treatment's rule is unchanged and is now
 * discharged one press away rather than under the plot — a legend in every
 * state, not a legend on every chart (`docs/design/chart-treatment.md`,
 * "Legend").
 *
 * Presentational only — no fetching, no domain imports. Points arrive as plain
 * ISO strings and kW numbers, which branded `UtcIsoTimestamp` values satisfy.
 *
 * Two rules from the token preview carry over: no literal colours or sizes
 * (every visual value is a class consuming a token, in `charts.css`), and the
 * numbers below are geometry — SVG user units and kW — not styling.
 *
 * **A null value breaks its line, and is never bridged.** A missing band or a
 * missing measurement inside the series is a partial result and reads as one:
 * band and actuals are drawn once per contiguous run, so a straight segment is
 * never painted across a gap to imply a value that was never modelled or
 * measured (`error-handling.md` rule 5; `docs/tech-debt.md`, 2026-07-31). A run
 * left with a single sample has no path to stroke and becomes a marker instead
 * of disappearing — `forecast-chart-marks.tsx` holds that rule and its
 * reasoning. A rule about *nulls* rather than about gaps in general, because
 * that is its reach: an hour absent from the series carries no null for a run to
 * break at, so the marks are still drawn across it. `contiguousRuns` in
 * `chart-series.ts` says why, and `docs/tech-debt.md` (2026-08-11,
 * "`contiguousRuns` splits on array adjacency, not on time adjacency") owns it.
 *
 * **An overlay is one more series, not a second chart.** The optional `overlay`
 * prop puts a second series on the same kW axis in slot 2 — the treatment's
 * fixed categorical order, with slot 1 reserved for the forecast everywhere in
 * the product. One axis, never two: a second y-scale would invent a correlation
 * the data does not contain (`docs/design/chart-treatment.md`). It is joined
 * onto this series' x-domain once and then flows to the mark, the table column
 * and the readout from that one join. The legend's row for it is the one surface
 * that no longer reads the join, because it no longer renders here — it takes
 * the label straight off the same `ChartOverlaySeries` this prop carries, so the
 * two still cannot disagree about what the overlay is *called*; what the join
 * decides is what the overlay *says at an hour*, and no legend row asks that.
 *
 * **Loading is a mark on the canvas, not a sentence over it.** The optional
 * `loading` prop puts one more path inside the plot — a stylised solar day that
 * traces itself and restarts, `chart-loading-curve.ts` for the shape and
 * `charts.css` for the motion. The owner asked for it in those terms on
 * 2026-08-12 (*"graph loading state needs to be visual not words"*), and what
 * makes it this component's rather than the panel's is the thing they objected
 * to next: a notice above the chart changes the panel's height when it arrives
 * and again when it goes, so the page jumps twice per read. A mark *inside* the
 * plot occupies the box the chart already has. It is decoration to assistive
 * technology, and the state stays machine-readable where the panel can carry it
 * without words — `aria-busy` on `.fleet-panel-body`
 * (`dashboard/fleet-panel-body.tsx`, and `docs/standards/react.md`'s Pending
 * bullet, amended by the same round). Absent, this prop draws nothing at all,
 * which is the same contract `overlay` keeps.
 *
 * **The readout has one source of truth, and since #331 it is not this file.**
 * Pointer and keyboard both settle on an `activeIndex`, which
 * `forecast-chart-hover-boundary.tsx` holds — the child this component wraps
 * its chrome in — and `forecast-chart-hover.tsx` draws whatever that index
 * says. There is no separate keyboard rendering path to drift from the hover
 * one, which is what the treatment's "keyboard focus shows exactly what hover
 * shows" costs when it is designed in rather than retrofitted. The pointer
 * carries one thing the keyboard cannot — a continuous position, which the
 * panel follows and the crosshair ignores (#284 D7) — and it is a second field
 * beside the index rather than a second selection, so neither route can end up
 * reading a different sample. It sits one level down rather than here because
 * moving the panel must not re-run this body; that is the whole of what moved,
 * and the single source of truth is the thing the move was careful to keep.
 *
 * **The chart is drawn 1:1 with the width it is rendered at.** `useChartWidth`
 * measures the figure and the view box takes that width, so one SVG user unit
 * is one pixel and the chrome stops scaling with the panel — an axis label is
 * the same size here as everywhere else on the page. The height does not follow:
 * `CHART_VIEW_BOX_HEIGHT` is an owned constant, because a kW axis that rescaled
 * on every resize would be a different chart at every window size.
 *
 * **The table twin is a panel of its own, after the figure** — the owner's
 * 2026-08-11 ask, in their words: *"i think the raw data could actually live in
 * a collapsible panel rather than inline with the graph etc"*. It has sat behind
 * a closed `<details>` since #284 D3 and still does; what moved is where the
 * disclosure sits. Inside the `<figure>` it was filed alongside the legend as
 * one more piece of the drawing's furniture, which is not what it is — it is the
 * same numbers in another form, offered *after* the chart rather than appended
 * to it. So this component returns a fragment: the figure, then the disclosure
 * as its next sibling, both landing in whatever layout the caller provides
 * (`dashboard/fleet-panel.css`'s `.fleet-panel-body` grid today). Nothing about
 * the fold itself changed — there is one disclosure, closed by default, and
 * `forecast-chart-table.tsx` still owns the argument for it.
 *
 * **What the figure holds is now a two-element contract**, and both moves of
 * 2026-08-11 are what make it worth writing down: the table twin left for the
 * sibling slot and the legend left for the (i), so a `<figure>` that once held
 * four things holds the plot and the announcement about it and nothing else —
 * `[svg.forecast-chart, p.forecast-chart-readout]`, in that order, with
 * `.forecast-chart-details` as the figure's next sibling. The order is not
 * cosmetic. The readout is the region a reader meets *after* the plot it
 * describes, which is the arrangement `docs/design/chart-treatment.md`'s
 * live-region bullet states, and #410 asked for it to be pinned rather than left
 * to be read off this file. `dashboard/FleetPanel.structure.test.tsx` is where
 * it is pinned, in every state of the panel.
 *
 * **Two names, because there are two things to name.** The standing aria
 * decision, written down as a decision rather than left to be read off the
 * markup: the disclosure is named by its `<summary>` ("Raw data") — what a
 * reader meets while it is closed and what they press — and the table is named
 * by its `<caption>`, which states which window and which units the numbers are
 * in. That pair is why the caption is not folded into the summary: a summary
 * names the *disclosure*, and taking it for the table would leave one of the two
 * nameless and the other saying two things at once. Neither name ever came from
 * the figure, so leaving it costs the pair nothing.
 *
 * **The time of day is a layer, not a sentence.** Hours the whole fleet is dark
 * get a wash behind the series and each UTC midnight gets a hairline, so the
 * diurnal shape of the curve reads against its cause without a word of copy
 * (`design.md` rule 10). `forecast-chart-context.tsx` draws both; whether an
 * hour is the fleet's night is decided far from here and arrives on the point.
 *
 * This file is composition and nothing else. The plot's chrome, its data marks,
 * the hover layer and the table twin sit beside it — `forecast-chart-axes.tsx`,
 * `-marks.tsx`, `-context.tsx`, `-hover.tsx`, `-table.tsx` — each a piece of the
 * treatment named after the piece it draws,
 * and each well inside `structure.md` rule 4's ceiling. `-legend.tsx` is still
 * in that folder and is no longer one of this file's pieces: it draws a key for
 * a chart rather than a part of one, and its caller is the panel that opens the
 * (i). `-hover-boundary.tsx`
 * joined them in #331 and is the one named after something other than a piece
 * of the drawing: it draws no mark of its own, and the seam it marks is where
 * re-rendering stops.
 */

export type {
  ChartOverlayPoint,
  ChartOverlaySeries,
  ForecastChartBand,
  ForecastChartPoint,
} from './chart-series';

export interface ForecastChartProps {
  /** May be empty — the chart then draws bare chrome; sorted ascending by `validTimeIso`. */
  readonly points: readonly ForecastChartPoint[];
  readonly ariaLabel: string;
  readonly tableCaption: string;
  /**
   * One more series on the same kW axis, in its own time base — the chart joins
   * it onto `points`' x-domain. Omitted, the chart renders exactly what it
   * rendered before overlays existed: no mark, no legend row, no table column,
   * and nothing in the readout.
   */
  readonly overlay?: ChartOverlaySeries;
  /**
   * The chart is waiting for its numbers, and says so by drawing rather than by
   * saying anything (#448; the docblock's Loading paragraph above).
   *
   * `true` or absent, never `false`: under `exactOptionalPropertyTypes` an
   * absent optional prop and one explicitly set to `undefined` are different
   * values, and the contract this shares with `overlay` is about the *absent*
   * one — a chart rendered without this prop emits exactly what it emitted
   * before the loading state existed. So callers set it by presence
   * (`dashboard/fleet-panel-body.tsx`'s `fleetChart`) rather than passing a flag
   * that has a false value to forget to handle.
   */
  readonly loading?: true;
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
  // Memoised for identity rather than for speed, and still so after #331 moved
  // the hover boundary down: this body no longer runs on a pointer frame, but it
  // does run whenever the fleet, the range or the parent gives it a reason to,
  // and two shallow compares below the boundary are watching this object. The
  // reading `ForecastChartHoverBoundary` memoises against it, and through that
  // the memoised tooltip panel, both survive such a re-render only while the
  // join keeps its identity — rebuilt each time, they would rebuild with it and
  // redraw a panel that has nothing new to say. The dependencies are the honest
  // ones: a new series, or a new x-domain to join it onto, really is a new join.
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
  // The x mapping, computed once here and read by everything below it through
  // `xAt`. Once, because it is time-proportional (#325) and therefore a property
  // of the series rather than of each mark's index — a second consumer deriving
  // it again is a second chance to derive it differently.
  const scale: ChartScale = {
    plot,
    axisMaxKw: niceAxisMax(peakKw),
    xs: sampleXs(points, plot),
  };
  const spanHours = seriesSpanHours(points);
  const bandRuns = contiguousRuns(points.length, (index) => points[index]?.band !== undefined);
  // Three series, one rule: each is drawn once per contiguous run of hours it
  // actually has a value for. The median joined that rule in #264, when a union
  // x-domain gave it hours with no forecast on them.
  const medianRuns = contiguousRuns(points.length, (index) => points[index]?.medianKw != null);
  const actualRuns = contiguousRuns(points.length, (index) => points[index]?.actualKw != null);
  const lastMeasuredIndex = actualRuns.at(-1)?.indices.at(-1);

  return (
    <>
      <figure className="forecast-chart-figure" ref={figureRef}>
        {/* The chrome, handed down rather than drawn here: the boundary owns the
            `<svg>` these go inside, because it owns the hover state that moves
            the panel over them (#331). They are elements by the time they cross
            it, so a pointer frame re-renders the boundary and reconciles
            straight past them — and, more to the point, never re-runs the
            producers below.

            Draw order is back to front: night wash → grid → loading trace →
            day boundaries → band → bounds → horizon → median → overlay →
            actuals → marker. The trace is in that list rather than above it
            because it is drawn among the marks and not over them, and its place
            costs nothing to argue: the only state that renders it is the state
            with no series yet, so there is nothing below it to hide and nothing
            above it to be hidden by. The
            wash is the backmost thing on the canvas — it is what everything else
            is drawn *against*, so the grid reads over it rather than being
            tinted out by it — and the day boundaries sit immediately above the
            grid because they are the same kind of thing, chrome the reader
            consults, and belong under every data mark. Actuals are drawn last of
            the data and win every overlap — an added series never covers the
            measurement — and the hover chrome and its pointer target sit above
            all of it. */}
        <ForecastChartHoverBoundary
          points={points}
          ariaLabel={props.ariaLabel}
          width={width}
          scale={scale}
          spanHours={spanHours}
          overlay={overlay}
        >
          {nightElements(points, scale)}
          {gridElements(scale)}
          {/* The wait, drawn (#448). Immediately over the grid and under
              everything else, which costs nothing to reason about because a
              loading chart has no marks to compete with — the state that renders
              this is the state whose series has not arrived. `pathLength` is
              normalised to 1 so the dash pattern in `charts.css` is a fraction
              of the path rather than a length that would have to be re-derived
              at every column width, and the path itself is decoration: it is
              `aria-hidden`, so the `role="img"` above keeps its one name and no
              reader is told about a curve that means nothing. */}
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
          {axisTitleElements(scale.plot)}
        </ForecastChartHoverBoundary>
      </figure>

      {/* The twin, outside the figure since 2026-08-11 and a sibling of it: the
          drawing is one thing and the numbers behind a press are another, which
          is what the owner asked the layout to say (docblock above). It is the
          caller's grid that spaces the two, and `charts.css` that gives this one
          its surface. */}
      {forecastChartTable({ points, spanHours, caption: props.tableCaption, overlay })}
    </>
  );
};
