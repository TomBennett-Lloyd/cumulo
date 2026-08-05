/*
 * What apps/web says when it is waiting, has nothing to show, or has failed.
 *
 * The content column is where most of this copy renders, but it is not the only
 * place the same three states reach the reader: the map region waits and fails
 * on its own, the app-wide boundary is the last of these sentences before a
 * blank page, and the add-site form has a pending label of its own. They are
 * one vocabulary because they are one reader.
 *
 * One module rather than a string beside each component, for the same reason
 * `site-format.ts` is one module: two panels telling the same reader about the
 * same absence in two different voices is a defect, not a variation
 * (`structure.md` rule 7). Collecting them also makes the wording reviewable as
 * wording — the whole vocabulary of the column's empty and failed states reads
 * top to bottom here, which is not true when each phrase lives inside the JSX
 * that happens to render it.
 *
 * One adjective is deliberately gone from the empty-fleet line. The old fleet
 * view qualified its sites with a word asserting a distinction the data model
 * does not make — there is no opposite kind of site to contrast with — and a
 * sentence that implies a state the system cannot be in teaches the reader
 * something false (#104's finding). The word is not written here on purpose:
 * the copy-contract test's acceptance is a grep for it across `apps/web/src`,
 * comments included, and quoting it in the explanation would be the one thing
 * keeping that grep from going quiet.
 *
 * Scope: async-state and failure copy. Chart *chrome* wording — the words a
 * chart says about itself, the clock included — is owned by
 * `apps/web/src/charts/chart-copy.ts`. That sibling is deliberate rather than an
 * oversight: the two modules serve different surfaces and different consumers,
 * and one module holding both would be a module about "text", which is not a
 * subject anybody can review.
 */

/**
 * The empty fleet is the demo's invitation, so it names the next action.
 *
 * The action it names is the map's add-site control, not a bare click. Clicking
 * the basemap stopped being enough when that control arrived (#265): a click
 * only places a site while the mode is armed, so the invitation this sentence
 * used to extend now sends a reader to do the one thing that does nothing.
 *
 * That older wording is not quoted here, for the reason the retired empty-fleet
 * line is not quoted above: the copy-contract test sweeps for it across
 * `apps/web/src` with comments included, and an explanation containing the
 * phrase would be the one thing keeping that sweep from ever going quiet.
 *
 * It had a sibling, `ADD_SITE_HINT`, saying the same thing beside the fleet
 * chart for a fleet that already had sites. That one is gone rather than
 * rewritten: a control the reader can see is what replaced it, and prose
 * explaining a visible button is the kind of copy that goes stale next.
 */
export const EMPTY_FLEET_MESSAGE =
  'No sites yet — press “Add a site” on the map, then click where it goes.';

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

/**
 * A new site's forecast is being generated, and the wait is counted out loud.
 *
 * The seconds are a parameter because the clock belongs to the polling hook that
 * runs it. This label is reached only once the fleet has confirmed no forecast
 * exists yet — the demo promises one about a minute after a site is added, and a
 * visitor watching that minute is owed the count rather than a bare spinner.
 */
export const generatingFirstForecastLabel = (elapsedSeconds: number): string =>
  `Generating first forecast… ${String(elapsedSeconds)}s`;

/** The map engine's chunk is in flight, said in the shell that stands in for it. */
export const LOADING_MAP_LABEL = 'Loading map…';

/**
 * A site creation is in flight, on the submit button that started it.
 *
 * The button's idle name — "Add site" — deliberately stays in the form: it names
 * a control, and control names are the form's own. Only the pending state is
 * this module's, because it is the same wait every other surface here describes.
 */
export const ADDING_SITE_LABEL = 'Adding site…';

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
 * The aggregate is short of sites for some hours, stated in both directions.
 *
 * Both numbers are rendered because "partial" on its own is a shrug: the reader
 * needs to know whether one site is missing or fifty.
 */
