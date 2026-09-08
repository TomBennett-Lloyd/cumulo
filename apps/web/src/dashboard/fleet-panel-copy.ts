import { fleetCapacityKw, type Site } from '@cumulo/shared';

import { UNIT_LABEL_KW, UNIT_LABEL_PERCENT_OF_CAPACITY } from '../charts/chart-copy';
import type { RangeHours } from '../data/fleet-data-source';
import type { ChartUnit } from './chart-unit';
import { rangeLabel } from './range-picker';
import { capacityLabel } from './site-format';

/*
 * What the fleet chart says about itself: its subtitle, how it names the window
 * it is drawing, the two names it carries, and the one line summarising the
 * fleet.
 *
 * The third copy module in `apps/web`, and the split between the three is by
 * subject rather than by size. `state-copy.ts` owns what the app says while it
 * is waiting or after something failed — one vocabulary because it is one
 * reader, and a contract test sweeps the app to keep it that way.
 * `apps/web/src/charts/chart-copy.ts` owns the words a chart says about
 * *itself*, its clock above all. What is left is a panel's own description of
 * its own content, which is what lives here — pure functions, kept out of
 * `FleetPanel.tsx` because copy is far easier to review *as wording* when the
 * whole vocabulary reads top to bottom in one file.
 *
 * **The capability arms stay whole here.** `chartCopy` and the two subtitles
 * below are written out per capability rather than assembled from a conditional
 * clause, so the honesty rule #150 asked for is auditable by reading them side
 * by side: the phrase "simulated actuals" appears only in the arm a source with
 * `fleetActuals` reaches. That is the reason this module is copy-with-branches
 * rather than a bag of constants.
 */

/**
 * How the chart's labels name a bare forward horizon.
 *
 * The number is spelled out rather than derived from the panel's default range,
 * and it stays honest for one reason worth stating: this arm is reached only by
 * a source with neither fleet capability, which renders no picker at all, so
 * nothing can ever call `setRange` and the window really is the default. A
 * label assembled from a constant would instead silently rewrite itself if that
 * default moved.
 */
const HORIZON_WINDOW_LABEL = 'next 24 h';

export const SUBTITLE_WITH_ACTUALS =
  'Every site’s forecast, summed hour by hour, with the fleet’s simulated P10–P90 band and simulated actuals (the demo fleet has no real inverters).';

export const SUBTITLE_FORECAST_ONLY =
  'Every site’s forecast for the hours ahead, summed hour by hour, with the fleet’s simulated P10–P90 band.';

/** Plural is the fleet's usual state; the singular exists so the demo's first site reads right. */
const siteCountLabel = (count: number): string =>
  `${String(count)} ${count === 1 ? 'site' : 'sites'}`;

/**
 * The fleet in one line: how many, and how much of it there is.
 *
 * The owner asked for it back on 2026-08-11, having seen the row without it: a
 * chart of a fleet is not a statement of how large that fleet is. It is now the
 * only chrome that states the fleet's size unprompted — `state-copy.ts`'s
 * `partialAggregateNotice` writes the same total out, but only over the hours
 * the aggregate falls short of it, which is a state rather than a standing fact.
 *
 * Capacity comes from `@cumulo/shared` rather than a sum written here, because
 * fleet arithmetic lives there (docs/standards/architecture.md rule 3) and a
 * second sum would be a second definition of the fleet's size.
 *
 * The line ends without the word "installed" (docs/standards/design.md rule 2:
 * chrome earns its place) — a kW figure under a heading reading "Fleet forecast"
 * is the fleet's capacity, and the unit says which quantity it is.
 *
 * **It does not follow the chart's unit, and that is a decision rather than an
 * oversight** (#291). The chart's toggle moves the axis, the table's numbers and
 * the caption that names them; this line states the fleet's *installed
 * capacity*, which is the divisor those percentages are taken against — in
 * percent mode it is the thing 100% means. A capacity restated as "100% of
 * capacity" would say nothing, and one restated as a percentage of itself would
 * be a number with no content. So kW here beside a percent axis is informative
 * rather than inconsistent, and the count beside it was never in a unit at all.
 *
 * **It does not truncate.** Below a measured container width the whole line is
 * hidden and the row carries the heading and the two controls (`fleet-panel.css`
 * owns that width and derives it). Half a number is worse than no number: a
 * truncated fleet size is a figure a reader can misread rather than one they can
 * see is absent.
 */
export const fleetStatsLine = (sites: readonly Site[]): string =>
  `${siteCountLabel(sites.length)} · ${capacityLabel(fleetCapacityKw(sites))}`;

/**
 * The window the chart's labels name.
 *
 * Three answers rather than two, because the flags move independently: a chosen
 * look-back names itself, and without one the window is the bare horizon or —
 * once the source carries actuals — the chosen span of measured hours with the
 * forecast running off the end of it. Named from what is *drawn*, not from what
 * was asked for: a source with actuals plots hours before now whether or not it
 * can look back, and naming a forward-only window over those hours is the chart
 * misdescribing itself.
 *
 * The middle arm takes the range rather than spelling a number, because that arm
 * has a picker and its actuals really do span whatever window the reader chose.
 * Its forecast half is named without a number on purpose — the read asks for the
 * same window, but what comes back is only the hours the horizon actually
 * reaches, so "and the forecast ahead" claims exactly as much as the chart can
 * show.
 */
export const windowLabel = (
  range: RangeHours,
  canLookBack: boolean,
  hasActuals: boolean,
): string => {
  if (canLookBack) {
    return `${rangeLabel(range)} range`;
  }
  return hasActuals ? `past ${rangeLabel(range)} and the forecast ahead` : HORIZON_WINDOW_LABEL;
};

/** The chart is named twice — for assistive technology, and above its table twin. */
export interface ChartCopy {
  readonly ariaLabel: string;
  readonly tableCaption: string;
}

/**
 * Both of the chart's names, written out per capability rather than assembled
 * from a conditional clause.
 *
 * Two whole arms so the honesty rule is auditable by reading them side by side:
 * the words "simulated actuals" appear only in the arm a source with
 * `fleetActuals` reaches. An accessible name is the copy easiest to leave
 * promising something the data cannot show, and "simulated" is load-bearing in
 * it, because these hours are synthesised by the forecast service rather than
 * metered off an inverter.
 *
 * **The caption is the table's unit seam and the accessible name is not** (#291,
 * the owner's routing). A table of numbers with no axis beside it has nowhere
 * else to say what its columns are counted in, so the unit is the last clause of
 * the caption in both arms — from `apps/web/src/charts/chart-copy.ts`'s two
 * labels, which the value axis's title and the spoken readout's frame read too,
 * so the three surfaces cannot disagree about which unit is showing. The
 * `ariaLabel` stays unit-less because the readout inside that chart speaks the
 * unit with every sample it announces: naming it here as well would make a
 * reader hear it twice on the way to a number they have not asked for yet.
 */
export const chartCopy = (windowText: string, hasActuals: boolean, unit: ChartUnit): ChartCopy => {
  const unitLabel = unit === 'kw' ? UNIT_LABEL_KW : UNIT_LABEL_PERCENT_OF_CAPACITY;

  return hasActuals
    ? {
        ariaLabel: `Fleet forecast and simulated actuals, ${windowText}`,
        tableCaption: `Table view — fleet forecast and simulated actuals, ${windowText}, ${unitLabel}`,
      }
    : {
        ariaLabel: `Fleet forecast, ${windowText}`,
        tableCaption: `Table view — fleet forecast, ${windowText}, ${unitLabel}`,
      };
};
