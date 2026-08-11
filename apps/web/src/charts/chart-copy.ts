/*
 * What a chart says about itself — its chrome wording.
 *
 * A deliberate sibling of `apps/web/src/dashboard/state-copy.ts` rather than an
 * extension of it: that module owns async-state copy (waiting, empty, failed)
 * read by the content column, this one owns the words a plot prints about its own
 * frame, read by charts and their table twins. Different surfaces, different
 * consumers, free to diverge.
 *
 * The clock is an obligation, not a decoration. `docs/design/chart-treatment.md`
 * ("The time axis") settles the axis on UTC and accepts a visible cost — through
 * British and Irish summer time the modelled peak sits an hour left of local
 * solar noon — on the condition that every chart states the clock somewhere in
 * its chrome. Holding the phrase here is what makes that condition inheritable:
 * the next chart and the next table twin consume it rather than each inventing a
 * spelling of "UTC", which is how one surface ends up silently unlabelled.
 *
 * **One phrase now discharges it, in two places** (#284 D10). This module used
 * to export a second clock string as well, floated in the plot's top-right
 * corner as a note about the whole chart — `docs/design/chart-treatment.md`'s
 * "The time axis" carries what it said and why it went. The axis titles now run
 * parallel to their axes, so the time axis is titled directly beneath the ticks
 * it governs, and the words it is titled with are these: the clock is stated
 * where the times are, and the two surfaces that state it read from one
 * constant rather than from two that agree (`architecture.md` rule 9).
 *
 * Out of scope on purpose: `Power (kW)` and the P10/Median/P90/Actual column
 * headers stay in the components that render them. Those name the data, not the
 * chrome — a chart that changed what it plots would have to change them anyway,
 * so centralising them would collect strings that share only a file, not an
 * intent (`structure.md` rule 7).
 *
 * `forecast horizon` was on that list until the owner's 2026-08-11 design round
 * ([#429](https://github.com/TomBennett-Lloyd/cumulo/issues/429)) deleted the
 * words from the canvas. The dashed rule marks the threshold without captioning
 * it, so there is no longer a string anywhere for this module to decline —
 * naming it here would be this file remembering a word the charts stopped
 * saying.
 */

/**
 * The clock the time axis runs on, carried by both surfaces that show it: the
 * axis title under the chart's own time axis, and the table twin's time column.
 */
export const TIME_COLUMN_HEADER = 'Time (UTC)';
