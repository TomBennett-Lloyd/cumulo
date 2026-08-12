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
section here. The prospective cross-surface rules an implementer applies where no record has
decided are [`docs/standards/design.md`](../standards/design.md), and a rule there that gets
decided into this composition lands here. Where this document and the code disagree, the code
wins; what belongs here is the reasoning a diff cannot carry.

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

**Nothing under the map swaps.** The page is a plain flow, top to bottom: the map band, the
fleet's chart, the page footer. All three are present in every state the page can be in.

The chart is a full-width band rather than the first item of the centred reading, which is what
#323 changed. It sits directly against the map with no gap and on the same `--color-surface`, so
the two read as one continuous unit — which is what they are, the same fleet drawn in space and
then in time, and a card edge with a page margin around it was claiming a separation nobody meant
([`../standards/design.md`](../standards/design.md) rule 4). The measure picks up again below,
around the footer, where the reading genuinely is a separate thing from the two bands above it.
The chart is better for the extra width in its own right: its axis is time, and a time axis has
more to say the wider it is drawn.

#323 also took the visible `<h2>` and the "60 sites · 332 kW" line off that band, moving the name
into the section's accessible name and deleting the numbers outright; the owner reversed that half
on 2026-08-11 and both are visible text again, on the reasoning that a band with no card edge left
around it needs a heading to say where the fleet's section begins, and that a plot of the fleet's
output never states how many roofs it is a sum of (`apps/web/src/dashboard/FleetPanel.tsx` carries
the argument; `fleet-panel.css` owns the container width below which the numbers hide). The rest of
#323 stands unchanged — this is a reversal of one clause, not of the ticket.

That line stays in kW whatever unit the chart beside it is drawn in, which #291 made a live
question rather than a hypothetical one. It states installed capacity, which is the divisor the
chart's percentages are taken against — in percent mode it is the thing 100% means — so following
the toggle would leave it restating a capacity as a percentage of itself.

**The Sites section is gone, and its three jobs went three different ways.** The owner removed it
on 2026-08-12 (round 3, item 4): _"i actually don't think we need the `Sites` section at the
bottom of the page. the list of sites is visualised on the map and listed as part of the search
bar."_ The section was a table of every site, folded behind a `<details>` disclosure since #265
and never opened by default. Where each thing it did now lives:

- **Finding one site by name** left first. The header's search took that over in #265, which is
  what made folding the rows away affordable at the time; the disclosure then outlived the job
  that had justified the rows being on the page at all.
- **Saying how big the fleet is** is the chart band's stats line — the "60 sites · 332 kW" the
  paragraph above records the owner restoring on 2026-08-11. The summary's count and that line
  were two statements of one number for a day; one of them is left. It is also the page's only
  statement of the fleet's installed capacity, which is what #291's percent mode is a percentage
  _of_ — one more reason for it to be in kW there.
- **Being a non-colour channel for marker state** went back to the markers.
  [`map-treatment.md`](map-treatment.md) had leaned on the table as the table view — every marker
  state with a row equivalent — and re-derives its relief from the tooltip, the card, the size
  change and the tab order there. That section also records what the removal costs, which is
  worth reading before the marker palette moves again: the map is now the page's only enumeration
  of the fleet.

What is left under the chart is the footer. The reading column that held the table is one band
shorter, which is the change a reader actually sees.

