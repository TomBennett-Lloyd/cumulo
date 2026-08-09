import { fleetCapacityKw, type Site } from '@cumulo/shared';

import type { RangeHours } from '../data/fleet-data-source';
import { rangeLabel } from './range-picker';
import { capacityLabel } from './site-format';

/*
 * What the fleet panel says about itself: its subtitle, how the chart names the
 * window it is drawing, the two names its chart carries, and the one line
 * summarising the fleet.
 *
 * The third copy module in `apps/web`, and the split between the three is by
 * subject rather than by size. `state-copy.ts` owns what the app says while it
 * is waiting or after something failed — one vocabulary because it is one
 * reader, and a contract test sweeps the app to keep it that way.
 * `charts/chart-copy.ts` owns the words a chart says about *itself*, its clock
 * above all. What is left is a panel's own description of its own content, which
 * is neither, and which is what lives here.
 *
 * It moved out of `FleetPanel.tsx` when that file hit `structure.md` rule 4's
 * 300-line ceiling — and the copy was the right thing to move rather than the
 * nearest thing: every function below is pure, takes what it reads, and is the
 * part of the panel most likely to be reviewed *as wording*, which is far easier
 * to do when the whole vocabulary reads top to bottom in one file than when each
 * phrase sits inside the JSX that happens to render it.
 *
 * **The capability arms stay whole here.** `chartCopy` and the two subtitles
 * below are written out per capability rather than assembled from a conditional
 * clause, so the honesty rule #150 asked for is auditable by reading them side
 * by side: the phrase "simulated actuals" appears only in the arm a source with
 * `fleetActuals` reaches. That is the reason this module is copy-with-branches
 * rather than a bag of constants.
 */

/*
 * Two window *captions* used to head this module, for the arm that rendered no
 * picker. #284 D5 deleted both along with the (i) that carried them: the picker
 * renders wherever there is a window to choose now, and a control states its
 * window better than a sentence a reader has to press for. What is left is the
 * labels below, which name a window inside the chart's own names.
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
  'Every site’s forecast, summed hour by hour, with the fleet’s P10–P90 band and simulated actuals (the demo fleet has no real inverters).';

export const SUBTITLE_FORECAST_ONLY =
  'Every site’s forecast for the hours ahead, summed hour by hour, with the fleet’s P10–P90 band.';

/** Plural is the fleet's usual state; the singular exists so the demo's first site reads right. */
const siteCountLabel = (count: number): string =>
  `${String(count)} ${count === 1 ? 'site' : 'sites'}`;

/**
 * The fleet in one line: how many, and how much of it there is.
 *
 * Capacity comes from `@cumulo/shared` rather than a sum written here, because
 * fleet arithmetic lives there (`architecture.md` rule 3) and a second sum would
 * be a second definition of the fleet's size.
 */
export const fleetStatsLine = (sites: readonly Site[]): string =>
  `${siteCountLabel(sites.length)} · ${capacityLabel(fleetCapacityKw(sites))} installed`;

/**
 * The window the chart's labels name.
 *
 * Three answers rather than two, because the flags move independently and #264
 * made the third combination real: a chosen look-back names itself, and without
 * one the window is the bare horizon or — once the source carries actuals — the
 * chosen span of measured hours with the forecast running off the end of it.
 * Named from what is *drawn*, not from what was asked for: a source with actuals
 * plots hours before now whether or not it can look back, and "next 24 h" over
 * those hours is the chart misdescribing itself.
 *
 * The middle arm takes the range rather than spelling out 24, because #284 D5
 * gave that arm a picker: its actuals really do span whatever window the reader
 * chose. Its forecast half is named without a number on purpose — the fan-out
 * asks for the same window, but what comes back is only the hours the horizon
 * actually reaches, so "and the forecast ahead" claims exactly as much as the
 * chart can show.
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
 * `fleetActuals` reaches. An accessible name is copy like any other, and it is
 * the copy easiest to leave promising something the data cannot show — and
 * "simulated" is load-bearing in it, because these hours are synthesised by the
 * forecast service (#264) rather than metered off an inverter.
 */
export const chartCopy = (windowText: string, hasActuals: boolean): ChartCopy =>
  hasActuals
    ? {
        ariaLabel: `Fleet forecast and simulated actuals, ${windowText}`,
        tableCaption: `Table view — fleet forecast and simulated actuals, ${windowText}, kW`,
      }
    : {
        ariaLabel: `Fleet forecast, ${windowText}`,
        tableCaption: `Table view — fleet forecast, ${windowText}, kW`,
      };
