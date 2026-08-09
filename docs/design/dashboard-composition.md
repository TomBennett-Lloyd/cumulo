# Dashboard composition

Design record for
[#148 — one integrated experience, not view-toggled pages](https://github.com/TomBennett-Lloyd/cumulo/issues/148),
covering how the dashboard's one surface is put together: what a selection changes, what it
leaves alone, where focus goes, and where the two Open-Meteo credits sit.

This is the composition, not the styling. The surfaces it arranges have their own records —
[`map-treatment.md`](map-treatment.md) for the map and its markers,
[`chart-treatment.md`](chart-treatment.md) for the forecast chart — and the async states every
panel wears are a written convention in
[`docs/standards/react.md`](../standards/react.md#async-surface-convention-appsweb) rather than a
section here. Where this document and the code disagree, the code wins; what belongs here is the
reasoning a diff cannot carry.

## What replaced the view nav

The app used to toggle three views — fleet map, fleet aggregate, site forecast — behind
`aria-pressed` nav buttons, each unmounted on leave. Three problems came with that shape. The
fleet's aggregate was a _destination_, so the reader had to leave the map to see what the map was
of. Selecting a site on the map and reading that site's forecast were two different pages. And
every departure threw away the work: coming back re-fetched everything the reader had already
waited for.

The redesign has one surface. The map is the canvas and the reading sits with it; nothing is
navigated to.

Where the reading sits changed once since. #148 docked it in a column beside the map, which made
the two visible at once at the cost of giving the map two thirds of the width and the reading a
26–30rem measure — and of a second scroller, since a column of panels beside a fixed-height map
has to scroll inside a page that cannot. #265 took the map full bleed across the top and put the
reading in one centred measure below it: one scroller, the full width for the map, and no
breakpoint, because the stacked arrangement a narrow screen already got is now the only one.

## A selection changes what is drawn, not what is on screen

**Nothing under the map swaps.** The reading is a plain flow, top to bottom: the fleet's chart,
the site table, the page footer. All three are present in every state the page can be in.

The table is folded away behind a `<details>` disclosure whose summary counts the fleet
(`apps/web/src/dashboard/SiteTable.tsx`). Sixty rows open under the chart are the tallest thing
this page can hold, and they were carrying a job the header's search took over — finding one site
by name. What the rows are still for is the equivalence
[`map-treatment.md`](map-treatment.md) requires, every marker state having a row that says the
same thing, and a closed disclosure keeps that a keystroke away rather than removing it.

That is the second answer this composition has given. #148's answer was a **context region** —
one box under the map showing either a selected site's panel or the fleet's, whichever the state
called for. It kept the aggregate reachable by doing nothing, which was the issue's own
requirement, and it cost three things that only became obvious once the surface was being used.
A reader comparing one roof against the fleet was asked to remember one chart while looking at the
other. A selection wrote its answer into a region that was frequently off the top of the screen,
so the dashboard grew a scroll effect to chase it. And the fleet panel had to be `hidden` rather
than unmounted, with all the live-region care that a `display: none` subtree needs, purely so that
its expensive fan-out survived being displaced.

#265 replaced the region with two moves that between them retire all three costs:

- **A selected site's detail is a card on the site's own marker** (`apps/web/src/map/SitePopover.tsx`,
  anchored through `MapMarkerAnchor`). The answer to "which site is this" is drawn where the
  question was asked, and it rides the camera, so panning keeps it over its site.
- **A selected site's forecast is a second series on the fleet chart**
  (`apps/web/src/dashboard/site-overlay.ts`, drawn by `ForecastChart`'s `overlay` prop on one kW
  axis). The comparison that used to need two charts and a memory is now one chart with two lines
  on it — which is the whole reason the card carries no chart of its own.

What the card carries instead is the site's identity and physical facts, and the state of its
first forecast: the `checking`/`generating`/`failed`/`halted` arms of the dashboard's poll, in the
app's shared async vocabulary (`react.md`). The `ready` arm renders nothing at all, because by
then the answer is on the chart below.

**A draft is a modal, and it clears nothing.** #265 moved the add-site form into a native
`<dialog>` (`apps/web/src/add-site/AddSiteDialog.tsx`), opened with `showModal()` over the whole
page. Placing a site is a short, committed detour rather than a context to read. The precedence
rule the old arrangement had to state — a draft outranks a selection but never clears it — is
physical now: the page behind is inert, so there is nothing to outrank, and cancelling hands the
reader back exactly the page they had, selection included.

Opening the draft is also no longer a bare click on the basemap: the map carries an add-site
control that arms the next click, and the mode is spent on the click that uses it. A click on an
empty spot with the mode disarmed does nothing at all. The control itself is the map's own chrome
and is recorded there — [`map-treatment.md`](map-treatment.md)'s "Map chrome" section, over
`apps/web/src/map/MapControls.tsx`.

**The one thing that can still be out of view is the site**, not the reading. A selection can
arrive from anywhere but the map — a row, the header's search, a link, a creation — and the camera
has no reason to be pointing anywhere near what those name. `apps/web/src/map/SelectionCamera.tsx` eases the camera to a selected site that
is outside the current bounds, and does nothing at all when it is already inside them — moving the
map for a marker the reader just pressed would shove the one thing they were looking at. It keeps
the zoom, because the framing is the reader's choice and not the selection's.

The page itself never scrolls on a selection any more, and the effect that used to do it is gone
with the region it chased.

## Focus follows the reader, never the address bar

A page that changes above the reader's focus point owes them a landing, and a page that changes
for no reason of theirs owes them the opposite. The settled rule:

- **A reader-initiated selection lands the reader on the fleet panel's range picker** — every
  opener that is a reader doing something qualifies: a marker press, a row press, a search hit, a
  creation. The test is who acted, not which opener it was, which is why a new one inherits the
  rule instead of extending a list. The landing was the card's own heading (`tabIndex={-1}`, a
  target without joining the tab order) until #284 D14 moved it: the card is facts about a site
  with nothing to do from it, while the picker is the control that decides what the reader is now
  being shown, is on screen in every state of the page, and is where the next act is. The heading
  remains the fallback where a source renders no picker. What it costs is the announcement — the
  picker says "24 h, pressed" rather than the site's name, which the card's `aria-labelledby` and
  the chart legend's row for that site still carry (the chart's _readout_ does not: it mounts empty
  and fills only when a reader moves the chart's selection, so it names nothing at the moment of
  landing). It costs a keyboard reader one more thing, and it is worth naming here because the
  layout is what causes it: the map precedes the reading column, so the card sits _above_ the
  landing and Escape — which only works from inside the card — is reached by tabbing backwards past
  the (i) tip and the map's controls.
