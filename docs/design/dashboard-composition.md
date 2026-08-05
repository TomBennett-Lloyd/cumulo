# Dashboard composition

Design record for
[#148 — one integrated experience, not view-toggled pages](https://github.com/TomBennett-Lloyd/cumulo/issues/148),
covering how the dashboard's one surface is put together: what occupies the context region under
the map, what replaces what, what stays mounted when it is not visible, and where the two
Open-Meteo credits sit.

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
breakpoint, because the stacked arrangement a narrow screen already got is now the only one. The
composition below is unchanged by that move — what swaps, what stays mounted, and what is owed is
the same in a column as in a flow — and every "region" it names is a place in that flow.

## The context swap

**One region, directly under the map, shows exactly one of two things, and which one is a
function of state rather than of a page the reader chose.** In precedence order:

1. **A site**, while `selectedSiteId` names one.
2. **The fleet**, otherwise. This is the resting state — the aggregate is reachable by doing
   nothing, which is the issue's own requirement that "aggregate context is always reachable
   rather than a separate destination".

Below that region, unchanging: the site list, then the page footer.

**A draft used to be a third occupant, and is now a modal.** #265 moved the add-site form into a
native `<dialog>` (`apps/web/src/add-site/AddSiteDialog.tsx`), opened with `showModal()` over the
whole page. Placing a site is a short, committed detour rather than a context to read, and two
things followed from treating it as one. It stopped competing for a region it only ever borrowed:
the fleet panel is no longer hidden and a site panel no longer unmounts for the duration, so the
reading a reader had is still there, unchanged, the instant they cancel. And the region no longer
has to be scrolled into view for it — a modal is painted in the top layer over wherever the reader
already is.

Opening the draft is also no longer a bare click on the basemap: the map carries an add-site
control that arms the next click, and the mode is spent on the click that uses it
(`docs/design/map-treatment.md`, and `apps/web/src/map/MapControls.tsx`). A click on an empty spot
with the mode disarmed does nothing at all.

**A draft outranks a selection but does not clear it.** "Where shall the new site go" and "which
site am I reading" are different questions, and abandoning the first never answers the second.
That precedence used to be a rule the code had to state — the site panel's condition tested
`draft` — and it is physical now: the dialog is modal, the page behind it is inert, and there is
nothing left to outrank. What survives from the old arrangement is the half that was always the
point, that `selectedSiteId` is never cleared when a draft opens, so cancelling hands the reader
back the site they had open rather than the fleet they had left.

**The swap happens in a fixed region, so the map never moves.** That is most of the point of a
swap over a stack: the region does not lurch when a selection arrives, and the map — the thing the
reader is pointing at — keeps its geometry and its place through every context change.

**A swap scrolls the page back to the region, because being first is not the same as being in
view.** The original argument for an unbounded site list was that the context region is the first
thing under the map, so a selection always lands where the reader is looking. That holds at
`scrollTop: 0` and nowhere else. Sixty rows are taller than a screen; a reader who has scrolled
down to row forty and clicks a marker gets their answer written into a region that is now off the
top of the screen, and the only feedback they receive is a row highlight. Review cycle 1 of #148
caught it, and the full-bleed layout sharpened it rather than settling it — the region now has the
whole map band above it (`.dashboard-map` in `apps/web/src/dashboard/dashboard.css` owns that
height), so a selection lands further out of view than it did.

Two shapes were available. Bounding the list's height puts the region permanently in view at the
cost of a second scroller nested inside the first — the arrangement the redesign had just removed,
and the one that makes a reader scroll two things to reach one. Scrolling to the region on a swap
keeps the single scroller and treats the swap as the event it is. The second was chosen:
`Dashboard.tsx` holds a ref on `.dashboard-context` (the one wrapping box both occupants share,
which is why that box exists at all) and an effect brings it into view whenever `selectedSiteId`
becomes non-null. A scroll position is an external system in exactly the sense the address bar is,
which is what makes this an effect rather than a line in the click handlers (`react.md` rule 1) —
and it has to be, because a context also arrives without a click: a creation selects the site it
just made, and a `?site=` link opens on one. A draft is deliberately not one of the arrivals it
watches: the modal is over the page, so there is nothing to bring into view and scrolling the
inert page beneath it would move ground for no reason the reader could see.

It scrolls _into_ a context and never out of one. Closing hands the same region back to the fleet,
and a page that jumped on the way out would move ground the reader did not ask to move. The
scroll is instant rather than smooth: this is feedback for an action already taken, and a smooth
scroll would fight a reader who starts scrolling immediately after clicking.

**The scroll is not the focus, and both are owed.** A reader who gets the region scrolled into
view but keeps their focus where it was still reaches the swapped-in context only by tabbing
through whatever lies between, which is no answer at all for a keyboard or screen-reader user.
The settled rule, decided for the whole surface rather than for this effect: **an occupant taking
the region focuses its own heading** — the site panel, and a site arriving from a creation or from
`?site=` alike; **`Close` returns focus to the closing site's row in the list**, because the button
the reader pressed is about to be unmounted and focus would otherwise fall to `body`; and **a
dismissed draft returns focus to the map's add-site control**, the control the reader opened it
with. `react.md`'s async surface convention owns the rule; `Dashboard.focus.test.tsx` pins it.

That last one is the modal's bill, and it is worth naming because the platform normally pays it: a
`<dialog>` closed with `close()` restores focus itself, but this one closes by being _unmounted_,
and a removed dialog never runs the close steps. So the dashboard supplies the landing by hand,
from the dialog's effect cleanup rather than from its `cancel` handler — on the Escape path the
browser's own restoration is still running while `cancel` is being dispatched, and would overwrite
a focus set there. A creation is the one dismissal that has somewhere better to send the reader,
and it says so without a special case: the site panel's heading effect runs on a change of
`site.id`, and React flushes a commit's unmount cleanups before its mount effects, so the panel
gets the last word.

jsdom cannot check any of this: it implements no layout, so it has no `scrollIntoView` and no
scroll position to move. `Dashboard.test.tsx` pins the half that is the dashboard's own doing —
that a context arriving is what triggers the scroll, that the element scrolled is the context
region, and that closing triggers nothing — against a stand-in installed in
`dashboard-test-fixture.tsx`. The other half is a browser criterion: **with the page scrolled
down to the site list, clicking a marker leaves the site panel visible without the reader
scrolling back up.** The browser lane that could own it exists (`apps/web/e2e/`, `testing.md`
rule 10), and it now measures the layout the criterion is about (`composition.spec.ts` reads the
map's box and the chart's), but no spec in it reads a scroll position — the criterion is stated
here and checked by hand, not by a gate.

## The fleet panel stays mounted

`FleetPanel` is rendered always and carries a `hidden` attribute when something else holds the
region. This deliberately inverts the old nav's unmount-on-leave rule, and the reason is
arithmetic rather than taste.

There is no fleet-level endpoint. A fleet sum in live mode is a client-side fan-out of one
request per site — about eight seconds over sixty sites, paced to stay inside the API's per-IP
limiter. That is a cost worth paying once and keeping, and it is emphatically not a cost worth
re-paying every time a reader closes a site panel.

So the panel is fetched once per session and re-summed on exactly one event: a site being added,
which is the only thing that changes the sum. `refreshToken={createdSites.length}` is that event,
counted. Deselection is not an event — hiding the panel keeps its query state, and unhiding it
costs nothing and shows a chart that is already drawn.

The cost accepted in exchange: adding a site in live mode spends a fresh fan-out, bounded by
`CreationThrottle`'s three-per-minute allowance.

One implementation note that is easy to lose: `.fleet-panel` sets `display: grid`, which beats
the user agent's `[hidden] { display: none }`, so `fleet-panel.css` restates the hidden rule
explicitly. A panel that kept its state but not its invisibility would be worse than one that
unmounted.

## Capability honesty is structural

The fleet panel renders a look-back picker, and says the words "measured output", **only when the
source it holds can actually answer for them** — `dataSource.capabilities.fleetLookback` and
`.fleetActuals`, declared per implementation on `FleetDataSource`.

This settles a review finding from #150. The demo source has genuine history and genuine measured
output; the HTTP source has neither — its fan-out reaches forward only, and no actuals producer
exists (#16/#18 territory). Copy that promised history was therefore right half the time, and a
range control that rendered identical charts in live mode was worse than absent.

The fix is structural rather than editorial because the editorial version does not hold: prose
gets rewritten by someone who only ever ran the demo. Two whole copy arms sit side by side in
`FleetPanel.tsx` so the rule is auditable by reading them — the phrase "measured output" appears
only in the arm a capable source reaches, _including in the chart's accessible name_, which is
the copy easiest to leave promising something the data cannot show. When either capability
becomes true for the HTTP source, one boolean flips and the honest surface follows.

## Two credits, and why that is not one too many

The Open-Meteo credit is a CC BY 4.0 licence condition wherever weather-derived data is displayed
(CLAUDE.md, hard constraints). The surface carries exactly two, and the count is the design:

- **The map's own band**, overlaid on the bottom edge of the map and `MapRegion`'s obligation.
  Where it sits and what keeps it legible over tiles is
  [`map-treatment.md`](map-treatment.md)'s to say.
- **The page footer**, one persistent credit under the chart and table sections, present in every
  state and through every context swap.

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
ninety-second deadline, with no panel on screen to show for it. The write preserves query
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
