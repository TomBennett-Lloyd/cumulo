/*
 * What the panel column says when it has nothing, is waiting, or has failed.
 *
 * One module rather than a string beside each component, for the same reason
 * `site-format.ts` is one module: two panels telling the same reader about the
 * same absence in two different voices is a defect, not a variation
 * (`structure.md` rule 7). Collecting them also makes the wording reviewable as
 * wording — the whole vocabulary of the column's empty and failed states reads
 * top to bottom here, which is not true when each phrase lives inside the JSX
 * that happens to render it.
 *
 * The word "active" is deliberately gone. "No active sites yet" asserted a
 * distinction the data model does not make — there is no inactive site to
 * contrast with — and a sentence that implies a state the system cannot be in
 * teaches the reader something false (#104's finding).
 *
 * Scope: this covers the panel column's state copy. The chart-clock wording
 * #104 also names ("as of", the hour labels' zone) stays with the chart, and
 * that remainder of #104 should land here when it is settled.
 */

/** The empty fleet is the demo's invitation, so it names the next action. */
export const EMPTY_FLEET_MESSAGE = 'No sites yet — click anywhere on the map to add the first one.';

/**
 * The same invitation for a fleet that already has sites.
 *
 * Separate from {@link EMPTY_FLEET_MESSAGE} rather than shared with a flag:
 * one is the whole answer a reader gets when there is nothing else on screen,
 * the other is a hint beside a chart. They are free to diverge.
 */
export const ADD_SITE_HINT =
  'Click anywhere on the map to add a site and watch its first forecast arrive.';

/** The site listing itself is loading — the column has no rows to show yet. */
export const LOADING_FLEET_LABEL = 'Loading the fleet…';

/**
 * The aggregate is being computed, and the verb says so.
 *
 * "Summing" rather than "Loading" because in live mode this really is a paced
 * fan-out across every site, and a reader who is told what is happening waits
 * more happily than one watching a generic wait.
 */
export const LOADING_FLEET_FORECAST_LABEL = 'Summing the fleet’s forecasts…';

/** One site's series is loading; the site is named because the panel can swap. */
export const loadingSiteSeriesLabel = (siteName: string): string =>
  `Loading the forecast for ${siteName}…`;

/** The fan-out succeeded and summed to nothing — an answer, not a failure. */
export const NO_FLEET_FORECAST_MESSAGE = 'No fleet forecast available yet';

/** A site exists but its forecast does not yet — the usual state seconds after creation. */
export const NO_SITE_FORECAST_MESSAGE = 'No forecast available for this site yet';

/**
 * Measured output is absent for the window shown.
 *
 * A notice rather than an error: the forecast beside it is complete and
 * trustworthy, and only the measured half is missing (`error-handling.md` —
 * partial results are labelled partial).
 */
export const NO_MEASUREMENTS_NOTICE = 'No measurements recorded in this range';

/**
 * The first-forecast poll gave up before the pipeline answered.
 *
 * The deadline is a parameter rather than baked into the sentence: the number
 * belongs to the polling hook that enforces it, and a copy module that restated
 * it would be free to drift from the timer the reader actually waited out.
 */
export const firstForecastTimeoutMessage = (deadlineSeconds: number): string =>
  `No forecast arrived within ${String(deadlineSeconds)} seconds — the pipeline may still be working. Try again to keep waiting.`;