export const partialAggregateNotice = (contributing: number, total: number): string =>
  `Partial aggregate: some hours include only ${String(contributing)} of ${String(total)} sites.`;

/** The complementary answer: every displayed hour holds the whole fleet. */
export const aggregatedFromCaption = (siteCount: number): string =>
  `Aggregated from ${String(siteCount)} sites`;

/**
 * The first-forecast poll gave up before the pipeline answered.
 *
 * The deadline is a parameter rather than baked into the sentence: the number
 * belongs to the polling hook that enforces it, and a copy module that restated
 * it would be free to drift from the timer the reader actually waited out.
 */
export const firstForecastTimeoutMessage = (deadlineSeconds: number): string =>
  `No forecast arrived within ${String(deadlineSeconds)} seconds — the pipeline may still be working. Try again to keep waiting.`;

/**
 * The deadline passed without the fleet answering at all.
 *
 * Its sibling above claims the pipeline may still be working, which is only
 * true of a wait the fleet confirmed was a wait. A run that never got an answer
 * — every request still in flight at ninety seconds — knows nothing about
 * whether a forecast exists, so this sentence claims nothing about the
 * pipeline and says only what is certain: no answer, and the question is still
 * open. It consumes the tech-debt entry "The timeout copy asserts pipeline
 * generation from a run that never established existence" (#177 review cycle 1,
 * resolved here in #104); `ForecastFailureReason`'s `unanswered` arm is the
 * fact this renders.
 *
 * The deadline is a parameter for the same reason it is on the sibling: the
 * number belongs to the polling hook that enforces it.
 */
export const firstForecastUnansweredMessage = (deadlineSeconds: number): string =>
  `No answer from the fleet within ${String(deadlineSeconds)} seconds — whether a forecast exists yet is unknown. Try again to keep asking.`;

/*
 * The failure sentences below all take the source's own message as `detail`
 * rather than paraphrasing it. The source names the operation that failed and is
 * the only account of what actually went wrong (`error-handling.md` rule 4);
 * what these add is the surface the reader is looking at, which the transport
 * knows nothing about.
 */

/** One site's window failed to load; the site is named because the panel can swap. */
export const siteSeriesFailureMessage = (siteName: string, detail: string): string =>
  `Could not load the forecast for ${siteName}: ${detail}`;

/** The fleet fan-out failed — one sentence for both of the panel's two queries. */
export const fleetForecastFailureMessage = (detail: string): string =>
  `Could not load the fleet forecast: ${detail}`;

/**
 * The site listing itself failed.
 *
 * Terser than its siblings on purpose: this one stands where the list would be,
 * so the reader has no other content to place it against and the subject has to
 * come first.
 */
export const fleetListFailureMessage = (detail: string): string => `Fleet unavailable: ${detail}`;

/**
 * The map engine's chunk is never going to arrive.
 *
 * It offers a reload rather than a retry because `lazy` caches the rejected
 * promise — an in-page retry would be a control that cannot work. The second
 * clause is the part worth keeping: everything below the map still works, and a
 * reader who is not told that will assume the page is broken. It says *below*
 * rather than *beside* because that is where those things now are (#265) — a
 * message that points a reader somewhere empty is worse than one that points
 * nowhere.
 */
export const MAP_LOAD_FAILURE_MESSAGE =
  'The map could not be loaded. Reload the page to try again — the fleet list and forecasts below it are unaffected.';

/** The whole tree threw: the boundary's heading, with {@link APP_FAILURE_ADVICE} under it. */
export const APP_FAILURE_HEADING = 'The dashboard hit an unexpected error';

/**
 * The only recourse the app boundary can honestly offer.
 *
 * It caught something it has no model of, so it says nothing about whether
 * trying again will work — only what there is to try.
 */
export const APP_FAILURE_ADVICE = 'Reload the page to try again.';

/** The recourse itself, on every failure that has one — one name, so it is one control. */
export const RETRY_ACTION_LABEL = 'Try again';
