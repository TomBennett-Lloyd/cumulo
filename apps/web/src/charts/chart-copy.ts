/*
 * What a chart says about itself — its chrome wording.
 *
 * A deliberate sibling of `apps/web/src/dashboard/state-copy.ts` rather than an
 * extension of it: that module owns async-state copy (waiting, empty, failed)
 * read by the panel column, this one owns the words a plot prints about its own
 * frame, read by charts and their table twins. Different surfaces, different
 * consumers, free to diverge.
 *
 * The clock label is an obligation, not a decoration. `docs/design/chart-treatment.md`
 * ("The time axis") settles the axis on UTC and accepts a visible cost — through
 * British and Irish summer time the modelled peak sits an hour left of local
 * solar noon — on the condition that every chart states the clock somewhere in
 * its chrome. Holding both strings here is what makes that condition inheritable:
 * the next chart and the next table twin consume these rather than each inventing
 * a spelling of "UTC", which is how one surface ends up silently unlabelled.
 *
 * Out of scope on purpose: `kW`, `forecast horizon`, and the P10/Median/P90/Actual
 * column headers stay in the components that render them. Those name the data, not
 * the chrome — a chart that changed what it plots would have to change them anyway,
 * so centralising them would collect strings that share only a file, not an intent
 * (`structure.md` rule 7).
 */

/** Printed in the plot's chrome, mirroring the `kW` axis title at the other end. */
export const CHART_CLOCK_LABEL = 'Times in UTC';

/** The table twin's time column, which carries the same clock as the axis. */
export const TIME_COLUMN_HEADER = 'Time (UTC)';
