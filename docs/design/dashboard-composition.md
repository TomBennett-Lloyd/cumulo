# Dashboard composition

Design record for
[#148 — one integrated experience, not view-toggled pages](https://github.com/TomBennett-Lloyd/cumulo/issues/148),
covering how the dashboard's one surface is put together: what occupies the panel column beside
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

The redesign has one surface. The map is the canvas; a docked column beside it carries the
reading. Nothing is navigated to.

## The context swap

**One region at the top of the column shows exactly one of three things, and which one is a
function of state rather than of a page the reader chose.** In precedence order:

1. **A draft**, while the reader has clicked an empty spot on the map and the add-site form is
   open.
2. **A site**, while `selectedSiteId` names one.
3. **The fleet**, otherwise. This is the resting state — the aggregate is reachable by doing
   nothing, which is the issue's own requirement that "aggregate context is always reachable
   rather than a separate destination".

Below that region, unchanging: the site list, then the column's footer.

Two consequences are worth stating because they were choices rather than defaults.

**A draft outranks a selection but does not clear it.** "Where shall the new site go" and "which
site am I reading" are different questions, and cancelling a draft hands the reader back the site
they had open rather than the fleet they had left. The code expresses this by testing `draft`
in the site panel's condition rather than by clearing `selectedSiteId` when a draft opens — the
selection is never destroyed, only outranked.

**The swap happens in a fixed region, so the map never moves.** That is most of the point of a
swap over a stack: the column's height does not lurch when a selection arrives, and the map — the
thing the reader is pointing at — keeps its geometry through every context change.

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

- **The map strip**, which belongs to the map and is `MapRegion`'s obligation.
- **The column footer**, one persistent credit at the foot of the panel column, present in every
  state and through every context swap.

The arrangement the old views had — a credit inside each panel — is what this replaces. Those
multiplied with the panels, and each one came and went with whatever mounted it, which meant the
credit was reliably missing in exactly the states nobody looks at. A credit that belongs to a
_column_ rather than to a panel cannot be lost by a selection. The app-level error boundary
carries one too, so a crashed tree does not drop the obligation with the render.

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
- **The map shell's older placeholder treatment**, which is #161's remainder to convert.
