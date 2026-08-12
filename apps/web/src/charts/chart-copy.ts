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
 * **The unit's two spellings joined the clock here in #291, and the argument
 * that used to decline them is what changed.** `kW` was a word about the data
 * while it was the only answer: a chart that changed what it plots would have
 * changed it anyway, so it stayed in the component that rendered it. A unit a
 * reader can *switch* is not that — it is state-dependent chrome, and three
 * surfaces have to agree about which one is showing or the same number reads as
 * two different quantities: the value axis's title, the table twin's caption,
 * and the spoken readout's frame. So the two labels have one owner here and
 * each surface composes the words around them.
 *
 * Out of scope on purpose, and still: `Power (…)`'s *title* framing, which is
 * how `forecast-chart-axes.tsx` arranges a label along an axis rather than a
 * spelling of the unit, and the P10/Median/P90/Actual column headers, which
 * name the data. Those are unchanged by the toggle — centralising them would
 * collect strings that share only a file, not an intent (`structure.md` rule
 * 7).
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

/**
 * The unit a chart's numbers are in while the panel is showing absolute power —
 * the axis title's `Power (kW)`, the table caption's units, and the unit word
 * the spoken readout frames its rows with.
 */
export const UNIT_LABEL_KW = 'kW';

/**
 * The same, while the panel is showing each series against its own capacity.
 *
 * It names the quantity as well as the unit, which is why the axis title is
 * this label alone where the kW title wraps it in `Power (…)`: a percentage of
 * capacity *is* the reading, and `Power (% of capacity)` would name it twice.
 * The reason there are two units to name at all is the site overlay — a ~4 kW
 * site against a ~330 kW fleet is a flat line on an absolute axis — and the
 * transform is presentation only: storage, the API and `@cumulo/shared` are kW
 * throughout.
 */
export const UNIT_LABEL_PERCENT_OF_CAPACITY = '% of capacity';
