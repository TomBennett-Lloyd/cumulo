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

/*
 * The site listing's own pending label stood here until #452, and that round
 * deleted it for a reason one step further along than #448's.
 *
 * #448 took the *fleet chart's* pending sentence out and let the plot draw the
 * wait. #452 took the listing's states off the page altogether: the sites
 * section they were the last occupant of is gone (#451), and what a reader is
 * owed while the listing is in flight is the same thing they are owed while any
 * other read is — the chart drawing its wait, which it does, because a panel
 * with no sites yet has queries that have never run and therefore report
 * `loading` (`data/use-fleet-query.ts`). So the label lost its surface rather
 * than its wording. The retired phrase is deliberately not quoted, for the
 * reason the other retired lines in this file are not.
 */

/*
 * The fleet chart's own pending label stood here until #448, and that round
 * deleted it rather than rewording it.
 *
 * Both halves of the owner's objection are why. The verb named the wrong thing —
 * most of that wait is spent fetching, not summing — which is a rewording. But
 * the sentence also arrived above the chart and left again, moving the page
 * under a reader twice per read, and no wording fixes that. What they asked for
 * instead is that the surface show its own wait: *"graph loading state needs to
 * be visual not words"*. So the state left this module altogether rather than
 * moving to a better sentence, and nothing replaces it here.
 *
 * Where it went: `charts/chart-loading-curve.ts` draws it, `charts/charts.css`
 * animates it, and `aria-busy` on the panel body (`dashboard/fleet-panel-body.tsx`)
 * is what a reader without eyes gets instead. The retired phrase is deliberately
 * not quoted above, for the same reason the two retired lines further up are
 * not: a comment naming a phrase is the one thing that keeps a sweep for it from
 * ever going quiet.
 */

/** One site's forecast is being fetched; the site is named because the selection can move. */
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

/** The fleet read succeeded and summed to nothing — an answer, not a failure. */
export const NO_FLEET_FORECAST_MESSAGE = 'No fleet forecast available yet';

/*
 * Three sentences left this module in #265, and the reason is the same for all
 * three: the surface that said them no longer exists. The site detail panel drew
 * a windowed chart of one site's forecasts and measurements, so it owed the
 * reader an empty answer, a "nothing was measured in this range" notice, and a
 * failure sentence naming the site. The site's card on the map draws no chart —
 * one site's forecast is now a series on the fleet's (`site-overlay.ts`) — so
 * there is no window to be empty, no measured half to be missing, and no
 * per-site series call to fail. Copy for a surface that is gone is copy that
 * eventually gets reused by someone who assumes the surface came back.
 */

/**
 * The aggregate is short of sites for some hours — the one direction worth
 * stating.
 *
 * Both numbers are rendered because "partial" on its own is a shrug: the reader
 * needs to know whether one site is missing or fifty.
 *
 * It used to have a complement, `aggregatedFromCaption`, which said "Aggregated
 * from n sites" whenever the aggregate was whole. #323 deleted it rather than
 * rewording it: a complete aggregate is what a reader already expects to be
 * looking at, so the sentence described the chart above it instead of reporting
 * anything that had happened — description rather than state, and therefore not
 * this module's subject at all (`design.md` rule 2). Completeness is stated in
 * one direction now, which is the direction that is news.
 */
export const partialAggregateNotice = (contributing: number, total: number): string =>
  `Partial aggregate: some hours include only ${String(contributing)} of ${String(total)} sites.`;

/**
 * The fleet chart is complete; the selected site's line over it is not.
 *
 * A notice rather than an error, and {@link partialAggregateNotice} above is its
 * sibling: both label a chart that arrived and is incomplete, rather than
 * withdrawing it. What failed here is an *addition* to a sum that is intact, so
 * the honest thing is to say which part is missing and leave the rest standing
 * (`error-handling.md` rule 5). Reporting it as a failure would tell a reader
 * the fleet sum in front of them is suspect, which it is not.
 *
 * It names the site, because a reader looking at a chart with one line missing
 * needs to know *which* line — and this sentence is the only place the app says
 * so. The source's own message is deliberately not appended: the recourse here
 * is a button, not a diagnosis, and the transport detail belongs to the failures
 * a reader can act on with it.
 */