**The listing's own account of itself followed the table a ticket later, into the chart.** The
section outlived the rows by one ticket: `FleetSection` stayed behind to carry the listing's pending
label and its failure card, so the reading column still held a box that appeared and disappeared
with a request. The owner closed that on 2026-08-12
([#452](https://github.com/TomBennett-Lloyd/cumulo/issues/452)) — _"the sites fetch error state
should show in the graph area … this can be the generic error message for anything that means we
can't show data on the graph"_ — and the section, the box and its CSS rule went together. What
replaced them is not a smaller box in the same place. A listing still in flight is now drawn as the
chart's own loading trace, and a listing that failed leaving nothing to sum is the chart's one
generic unavailable account: both live inside the `<figure>` — one as a mark in the plot, one as an
overlay over it — and neither can move the page arriving or leaving. [`chart-treatment.md`](chart-treatment.md)'s "Loading" and "Data unavailable"
sections own the treatment, the one-generic-account rule and its boundary — only a _total_ failure
of the chart's data path routes there, the partial states keep their own notices, and an empty fleet
keeps its invitation because it is a finished answer rather than a failure.

Two things fall out of that which are this composition's rather than the chart's. `FleetPanel` takes
the listing's status as an input, for the single question of whether the fleet is known yet — the
fleet endpoints never depended on the listing, so a listing that failed beside sites this session
created still gets a chart, which is the owner's own degradation story: if the graph can show data
it does, and the sites in hand are on the map regardless. And the false flash is gone — a reader
whose listing was still in flight used to be shown the empty fleet's invitation for the length of
the read, an answer the page did not have yet. `apps/web/src/dashboard/Dashboard.tsx` carries the
note where `FleetSection` used to be.

That is the second answer this composition has given. #148's answer was a **context region** —
one box under the map showing either a selected site's panel or the fleet's, whichever the state
called for. It kept the aggregate reachable by doing nothing, which was the issue's own
requirement, and it cost three things that only became obvious once the surface was being used.
A reader comparing one roof against the fleet was asked to remember one chart while looking at the
other. A selection wrote its answer into a region that was frequently off the top of the screen,
so the dashboard grew a scroll effect to chase it. And the fleet panel had to be `hidden` rather
than unmounted, with all the live-region care that a `display: none` subtree needs, purely so that
its expensive fleet read survived being displaced.

#265 replaced the region with two moves that between them retire all three costs:

- **A selected site's detail is a card on the site's own marker** (`apps/web/src/map/SitePopover.tsx`,
  anchored through `MapMarkerAnchor`). The answer to "which site is this" is drawn where the
  question was asked, and it rides the camera, so panning keeps it over its site.
- **A selected site's forecast is a second series on the fleet chart**
  (`apps/web/src/dashboard/site-overlay.ts`, drawn by `ForecastChart`'s `overlay` prop on one value
  axis, in whichever unit the panel is showing). The comparison that used to need two charts and a
  memory is now one chart with two lines on it — which is the whole reason the card carries no
  chart of its own. #291 is what finished the job: a ~4 kW roof against a ~330 kW fleet is a flat
  line on an absolute axis, so selecting a site switches that axis to percent of capacity, where
  the two curves are comparable. A reader can move it back, and a reader who does keeps it
  (`apps/web/src/dashboard/chart-unit.ts` holds the whole rule).

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
arrive from anywhere but the map — the header's search, a link, a creation — and the camera
has no reason to be pointing anywhere near what those name. `apps/web/src/map/SelectionCamera.tsx` eases the camera to a selected site that
is outside the current bounds, and does nothing at all when it is already inside them — moving the
map for a marker the reader just pressed would shove the one thing they were looking at. It keeps
the zoom, because the framing is the reader's choice and not the selection's.

The page itself never scrolls on a selection any more, and the effect that used to do it is gone
with the region it chased.

## Whether a selection is somebody's, not where anything lands

No selection moves focus on the way in any more, so what is left for a selection to decide is the
card's hand-back on the way out: a surface somebody opened captures whatever held the focus and
owes it back, and a surface nobody opened has nobody to return anywhere. That asymmetry — capture,
not landing — is what the dashboard carries beside the selection itself
(`apps/web/src/dashboard/selection-origin.ts`). The settled rule:

- **A selection moves focus nowhere** — every opener, and whoever did the opening: a marker press,
  a search hit, a creation. The reader keeps the control they pressed, and the search
  keeps the reader in its input, which is the ARIA combobox's own discipline. The landing was the
  card's own heading (`tabIndex={-1}`, a target without joining the tab order), then a control in
  the panel below the map; #328 removed it outright, on the rule that a page that grabs the focus
  takes the reader's place away to tell them something it could have told them where they stood
  (`docs/standards/design.md` rule 11; `design-principles.md` carries the history). What answers the selection instead is structure they
  can already reach: the card's `aria-labelledby` names the site, the chart draws that site's line
  in slot 2, and the header's search announces its hit in its own status region — the chart's
  _readout_ does none of it, since it mounts empty and fills only when a reader moves the chart's
  selection.

  **The chart's half of that got thinner on 2026-08-11 and is named honestly here rather than
  overstated.** This paragraph used to say the legend grows a row under the site's name once its
  line is drawn, and that row is now behind the (i) (`chart-treatment.md`'s Legend section) — so
  what a reader sees _without asking_ is the drawn slot-2 line itself, and the site's name in the
  tooltip's own row once they read a sample. The name is still reachable in the legend, one press
  away, and it is still what the card carries in full. What is no longer true is that a selection
  writes the site's name into the page unprompted, which is what the old sentence claimed. That does
  not reopen the landing question — a line appearing on the page's one chart is a visible answer to
  a press, and the argument above was never that the legend row in particular was the answer. What went with the landing is a cost rather than a benefit
  lost: a reader on the picker reached Escape — which only works from inside the card — by tabbing
  _backwards_ past six stops, because the map precedes the reading column. From a marker the card
  is where the reader already is.

- **A `?site=` selection additionally captures no opener.** This is what survives of the settlement
  of [#260](https://github.com/TomBennett-Lloyd/cumulo/issues/260) now that neither arm moves focus
  on the way in, and the asymmetry is the point rather than an exception for page load: the card
  mounts when the fleet listing _resolves_, which on a deep link can be seconds in, so whatever
  holds the focus at that instant is not a control anybody chose to be returned to (WCAG 3.2.5).
  The dashboard carries which of the two happened beside the selection itself
  (`apps/web/src/dashboard/selection-origin.ts`); the alternative fix considered and rejected was
  skipping the effect's first run, which is a rule about run counts rather than about who acted, and
  says nothing about the second late arrival.
- **Closing returns focus to whatever held it when the card opened, if the card is holding it**,
  captured on the way in. The panel this replaced reconstructed the landing instead — it searched
  the site list for the row naming its site — which was the right answer only for the one opener it
  knew about. Capturing covers every opener with no case analysis — a marker, a search hit,
  a creation, and whatever is added next — and an opener that has since left the document is simply
  not chased. With nothing landing a reader inside the card, the guard is what usually answers: a
  card the reader was never inside stands aside and leaves them where they already were. The
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
_that_ as its opener and then moves nobody, which leaves the dialog's return as the last word.

`react.md`'s focus paragraphs own the rule, five of them for the four bullets above — "whether a
selection is the reader's" owns the second bullet, "where the focus lands on a selection" owns the
first (and the modal's exception to it), and the third bullet is owned by two together: "a surface
that leaves owes a landing" for the capture-and-restore, and "a surface that never took the focus
returns none" for the guard that has answered most dismissals since the landing went.
The fourth bullet is the modal's own paragraph, "a modal owes its own landing". `Dashboard.focus.test.tsx` and
`map/SitePopoverCard.test.tsx` pin all of it as far as `document.activeElement` goes. The ring a
reader actually sees is the browser lane's, and there it is two specs rather than one:
`e2e/keyboard-focus.spec.ts` keeps the ring a keyboard reader depends on, and a deep link arriving
over a real network; `e2e/pointer-focus.spec.ts` keeps the other clause, that no ring appears where
the reader did not ask for one. Deleting either leaves half a rule standing.

## The fleet chart is never hidden, and always paid for

`FleetPanel` is rendered unconditionally, with no `hidden` prop and no reveal latch. A fleet sum in
live mode is **one metered request** — `GET /v1/fleet/forecast`, with `GET /v1/fleet/actuals`
beside it for the measured half — so the question that matters is how often those are spent. That
is #296's shape. Until it landed there was no fleet-level endpoint at all and the sum was a
client-side request per site, released slowly enough to stay inside the API's per-IP limiter and
taking seconds to finish over a fleet of sixty; the per-site Queries still happen, but server-side,
inside the one request the browser makes.

It is spent on mount, and re-spent on exactly one event: a site being added, which is the only
thing that changes the sum. `refreshToken={createdSites.length}` is that event, counted.
Deselection is not an event, and neither is selection — a selected site is one extra per-site
request for its own line, not a re-sum.

**The trade accepted in #265, stated because it is a real cost.** #178 deferred the first fleet
read until the chart was first revealed, so a `?site=` deep-linked reader who never looked at the fleet
never paid for it. That saving depended on the chart being hideable, and nothing hides it now: the
fleet chart is on screen from first paint in every state, with the selected site drawn over it. A
deferral would therefore buy no reader anything — there is no longer a reader who does not look at
the fleet — and would cost every deep link a spinner where the chart already is. So the deep link
spends that one forecast request, once. `Dashboard.deep-link.test.tsx` asserts the "once" rather than
leaving it to prose.

The other cost is unchanged in shape and smaller in size: adding a site in live mode re-sums the
fleet, and that is two fresh metered requests rather than one — `refreshToken` sits in both query
keys, so a creation re-asks the forecasts and the simulated actuals alike. Bounded by
`CreationThrottle`'s three-per-minute allowance.

Two implementation notes that went with the hiding. `fleet-panel.css` no longer restates
`[hidden] { display: none }` — it had to, because the section then set `display: grid` and beat
the user agent rule, and a surface that kept its state but not its invisibility would have been
worse than one that unmounted. And it no longer withholds its children while hidden, which
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
simulated actuals alone it widens both the span of measured hours and the horizon the forecast read
is asked for. Only a source with neither — a bare forward horizon — goes without a picker, and that
arm is pinned to 24 hours by construction, since the picker is the only thing that ever calls
`setRange`.

This settles a review finding from #150. The demo source has genuine history and its own actuals;
the HTTP source's fleet forecast route reaches forward only, and its actuals come from the forecast service's
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
hours and the forecast half deliberately carries none: the forecast read is asked for the same
window but serves only the hours ahead of the clock, so naming a count there would describe a window the
chart was never given.

The window used to be stated a second time, in a sentence behind an (i) beside the chart. That tip
is gone (#284 D5). It existed only on the arm with no picker, and once the picker reached that arm
the caption was a description of a control standing next to it — so the panel now has exactly one
(i), carrying the one description it has left: what the chart is a sum of.

## Simulated-data disclosure

Two of the quantities this page can draw are synthesized rather than measured: the actuals, and the
band around the forecast. Which surfaces have to say so — and which deliberately do not — is one
rule with two triggers. It is the section above's precedent stated generally rather than a second
policy, and it exists so the next surface is decided by the rule instead of by whoever writes it
(#406).

**Description copy is gated on capability.** A sentence describing what a source _produces_ is
written out per capability arm, whole, so the arms are auditable side by side rather than assembled
from a conditional clause. `dashboard/fleet-panel-copy.ts` is that design and its header states it
beside the arms; the section above is where the argument for it lives.

**Drawn chrome is gated on arrival.** A legend row, a table column, a swatch — anything standing for
a quantity in the plot — exists only where the drawn points carry that quantity.
`charts/forecast-chart-legend.tsx` gates the band's row on it and
`charts/forecast-chart-table.tsx` gates the band's two columns on the same test, each stating the
reason beside itself (#295).

**Where the two meet is the boundary working, not a contradiction.** #406 read the subtitle and the
legend as disagreeing: the subtitle names the band on both of its arms, while the legend row and the
columns appear only where the points carry one. Both are right, because they are about different
things. The subtitle sits behind the panel's single (i) (`dashboard/FleetPanel.tsx`) and is the
section's only self-description, the window statement having left it for the chart's own names
(above) — #284 D5 deleted the second (i) because the picker stated the window on the row, and when
the picker folded behind a calendar icon on 2026-08-11 that job went on to the chart's accessible
name and its table caption in `dashboard/fleet-panel-copy.ts` rather than back to a tip. So the
subtitle describes **what the source produces**. The legend and the table describe **what the plot holds**.
Following the data with the subtitle would trade a description of the section for a report on the
current response, and would cost the arms the property they exist for.

### The surfaces that carry it, and the two that deliberately do not

- **The panel's subtitle, and both of the chart's names** — `dashboard/fleet-panel-copy.ts`.
  Capability-gated. An accessible name and a table caption are copy like any other, which is why
  they are arms rather than one string with a clause.
- **The band's legend row** — `charts/forecast-chart-legend.tsx`. The actuals row beside it is
  unconditional in the markup, and that is this rule's one exception rather than an instance of it:
  the series is derived from the data (`actualKw != null`), not from the capability, so the demo
  source earns the row by synthesizing a reading for every past hour while a real fleet with no
  stored history yet draws no actuals line under a legend that still names one. Logged in
  `docs/tech-debt.md` rather than fixed here — the diff that names a rule is the wrong place to
  change a drawn surface.
- **The band's columns** — `charts/forecast-chart-table.tsx`. Arrival-gated, and the one member
  whose own headers carry no wording: `P10` and `P90` name a quantity, not where it came from. Two
  things disclose over the table — the `<caption>` it takes from the copy module, and the legend's
  band row. **They stopped being neighbours on 2026-08-11.** The legend row used to sit directly
  above the table inside the same `<figure>`; that round moved the legend into the panel's (i) and
  the table out into its own panel after the figure (`chart-treatment.md`'s Legend section and its
  fold bullet), so neither is _above_ the table any more and the disclosure has to be argued from
  where the two now are. It holds on both halves. The caption is inside the table as its accessible
  name, so no rearrangement of panels can leave it behind, and it is capability-gated like every
  other arm in the copy module. The legend is one press away in every state, and the band's row
  sits inside it wherever the drawn points carry a band — in the very popover that holds the
  subtitle naming the band simulated, so where there is a band to disclose, the drawn disclosure
  and the described one now arrive together rather than a panel apart.
- **The API's component descriptions** — `apps/api/src/openapi/components.ts`, on `Forecast`,
  `GenerationReading` and `FleetActualsResponse`. There is deliberately no field, so the prose _is_
  the contract, and `apps/api/src/openapi/document.test.ts` pins all three: a disclosure nothing
  reads is one that can quietly stop being true.

Deliberate non-members, named so their silence reads as a decision rather than an oversight: the
README's opening product paragraph, and `PRODUCT_TAGLINE` (`apps/web/src/header/header-copy.ts`,
rendered by `AboutDialog.tsx`). Both are vision prose about the product — the ML correction layer
included, which is issue 20 and unbuilt — rather than a description of anything on screen. The
disclosure belongs one layer in, to every surface that _displays_ the data, and it is complete
there. A caveat in a tagline would hedge a sentence that shows no numbers, and it would be the
first thing to go stale when the layer it hedges against ships.

## Two credits, and why that is not one too many

The Open-Meteo credit is a CC BY 4.0 licence condition wherever weather-derived data is displayed
(CLAUDE.md, hard constraints). The surface carries exactly two, and the count is the design:

- **The map's own band**, overlaid on the bottom edge of the map and `MapRegion`'s obligation.
  Where it sits and what keeps it legible over tiles is
  [`map-treatment.md`](map-treatment.md)'s to say.
- **The page footer**, one persistent credit under the chart band and the whole of what is left of
  the reading below it, present in every state a selection can put the page in — the fleet's failed
  read included, which is exactly the state a credit kept inside the panel would be lost in
  ([`chart-treatment.md`](chart-treatment.md)'s "Data unavailable").

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