- **A `?site=` selection moves focus nowhere.** This is the settlement of
  [#260](https://github.com/TomBennett-Lloyd/cumulo/issues/260), and the asymmetry is the point
  rather than an exception for page load: the card mounts when the fleet listing _resolves_, which
  on a deep link can be seconds in, so a mount-time focus move takes focus from a reader who has
  since started using the page (WCAG 3.2.5). The dashboard carries which of the two happened
  beside the selection itself (`apps/web/src/dashboard/selection-origin.ts`); the alternative fix
  considered and rejected was skipping the effect's first run, which is a rule about run counts
  rather than about who acted, and says nothing about the second late arrival.
- **Closing returns focus to whatever held it when the card opened, if the card is holding it**,
  captured on the way in. The panel this replaced reconstructed the landing instead — it searched
  the site list for the row naming its site — which was the right answer only for the one opener it
  knew about. Capturing covers every opener with no case analysis — a marker, a row, a search hit,
  a creation, and whatever is added next — and an opener that has since left the document is simply
  not chased. Since the landing moved to the picker, the guard is what usually answers: a card the
  reader was never inside stands aside and leaves them on the control they were left on. The
  hand-back still fires for a reader who came into the card, which pressing Close does.
- **A dismissed draft returns focus to the map's add-site control**, the control the reader opened
  it with.

That last one is the modal's bill, and it is worth naming because the platform normally pays it: a
`<dialog>` closed with `close()` restores focus itself, but this one closes by being _unmounted_,
and a removed dialog never runs the close steps. So the dashboard supplies the landing by hand,
from the dialog's effect cleanup rather than from its `cancel` handler — on the Escape path the
browser's own restoration is still running while `cancel` is being dispatched, and would overwrite
a focus set there. React flushes a commit's unmount cleanups before its mount effects, which is
what makes a creation land correctly without a special case anywhere: the dialog's cleanup puts
focus on the add-site control, and the new site's card — mounting in the same commit — captures
_that_ as its opener before moving the reader on to the picker.

`react.md`'s focus paragraphs own the rule — two of them since #284 D14, one for _whether_ focus
moves and one for _where_ it lands. `Dashboard.focus.test.tsx` and
`map/SitePopoverCard.test.tsx` pin it as far as `document.activeElement` goes; the ring a reader
actually sees, and a deep link arriving over a real network, are `e2e/keyboard-focus.spec.ts`'s.

## The fleet panel is never hidden, and always paid for

`FleetPanel` is rendered unconditionally, with no `hidden` prop and no reveal latch. There is no
fleet-level endpoint: a fleet sum in live mode is a client-side fan-out of one request per site —
about eight seconds over sixty sites, paced to stay inside the API's per-IP limiter — so the
question that matters is how often that is spent.

It is spent on mount, and re-spent on exactly one event: a site being added, which is the only
thing that changes the sum. `refreshToken={createdSites.length}` is that event, counted.
Deselection is not an event, and neither is selection — a selected site is one extra per-site
request for its own line, not a re-sum.

**The trade accepted in #265, stated because it is a real cost.** #178 deferred the first fan-out
until the panel was first revealed, so a `?site=` deep-linked reader who never looked at the fleet
never paid for it. That saving depended on the panel being hideable, and nothing hides it now: the
fleet chart is on screen from first paint in every state, with the selected site drawn over it. A
deferral would therefore buy no reader anything — there is no longer a reader who does not look at
the fleet — and would cost every deep link a spinner where the chart already is. So the deep link
pays the fan-out, once. `Dashboard.deep-link.test.tsx` asserts the "once" rather than leaving it
to prose.

The other cost is unchanged: adding a site in live mode spends a fresh fan-out, bounded by
`CreationThrottle`'s three-per-minute allowance.

Two implementation notes that went with the hiding. `fleet-panel.css` no longer restates
`[hidden] { display: none }` — it had to, because `.fleet-panel` sets `display: grid` and beats
the user agent rule, and a panel that kept its state but not its invisibility would have been
worse than one that unmounted. And the panel no longer withholds its children while hidden, which
was the #161 fix for a `role="alert"` mounting inside a `display: none` subtree with nothing to
announce. Both were answers to a state the page can no longer be in.

## Capability honesty is structural

The fleet panel says the words "simulated actuals", and offers a window to choose, **only when the
source it holds can actually answer for them** — `dataSource.capabilities.fleetLookback` and
`.fleetActuals`, declared per implementation on `FleetDataSource`.

The two gates are not the same gate, and #284 D5 is where they separated. The **copy** is gated on
`fleetActuals` alone, because that flag is exactly the question "are there measured hours to speak
of". The **control** is gated on `fleetLookback || fleetActuals`, because a window is worth
choosing wherever a wider one shows the reader more: with a look-back it widens the past, and with
simulated actuals alone it widens both the span of measured hours and the horizon the fan-out is
asked for. Only a source with neither — a bare forward horizon — goes without a picker, and that
arm is pinned to 24 hours by construction, since the picker is the only thing that ever calls
`setRange`.

This settles a review finding from #150. The demo source has genuine history and its own actuals;
the HTTP source's fan-out reaches forward only, and its actuals come from the forecast service's
own producer (#264), which synthesises the fleet's past hours rather than metering an inverter.
That is why the copy says "simulated" and never "measured": the numbers are real output of a real
model, and nothing on the page should let them be read as a reading. Copy that promised history
was right half the time, and a range control that rendered identical charts in live mode was worse
than absent — which it was until #264 gave the live source actuals for the control to widen.

The fix is structural rather than editorial because the editorial version does not hold: prose
gets rewritten by someone who only ever ran the demo. Two whole copy arms sit side by side in
`fleet-panel-copy.ts` so the rule is auditable by reading them — the phrase "simulated actuals"
appears only in the arm a capable source reaches, _including in the chart's accessible name_, which
is the copy easiest to leave promising something the data cannot show. The two flags move
independently, and #264 puts a source in the combination that previously had none — actuals
without a look-back — so the window the chart names has a third answer beside "24 h range" and
"next 24 h": "past 24 h and the forecast ahead", because a plot carrying past hours reaches behind
the horizon whether or not the source can look back. The past half carries the chosen number of
hours and the forecast half deliberately carries none: the fan-out is asked for the same window
but serves only the hours ahead of the clock, so naming a count there would describe a window the
chart was never given.

The window used to be stated a second time, in a sentence behind an (i) beside the chart. That tip
is gone (#284 D5). It existed only on the arm with no picker, and once the picker reached that arm
the caption was a description of a control standing next to it — so the panel now has exactly one
(i), carrying the one description it has left: what the chart is a sum of.

## Two credits, and why that is not one too many

The Open-Meteo credit is a CC BY 4.0 licence condition wherever weather-derived data is displayed
(CLAUDE.md, hard constraints). The surface carries exactly two, and the count is the design:

- **The map's own band**, overlaid on the bottom edge of the map and `MapRegion`'s obligation.
  Where it sits and what keeps it legible over tiles is
  [`map-treatment.md`](map-treatment.md)'s to say.
- **The page footer**, one persistent credit under the chart and table sections, present in every
  state a selection can put the page in.

The arrangement the old views had — a credit inside each panel — is what this replaces. Those
multiplied with the panels, and each one came and went with whatever mounted it, which meant the
credit was reliably missing in exactly the states nobody looks at. A credit that belongs to the
_page_ rather than to a panel cannot be lost by a selection. The app-level error boundary carries
one too, so a crashed tree does not drop the obligation with the render.

`App.test.tsx` asserts the count is exactly two. That is a real assertion, not a tolerance: three
would mean a panel had grown its own again.

## No router

Selection is deep-linkable through `?site=<id>` written with `history.replaceState`, and there is
no routing library. Two reasons. A router is a dependency in the entry chunk for an app with one
page. And `pushState` would be actively wrong here: selection is not navigation history, and a
Back button that replayed every marker click a reader tried is a worse Back button than one that
leaves the page. `replaceState` keeps the URL shareable without making it a log.

The mechanism is `selection-url.ts`: two functions, `readSiteIdFromSearch` and `writeSiteIdToUrl`,
over `URLSearchParams`. The dashboard reads the URL once — in the lazy `useState` initialiser,
because the address bar is where the _initial_ selection comes from and nothing after that — and an
effect writes it back whenever the selection moves, the URL being the external system an effect is
for (`react.md` rule 1). It has to be an effect rather than a line in each click handler, because
the selection also moves without a click: a creation selects the site it just made, and the
stale-id guard clears one nothing can show. That guard lives in the listing-resolution path, where
the answer to "does that site exist?" actually arrives, rather than in a second effect chained on
derived state — and it counts sites created this session as known, so retrying a failed listing
cannot clear the selection of a site the reader just added. Without the guard a dead deep link
leaves the first-forecast poll asking for a nonexistent site every five seconds for its full
ninety-second deadline, with no card on screen to show for it. The write preserves query
parameters it does not own; the id it reads back is untrusted text until the listing vouches for
it, which is why the module's types say `string` rather than `Site['id']`.

## What this composition does not own

- **The map's internals** — the lazy boundary, its placeholder and its local failure surface stay
  `LazyMapRegion`'s, and its zero-CLS contract is pinned by
  `dashboard/map-region-split-contract.test.ts`.
- **The async-state vocabulary** — `panel-states.tsx` owns the three components, `state-copy.ts`
  owns their wording, and `react.md` owns the rule. Panels reuse them and do not invent siblings.
- **The map shell** — `map/MapSurface.tsx` is the one box behind the canvas, the placeholder
  and the failure, and it wears the same async states under the same convention (#161).