export const siteOverlayFailureNotice = (siteName: string): string =>
  `${siteName}’s own forecast could not be loaded, so the chart shows the fleet only.`;

/**
 * The fleet's forecast arrived; its simulated actuals did not.
 *
 * The third of this family, and it earns its place the same way the second did.
 * The fleet's two reads are two requests over two windows — one metered
 * `/v1/fleet/forecast` call (#296) and one metered `/v1/fleet/actuals` call
 * (#264) — so either can fail without the other, and the panel used to answer a
 * failed actuals read by withdrawing the whole chart under the forecast read's
 * own failure sentence — a line naming the forecast and the source's detail,
 * which {@link CHART_DATA_UNAVAILABLE_MESSAGE} replaced in #452. That blamed
 * the forecast for a failure
 * the forecast had nothing to do with, which is the wrong party named to a
 * reader who might go looking at the wrong thing (`error-handling.md` rule 1's
 * blame tiebreak), and it threw away a complete fleet sum that had already
 * arrived (rule 5).
 *
 * A constant rather than a function, unlike its sibling above: there is one
 * fleet, so there is no name to interpolate. The source's own message is left
 * off for the sibling's reason — the recourse here is a button, not a diagnosis.
 */
export const FLEET_ACTUALS_FAILURE_NOTICE =
  'The fleet’s simulated actuals could not be loaded, so the chart shows the forecast only.';

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
 * **No sentence in this module takes the source's own message any more, and
 * #452 is where the last two went.**
 *
 * Two of them used to — the fleet forecast read's and the site listing's — on
 * the argument that the source names the operation that failed and is the only
 * account of what actually went wrong (`error-handling.md` rule 4). That
 * argument was about the *log*, and it had quietly been applied to the *page*.
 * Every other failure sentence in this file had already declined the detail on
 * the ground {@link siteOverlayFailureNotice} states: the recourse a reader has
 * is a button, not a diagnosis, and `fleetForecasts range=24: upstream timed
 * out` tells them nothing they can act on. #452 finished the job from the other
 * end — the owner ruled that a total failure needs no specificity at all
 * (see {@link CHART_DATA_UNAVAILABLE_MESSAGE}) — so the two detail-bearing
 * sentences went with the surfaces that rendered them.
 *
 * Rule 4 is untouched by this: the typed error still carries `code` and
 * `message` all the way to the view (`data/use-fleet-query.ts`'s `QueryState`),
 * so nothing is thrown away — it is simply not shown to a reader who cannot use
 * it. A view that one day distinguishes a rate limit from a broken payload has
 * everything it needs.
 */

/**
 * The chart has nothing to draw and no way to get anything — one sentence for
 * every total failure of its data path.
 *
 * The owner's own words, near enough to quote: *"Site data unavailable, please
 * try again later"*, ruled generic on purpose — *"this can be the generic error
 * message for anything that means we can't show data on the graph, no need to be
 * too specific if the error state is basically just a total failure"* (#452).
 * The source's detail therefore does not reach the reader by decision rather
 * than by omission, and which failures route here is `dashboard/FleetPanel.tsx`'s
 * to decide, not this sentence's.
 *
 * Three deliberate departures from the dictation. **The plea is dropped**: the
 * quotation above is, after this change, the single occurrence of that word
 * anywhere in `apps/web/src` — swept and verified in #452 — and it is a record
 * of what was asked for rather than anything a reader is shown, so keeping it in
 * the copy would have made this the one sentence in the product that pleads.
 * **"Try again later"
 * became the button**, which carries {@link RETRY_ACTION_LABEL} — one name, so
 * it is one control — and the two could not both stand: a sentence counselling
 * patience beside a button offering action contradicts itself, and the button is
 * the half that can actually work. **No trailing period**, on
 * {@link NO_FLEET_FORECAST_MESSAGE}'s precedent — it is a fragment stating a
 * state, not a sentence addressed to anyone.
 */
export const CHART_DATA_UNAVAILABLE_MESSAGE = 'Site data unavailable';

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
