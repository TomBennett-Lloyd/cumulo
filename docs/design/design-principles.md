# Design principles proposal — distilling the owner's taste into prospective rules (#337)

Design record for
[#337 — distil the owner's design feedback into design principles that bind from the start](https://github.com/TomBennett-Lloyd/cumulo/issues/337),
covering the distillation itself: the evidence corpus read, the thirteen principles and the
grounding behind each, the counterfactuals, the binding mechanism, and the owner's answers that
closed the open questions.

**Status: adopted. Approved by the owner in session on 2026-08-10**
([approval comment](https://github.com/TomBennett-Lloyd/cumulo/issues/337#issuecomment-5235126347))
**and adopted by the commit that added this file.** The body below is preserved exactly as it was
reviewed, so where it calls itself a proposal, calls its §3.3 text a draft, or describes the
standards doc and the trigger row as things that would land later, it is describing its state at
review time, not its state now.

This document is the rationale and the record of the decisions; the operative copy of the rules is
[`docs/standards/design.md`](../standards/design.md), which is what agents read when the CLAUDE.md
trigger fires. Where this document and that file diverge, the standards file wins.

One part of the body is deliberately not adopted by the commit that added this file: §3.4's
"cheap to add mechanically" candidates ship as their own follow-up tickets (§6 step 3), so no
stylelint, eslint or test change rode in with the doc.

**Status: proposal for owner review.** Nothing here lands until reviewed; the draft
`docs/standards/design.md` in §3 rides the normal PR route afterwards (CLAUDE.md's trigger-line
edit is a `humanAlways` path).

**Evidence corpus read in full:** issue #265 (body + both feedback rounds + plan + close-out),
issue #284 (D1–D18 decision record, three plans, every review-cycle comment, close-out), the
2026-08-10 batch (#323, #324, #325, #326, #327, #328, #329, #330, #331, #335, plus the late
additions #339 focus-ring discipline, #340 close-icon-not-word, #343 tooltip post-paint resize,
#344 fleet-summary verbosity + selectors-never-wrap), the owner's 2026-08-10 answers to this
proposal's seven open questions (§5, now a decisions record), #290, #291,
`docs/review-feedback.md` (no design-category entries — design feedback lives on the issues),
`docs/design/*.md`, `docs/standards/react.md` and `structure.md` (house style), CLAUDE.md
(standards index, frontend gate).

---

## 1. The principles

Thirteen principles. Each generalizes several feedback instances; per the charter, the aim is
the taste, not the tickets. Citations are the grounding evidence — every principle traces to at
least two independent owner asks (P13's second source is the owner's 2026-08-10 answers, §5),
and anything the corpus did not support was left out.

### P1 — Production bar, conventional grammar, every device

**Rule:** The demo must read as a production application from an established business — **on
every widely-used device**: mobile is a first-class viewing context (the hiring manager opening
the demo on their phone is a canonical persona), never an adaptation afterthought. When a
standard idiom exists — header furniture, burger menu, About-in-menu, search-in-header, ARIA
combobox, native `<dialog>`/`<details>`, axis titles parallel to their axes — use it. Invented UI
has to beat the convention, not tie it.

**Why:** The owner's first live session set exactly this bar ("not a POC — the demo must read as a
production-ready application for an established business in this field"), and every subsequent
correction toward convention (text "Menu" → burger icon, product blurb → About dialog, axis
labels top-corner → rotated/centred titles) was the owner pulling an invented shape back to the
standard one.

**Grounding:** #265 body (the bar, themes 1–4), #284 D10 (axis titles parallel to axes), D13
(product info belongs in Menu → About, not a header (i)), D16 (burger icon "standard hamburger"),
D17 (mobile search collapse — the standard mobile pattern, focus within the gesture), #340
(close is always an icon — standard dismissal iconography, the same move as D16); #326
("viability on all currently widely-used devices") plus the owner's §5.6 answer (mobile
first-class, hiring-manager-on-phone).

### P2 — Chrome earns its place

**Rule:** Every visible piece of text or control must serve a reader decision the UI does not
already serve. Text that states what the page already shows does not ship: no window label under
an axis that shows the window, no written instructions for an affordance a control can carry, no
`:00` on hourly ticks. A fourth example stood in that list — "aggregated from 60 sites" beside a
chart said to show exactly that — until the owner reversed its deletion on 2026-08-11; §2 item 1
records what that boundary case does and does not do to this rule, and the short version is that
a chart of summed kW does not state how many sites it summed. If a
label's only real job is naming something for assistive technology, it becomes an accessible
name, not visible text — a move the owner has now made twice, which makes it a confirmed rule,
not a one-off: the window label (#329) and the word "Close", which "should always be a close
icon" with the word surviving only as the icon's accessible name (#340). Genuine explanation
with no other home goes behind an (i) or About — and even an (i) goes when it duplicates visible
structure or an existing home. Every copy-touching change asks one standing question: **"do we
need this copy at all, or could it be represented visually instead?"** (owner, §5.7). And there
is no orientation carve-out: nothing in the product currently needs first-time explanation
(§5.1); a future feature that isn't self-evident is first a design smell to fix structurally,
not a prompt for explainer text.

**Why:** This is the single most-repeated correction in the corpus — seven independent instances
of the owner deleting shipped prose/labels, phrased once as the general rule: "the UX should be
self-explanatory enough that we don't need random bits of text stating the obvious — or is this
for screen readers too?" (#329).

**Grounding:** #265 round 2 item 11 (add-site mode button "instead of written instructions
cluttering the page") and item 12 (descriptions out of flow into (i) tips); #284 D5 (delete the
"About this window" tip — "the x-axis states the window"), D9 (drop the `:00` — "minute
resolution is noise"), D13 (delete the header (i)); #323 (remove "aggregated from 60 sites" —
reversed by the owner on 2026-08-11, §2 item 1);
#329 (window label: drop visible text if the accessible name can carry it); #340 ("we should
never have the word 'close', it should always be a close icon" — the second visible-text→
accessible-name move, and D16's burger precedent applied by the owner to a new control); #344
(the fleet summary is too verbose — the third auxiliary-text-yields instance, this time with
the motive explicit: the text was crowding the controls beside it).

**Boundary:** licence-mandated chrome is the one exception — it compacts to the sanctioned
minimum ("compact it, never drop it", #323; the #294 amendment defines the sanctioned compact
form), it never disappears. And state is not description: "no measurements" notices and failure
alerts stay inline (#265 C10 drew exactly this line and it was never corrected).

### P3 — The important content owns the viewport (prominence, not density)

**Rule:** The map and the chart are the page; everything else folds (a closed `<details>`),
floats (popover, dialog, header overlay), or docks (header). New content defaults to a folded or
floating home — never a new always-open section, and **never a boxed container**: a panel taxes
its contents with spacing twice (edge-to-contents and panel-to-surroundings), so the same
content costs more room and the page reads _more_ cluttered. The goal is not density — it is
prominence for the important content and the removal of clutter; auxiliary information shrinks
so the data can breathe, and whitespace that serves the data is not the enemy. Standing
acceptance criterion: map + heading row + full chart visible in one viewport without scrolling —
on the desktop reference size _and_ a mobile twin (P1: mobile is first-class).

**Why:** Three passes converged monotonically on this: full-bleed map, chart directly beneath at
all widths, site panel deleted in favour of a map popover, table folded closed, raw-data table
folded closed, chart cap removed, then the fleet panel itself removed. Each removal was owner-
initiated; none was ever reversed. The owner's §5.2 answer supplies the mechanism the tickets
only implied: the panel went because its box _cost_ space, not because density was wanted.

**Grounding:** #265 themes 4–8 (full-width map, chart beneath, collapsible table, selection as
series + popover instead of a section); #284 D3 (chart fills panel, table behind "Raw data"),
D15 (the graph in the first viewport — "map height is right", the rest compresses); #323 (remove
the fleet panel, graph takes full width); owner §5.2 (the container tax, prominence over
density); owner §5.6 (mobile twin).

### P4 — Adjacency is information

**Rule:** Elements that form one reading unit touch; a visible gap or band between two elements
says they are unrelated. When placing anything, decide which unit it belongs to and let the
spacing say so — and treat every seam's padding as a claim that the two sides are separate
things. This is **not a density mandate** (owner, §5.2): whitespace that separates genuinely
unrelated things, or gives the important content room, is doing its job; the target of every
compression ask was clutter — spacing that claimed a separation nobody meant.

**Why:** The owner's "full width" question resolved not as a width preference but as a
relatedness statement: "the graph and the map feel like parts of the same section" — with the
attribution band's padding explicitly named as "a break between map and graph" to be reduced.

**Grounding:** #323 (one section; remove panel spacing; reduce attribution band padding; reduce
button height); #265 theme 6 ("directly beneath it"); #284 D4 (three stacked header lines → one
row), D15 (compress the map-to-chart stack); owner §5.2 (the reframe).

### P5 — Missing data reads as missing

**Rule:** An absent value gets visible absence: a dash in the tooltip, a break in the line, its
full width on the axis. Never elide it (index-compressed axis), bridge it (curve interpolation
across a gap), invent it (null → 0), or clamp it (values over 100% draw over 100%). When an
absence marker is ambiguous, fix the structure that makes it ambiguous — do not remove the
marker.

**Why:** The owner stated the theme verbatim, twice: "both are about missing data being _visible_
as missing rather than papered over" (#325, echoed in #330). It is also the one place the corpus
contains a reversal (D6a removed dashed tooltip rows; #330 reinstates the dash) — see §5 for the
reconciliation, which is itself part of the rule's second sentence.

**Grounding:** #325 (time-proportional axis: a missing hour keeps its width; a compressed gap is
"a spatial artefact that misrepresents the gap"); #330 (missing datapoint must render `-`); #290
(index-spaced axis elides the partial current hour); #284 D8 as constrained (monotone curves
because "smoothed ink never implies a value outside the data"; gaps stay breaks); #291 (no
clamping — "values can exceed 100% only if data does — honest"); #264's "honest label" lineage
(simulated actuals say so).

### P6 — Fixed reference frames: nothing shifts under the cursor

**Rule:** Interactive readouts keep stable geometry: columns share fixed x-positions across
samples, so a moving cursor changes the values, not the layout. Position may track the pointer
continuously; content updates only at data cadence (the x-midpoint between samples). If text
shifts horizontally while the pointer moves, the layout is wrong.

**Why:** The owner asked for this twice — once as the columnar tooltip, once, after it shipped
imperfectly, as the explicit property: "each column left-aligned, so no text shifts horizontally
as the cursor moves between timestamps. This was prior owner feedback." A repeated ask stated as
an invariant is taste, not a ticket.

The frame is stable in time as well as space: geometry settles **before** first paint — a
surface that appears and then visibly resizes a frame later is the same defect as text shifting
under the cursor.

**Grounding:** #284 D12 (columnar tooltip: [swatch][name][value], names and values each
left-aligned in their own column); #330 item 2 (the same, restated as the no-shift property);
#284 D7 (tooltip position moves with the pointer, data switches only at the midpoint between
points); #343 (the tooltip resizes after its first render on mobile — measure before paint).

### P7 — Measure the container, never assume the viewport

**Rule:** Layout decisions derive from measured available space, not viewport breakpoints. For
regularly-spaced components that exist in several format versions (axis ticks are canonical):
measure the container, divide by the slots, choose the largest version whose measured requirement
fits the per-slot width. Because fit is proven from the container inward, a parent changing width
never invalidates the logic. A viewport breakpoint is the documented escalation (the stylelint
census owns them), not the default. Controls have wrap priority over auxiliary text: the owner
has stated one such invariant outright — **the window selectors stay on one line at every screen
size** (#344) — so when a row cannot hold both its controls and its text, the text yields
(compacts or goes, P2), never the controls' layout.

**Why:** Stated by the owner as the strategy itself, with the mechanism spelled out (#326), and
applied by them to a concrete case the same day (#327: search fills the logo–menu gap up to a
500px cap, centered beyond — a container-derived rule, not a viewport one). D9's sizing demand —
"labels can NEVER overlap … achieved by thinning labels to what the measured width affords, not
by shrinking text" — is the same idea a round earlier.

**Grounding:** #326 (the pattern, the audit of the shipped breakpoints, the census rule); #327
(fill-with-cap, centered); #284 D9 (measured width affords the label count); D18 as executed
(wrap width measured, not guessed); #344 (the never-wrap invariant on the window selectors, at
every screen size — mobile included, per P1).

### P8 — Typographic weight follows importance, as a gradient

**Rule:** How secondary a piece of text is drives **both** its size and its contrast, together
and gradually (owner, §5.3). Chrome text a reader consults while reading the data (axis labels)
takes the smallest step of the type scale and recovers legibility through a higher-contrast ink;
text almost nobody reads (the attribution band) may be both small _and_ subdued — "nobody reads
it unless they're keen". Size never comes from outside the scale, never scales with its
container, and the series colours are never the compensation lever. Fit problems in chrome text
are solved by thinning or format-switching (P7), not by shrinking below the scale. One hard
boundary: the Open-Meteo attribution link may be subdued but must stay visible and legible in
every state — CLAUDE.md owns that constraint; this rule points at it rather than restating it.

**Why:** The owner's correction was two-sided and precise: "the graph's axis labels are far too
large: use the smallest font size in the type scale, compensating with a higher-contrast colour
so they stay legible — and do not change the series line colours to match" — then generalized in
§5.3 to a gradient: it "depends how secondary", and contrast grades down with importance just as
size does. Combined with D9's "don't shrink text to fit" and wave C's 1:1 geometry ("text never
scales with the panel"), the taste is: importance sets the typographic budget; the scale sets
the sizes; contrast is the fine adjustment inside AA where AA applies.

**Grounding:** #323 (smallest size + higher contrast + series colours untouched); #284 D9
(thin, never shrink); owner §5.3 (the gradient, the attribution example, the CC BY boundary);
the wave-C 1:1 viewBox decision the owner's D15/D9 asks forced (axis text pinned to the scale
regardless of panel width).

### P9 — One meaning, one treatment

**Rule:** Every distinct visual meaning gets a treatment distinguishable at a glance, and every
treatment maps to exactly one meaning. Before adding any mark, enumerate the marks it must be
told apart from, and check the distinction survives a squint in both themes.

**Why:** The owner asked for it in both directions: distinguish the horizon rule from the cursor
rule (D11), then pre-emptively required the day-boundary lines to be "visually distinct from the
forecast-horizon line … three line meanings must stay distinguishable at a glance" (#335). The
"do not change the series colours" clause of #323 is the same rule's other face: a treatment
already carrying a meaning is not available for a new job.

**Grounding:** #284 D11 (dashed horizon vs thicker strong-ink crosshair); #335 (three line
meanings); #323 (series colours are spoken for); `chart-treatment.md`'s slot discipline (slot 1 =
forecast family everywhere; actuals = ink, deliberately outside the categorical budget) — which
the owner has never once corrected, making it revealed taste.

**Boundary (owner, §5.4):** this rule governs _meanings and treatments_, never palette values —
colour values stay owned by `chart-treatment.md` and the tokens file's validation record, and
the accent hue is decided (#273, 2026-08-09: candidate B `#1d63bd`, sibling tokens follow).

### P10 — Context is drawn, not written

**Rule:** When the reader needs context to interpret the data — why the series dips, where days
turn, which site is producing — prefer a subtle graphical layer behind or beside the data (night
shading, day-boundary lines, linked marker colour) over a sentence, label, or legend entry about
it. Context layers are decoration to a11y: out of the tab order, at most one phrase of accessible
description.

**Why:** The owner's additive asks are all of this shape: shading "so the diurnal shape of the PV
series reads against its cause" (#335), cursor-linked map marker colours (#324) — while every
textual explanation got deleted (P2). Read together: the appetite for information is high; the
appetite for words is near zero. Density of meaning, not of ink.

**Grounding:** #335 (night shading, day boundaries, the a11y bound); #324 (graph cursor drives
marker colours); #291 (unit toggle for comparability — context via transformation, not
annotation); contrast with the P2 deletions.

### P11 — Calm focus: rings and moves only when they serve the reader

**Rule:** Focus stays where the reader put it unless the page changed in answer to their action
_and_ the change is where their next act lives. Deep links and URL-driven state never move focus.
Pattern-conventional widgets keep their own focus discipline (a combobox selection keeps focus in
the input). And a focus _ring_ is painted only when it informs the current interaction — keyboard
navigation, or typing in a field; pointer interaction paints no rings (`:focus-visible`
discipline, never bare `:focus`). That parenthesis was the whole of the mechanism until #440 found
the case it does not cover: a `hasTouch` Chromium probe measured a tapped chart holding focus with
`:focus-visible` **false** and a ring painted anyway, so a rule carrying that conjunct is evaluated
by the same engine that answered false and cannot match. Where an engine's heuristic gets a pointer
focus wrong that way, the element now carries a **focus-source guard** instead — observing how its
focus arrived rather than asking the engine, and suppressing the ring on what it observed, with no
pseudo-class in the rule at all. `docs/standards/design.md` rule 11 is where that addition is
operative; the sentence above is what this document reviewed, and the addition refines its
mechanism rather than reversing its taste. A visible ring the reader didn't ask for is a defect
signal, not a feature.

**Why:** Four rounds of owner feedback on one theme, each moving toward less visible focus
machinery: heading focus (#260 convention) → "that seems a bit wrong … perhaps the forecast
duration buttons" (D14) → "focus simply stays in the search input" (#328) → "we shouldn't have
visible focus states unless they're really needed (e.g. someone is typing in the search bar or
someone is actually using keyboard nav)" (#339, stating the general rule directly). The stable
preference underneath: no gratuitous jumps, no surprise rings — focus visibility is for the
people navigating by it.

**Grounding:** #339 (the general `:focus-visible` rule, owner-stated); #328 (D14 resolved: stay
put); #284 D14 (the visible ring on the site name "seems a bit wrong" — in hindsight the first
sighting of #339's rule); #260/#279 (deep-link selection focuses nothing — the settled asymmetry
in react.md, which stays).

### P12 — Interaction performance is a demonstrated feature

**Rule:** Pointer-driven surfaces are engineered for smoothness as a design property: position
updates via transform at pointer rate (throttled ~30/s), content updates at data cadence from
precomputed rows, data layers never re-render per pointer frame. The claim is measured and where
feasible asserted, not assumed ("a measurement printed is not a measurement asserted").

**Why:** The owner made it identity-level: "this is something I've done very well at in other
projects so I'd like to make sure I demonstrate that here" (#331). D7 was already a full render-
discipline spec from the owner personally — throttle rate, midpoint switching, and "ensure the
tooltip contents don't re-render at that frequency". Frugality is the same taste applied to the
network: linked hover "must work from data the dashboard already holds" (#324).

**Grounding:** #331 (prioritisation + fix direction); #284 D7 (the owner's own render-discipline
spec); #324 (no extra fetches); #293 (memoise the aggregation off the hot path); #343 (visible
post-render resize on mobile — layout work that should have happened before first paint).

### P13 — Motion is smooth, brief, and optional

**Rule:** State changes prefer a smooth transition over a jump cut where one is possible —
bounded twice: every transition respects `prefers-reduced-motion` (reduced means none or
near-none), and no transition ever delays or blocks the interaction it accompanies (the new
state is usable immediately; the motion is presentation, not a queue).

**Why:** The owner's §5.5 answer states the taste directly: "smooth transitions are much nicer
where possible." It is consistent with the two motion asks already in the corpus — D7's
smoothly-tracking tooltip (with its own don't-let-motion-cost-performance bound) and the map's
eased camera moves, never corrected — and P12 supplies the performance bound from the same
voice.

**Grounding:** owner §5.5 (the taste + both bounds); #284 D7 (smooth tracking, throttled);
`easeTo` camera moves (#265 C4/C7, shipped and never corrected — revealed taste).

---

## 2. Where each principle would have changed a past outcome

Four concrete counterfactuals, for credibility:

1. **P2 (chrome earns its place) — the window-label family, three rounds of rework.** The
   horizon caption shipped in #265 C10 behind an "About this window" (i); #284 D5 deleted that
   tip ("the x-axis states the window") but kept a visible `windowLabel`; #329 now removes the
   visible label too (accessible name only). The fleet-stats line ("aggregated from 60 sites")
   shipped in #284 D4's heading row and was removed by #323 — and then came back: the owner
   reversed that one clause on 2026-08-11 (#431), and the numbers are visible text again
   wherever the row can hold them (`dashboard-composition.md` records the reversal;
   `apps/web/src/dashboard/FleetPanel.tsx` carries the argument). Had P2 existed, the first
   three do not ship: the implementer's test — "what reader decision does this text serve that
   the page doesn't already?" — fails each of them at design time. The fourth is kept here as
   the counter-example it turned into, because a principle's boundary is worth more than a
   tidy count: P2 would have blocked at design time a line the owner has since asked for, and
   the reason it survives the test on re-reading is that the site count is not something the
   plot states — a chart of summed kW never says how many roofs it is a sum of. What #344
   actually objected to was the row's width, which is now answered by measurement rather than
   by deletion. Estimated avoided rework: parts of #284 C5/wave-B plus two 2026-08-10 tickets.

2. **P7 (container measurement) — wave D's breakpoints, retired the week they shipped.** #284
   C11/C12 introduced the repo's first two viewport media queries (header collapse, attribution
   compaction), each carefully measured, reviewed across three cycles, and documented in the
   stylelint census. #326 now directs converting exactly this class of decision to
   container-measured selection, and #327 re-does the search bar's width logic on container
   terms. Had P7 existed, waves C/D build the measure-divide-fit primitive once and the header,
   attribution, and axis all consume it — no breakpoint census entries, no #326 audit, no #327.

3. **P5 + P6 (missing data + fixed frames) — the tooltip dash reversal.** #284 D6(a) deleted
   absent rows from the tooltip because the trailing-name layout made the dash unattributable
   ("hard to tell what the `-` belonged to", #330). D12 then fixed the layout (columns); #330
   now reinstates the dash the columns make legible. Had both principles existed, D6 is
   diagnosed as a P6 violation (unstable attribution), not a P5 exception: fix the columns,
   keep the dash — one chunk instead of a delete-then-restore cycle across two passes, plus the
   review effort spent pinning the deletion with tests that #330 now unwinds.

4. **P3 + P4 (data owns the viewport, adjacency) — the fleet panel's three-pass shrink.** #265
   C3 kept the chart inside a padded fleet panel capped at 46rem; #284 D3 removed the cap and
   folded the table; D4/D15 flattened the header and compressed the stack; #323 removed the
   panel and its spacing entirely. Four converging corrections of one shape. (The heading row
   #323 emptied was refilled on 2026-08-11 — item 1 above — which reverses one clause of that
   ticket and none of this shape: the panel, its box and its measure stayed gone.) Had P3/P4 existed
   at #265 planning, the "chart directly beneath the map" theme reads as "chart and map are one
   unit at full width" from the start — the panel chrome never ships, and D3's "full width"
   ambiguity (the 72rem-vs-viewport question the plan had to flag) never arises.

---

## 3. Binding mechanism

### 3.1 Where it sits

`docs/standards/design.md`, joining the standards index. The existing `docs/design/*.md` files
are _records_ of decided surfaces (chart-treatment, map-treatment, dashboard-composition — "the
reasoning a diff cannot carry"); the standards doc is _prospective_ — the rules an implementer
applies to a choice no record has decided yet. The two link one hop each way and do not overlap:
when a design.md rule gets decided into a surface, the outcome lands in that surface's record.

### 3.2 CLAUDE.md standards-index trigger line (for the index list)

> - Adding, moving, or restyling anything a user sees — a component, layout, spacing, visible
>   text or label, chart mark, breakpoint/media query, focus or hover behaviour? →
>   `docs/standards/design.md`

(Broad on purpose, matching the index's style of firing on the tempting act: the costliest
misses in the corpus were "small" additions — a label, a padding, a breakpoint. The owner
confirmed the breadth in §5.7, with the copy-edit rider now inside rule 2.)

### 3.3 Draft `docs/standards/design.md` (full text, house style)

```markdown
# Design standards

**Trigger:** adding, moving, or restyling anything a user sees — a component, layout, spacing,
visible text or a label, a chart mark, a breakpoint or media query, focus or hover behaviour.

These are the owner's standing design decisions, distilled from the #265/#284 design passes
(D1–D18), the 2026-08-10 feedback batch, and the owner's 2026-08-10 answers to the distillation's
open questions (#337 is the distillation record). They are prospective rules for choices no
design record has decided; the decided surfaces live in `docs/design/chart-treatment.md`,
`map-treatment.md`, and `dashboard-composition.md`, and a rule here that gets decided into a
surface lands in that surface's record.

## Rules

1. **Production bar, conventional grammar, every device.** The demo reads as a production
   application for an established business — on every widely-used device: mobile is a
   first-class viewing context (a hiring manager on their phone is a canonical viewer), never
   an afterthought. Where a standard idiom exists — header furniture, burger menu, About in
   the menu, ARIA combobox, native `<dialog>`/`<details>`, axis titles parallel to their axes —
   use it; invented UI must beat the convention, not tie it.
   (#265; #284 D10/D13/D16/D17; #326; owner 2026-08-10)

2. **Chrome earns its place.** Before shipping visible text or a control, name the reader
   decision it serves that the page does not already serve. Text stating what the UI shows does
   not ship; a label whose only job is naming for assistive technology becomes an accessible
   name, not visible text — the window label (#329) and the word "close" (#340, always an icon
   whose accessible name stays "Close") are the settled instances of that move. Every
   copy-touching change also asks: **do we need this copy at all, or could it be represented
   visually instead** (rule 10)? Genuine explanation with no other home goes behind an (i) or
   About — and goes entirely when redundant with visible structure; there is no onboarding
   carve-out — a feature that is not self-evident is first a design smell to fix structurally,
   not a prompt for explainer text. State (notices, alerts) is not description and stays
   inline. Licence-mandated chrome compacts to its sanctioned minimum and never disappears —
   the Open-Meteo link is non-negotiable in every state (CLAUDE.md).
   (#265 items 11–12; #284 D5/D9/D13; #323; #329; #340; #344; owner 2026-08-10)

3. **The important content owns the viewport — prominence, not density.** Map and chart are the
   page; everything else folds (closed `<details>`), floats (popover, dialog, header overlay),
   or docks (header). New content defaults to a folded or floating home, never a new
   always-open section — and never a boxed container: a panel taxes its contents with spacing
   twice (edge-to-contents and panel-to-surroundings), costing space and reading as clutter.
   The goal is prominence for the data and removal of clutter, not density: auxiliary
   information shrinks so the important content can breathe, and whitespace serving the data is
   not the enemy. Standing acceptance: map + heading row + full chart fit one viewport without
   scrolling, at the desktop reference size and a mobile twin — the e2e lane measures the
   desktop case today (`chart-surfaces.spec.ts`, D15 case).
   (#265 themes 4–8; #284 D3/D15; #323; owner 2026-08-10)

4. **Adjacency is information.** Elements forming one reading unit touch; a gap or band between
   two elements claims they are unrelated. Decide which unit a new element belongs to and let
   the spacing say so; treat every seam's padding as that claim, made deliberately. Not a
   density mandate: whitespace separating genuinely unrelated things, or giving the data room,
   is doing its job — the target is spacing that claims a separation nobody meant.
   (#323; #265 theme 6; #284 D4/D15; owner 2026-08-10)

5. **Missing data reads as missing.** Absent values get visible absence — a dash in readouts, a
   break in lines, full width on the axis. Never elide (index compression), bridge
   (interpolation across a gap), invent (null → 0), or clamp. When an absence marker reads
   ambiguously, fix the structure making it ambiguous; do not remove the marker.
   (#325; #330; #290; #291; #284 D8's monotone/gap constraints)

6. **Reference frames hold still under interaction.** Readouts keep stable geometry: columns
   share fixed x-positions across samples; a moving cursor changes values, never layout.
   Position may track the pointer continuously; content switches only at data cadence (the
   x-midpoint between samples). Geometry settles before first paint — a surface that appears
   and then visibly resizes is the same defect. (#284 D7/D12; #330; #343)

7. **Measure the container, never assume the viewport.** For regular components existing in
   several format versions: measure the container, divide by the slots, take the largest version
   whose measured requirement fits per slot — fit proven from the container inward. A viewport
   breakpoint is the documented escalation (`stylelint.config.mjs` owns the census), not the
   default. Controls have wrap priority over auxiliary text — the window selectors stay on one
   line at every screen size (#344); a row that cannot hold both its controls and its text
   yields the text (rule 2), never the controls' layout. (#326; #327; #284 D9/D18; #344)

8. **Typographic weight follows importance, as a gradient.** How secondary a text is drives
   both its size and its contrast, together and gradually: axis labels — chrome a reader
   consults — take the smallest scale step with a higher-contrast ink; text almost nobody reads
   (the attribution band) may be small and subdued. Size never leaves the scale, never scales
   with its container, and series colours are never the compensation lever. Fit is solved by
   thinning or format-switching (rule 7), never by shrinking below the scale. Boundary: the
   Open-Meteo attribution link may be subdued but stays visible and legible in every state —
   CLAUDE.md owns that constraint. (#323; #284 D9; owner 2026-08-10)

9. **One meaning, one treatment.** Each distinct visual meaning gets an at-a-glance
   distinguishable treatment; each treatment maps to one meaning. Before adding a mark,
   enumerate the marks it must be told apart from, in both themes. A treatment already carrying
   a meaning (the series hues, the horizon dash) is not available for a new job. This rule
   governs meanings and treatments, not palette values — those stay owned by
   `chart-treatment.md` and the tokens file, and the accent hue is decided (#273).
   (#284 D11; #335; #323; owner 2026-08-10)

10. **Context is drawn, not written.** When data needs context — why a series dips, where days
    turn, which site produces — prefer a subtle graphical layer (shading, boundary lines,
    linked colour) over a sentence or legend entry. Context layers are decoration to a11y: out
    of the tab order, at most one phrase of accessible description. (#335; #324; #291)

11. **Calm focus.** Focus stays where the reader put it unless the page changed in answer to
    their action and the change is where their next act lives. URL-driven state never moves
    focus; pattern widgets keep their own discipline (combobox selection stays in the input).
    A ring is painted only when it informs the current interaction — keyboard navigation or
    typing; pointer interaction paints none (`:focus-visible`, never bare `:focus`). A ring
    appearing where the reader didn't ask is a defect signal. The mechanics live in
    `react.md`'s focus paragraphs; this rule is the taste they serve.
    (#339; #328; #284 D14; #260)

12. **Interaction smoothness is a demonstrated feature.** Pointer-driven surfaces update
    position via transform at pointer rate (throttled ~30/s) and content at data cadence from
    precomputed rows; data layers never re-render per pointer frame; linked interactions work
    from data already held (API frugality). Measured and, where feasible, asserted — a
    measurement printed is not a measurement asserted. (#331; #284 D7; #324; #293)

13. **Motion is smooth, brief, and optional.** State changes prefer a smooth transition over a
    jump cut where possible, bounded twice: every transition respects
    `prefers-reduced-motion`, and no transition delays or blocks the interaction it accompanies
    — the new state is usable immediately, the motion is presentation. Rule 12's performance
    discipline applies to motion too. (owner 2026-08-10; #284 D7; the shipped `easeTo` camera)

## Why

Across two design passes, a feedback batch, and the owner's answers to this distillation's own
questions, the corrections were not per-ticket preferences but one coherent taste rediscovered
reactively: prominent data with the clutter removed (not density for its own sake), chrome-light,
honest about absence, stable under the cursor, measured rather than assumed, conventional where
convention exists, first-class on a phone, and fast and smooth enough to show off. Every rule
above generalizes at least two independent owner statements; the point of writing them down is
that the next UI chunk is designed to them from the start instead of corrected toward them
afterwards (#337).
```

(~115 lines — longer than most standards docs, comparable to react.md with its async section;
each rule keeps the house pattern: bold decision rule, consequences, grounding pointer. One-hop:
it points at design records, react.md, and the stylelint census, none of which point onward for
the rule's sake.)

### 3.4 Mechanical vs judgment (frontend-gate precedent)

The frontend gate's shape — colour enforced mechanically by stylelint/eslint, lengths a
documented residual — is the model. Split:

**Already mechanically asserted (no new work, name them as the principle's teeth):**

| Rule               | Existing check                                                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| P3 viewport fit    | `chart-surfaces.spec.ts` D15 case (map + heading + chart ≤ 900px)                                                                  |
| P5 gaps            | chart unit tests: `leaves hours the overlay does not cover as gaps`, two-paths gap test, monotone/no-negative-ink browser criteria |
| P6 columns         | `tooltipColumns` alignment test (all rows share nameX/valueX)                                                                      |
| P7 census          | `stylelint.config.mjs` breakpoint census (#326 keeps it as the retirement ledger)                                                  |
| P9 rules           | `chart-css-contract.test.ts` (horizon dasharray, crosshair ink)                                                                    |
| P11 focus          | `Dashboard.focus.test.tsx`, `keyboard-focus.spec.ts` deep-link never-focus case                                                    |
| P12 render cadence | `forecast-chart-tooltip.test.tsx` render-count case (#331 extends)                                                                 |
| P2 boundary        | Open-Meteo wording/visibility tests at every width (`composition.spec.ts`, `OpenMeteoAttribution.test.tsx`)                        |

**Cheap to add mechanically (candidates, each its own small ticket):**

- **P8:** extend `chart-css-contract.test.ts` to pin axis-label classes to the smallest type
  token and the designated high-contrast ink token (exact tokens decided when #323 lands).
- **P4:** per-seam e2e geometry assertions (map-bottom to chart-top gap ≤ N) once #323 fixes the
  target values — the D15 case's idiom, pointed at seams.
- **P7:** a stylelint ratchet — media-query count may only decrease (the census makes this a
  one-line rule); container-measured conversions retire entries.
- **P5:** when #325 lands, an axis-spacing invariant test (equal hours → equal width ±ε).
- **P11:** a stylelint rule (or css-contract test) rejecting bare `:focus` selectors in app
  stylesheets in favour of `:focus-visible` (#339) — same shape as the token gate.
- **P2:** extend the `state-copy-contract.test.ts` sweep idiom to reject a visible text node
  "Close" on a button (#340) — the accessible-name query (`getByRole('button', { name:
'Close' })`) stays the required form.
- **P3/P1:** a mobile twin of the D15 viewport-fit e2e case (owner §5.6: mobile first-class) —
  the lane's mobile-viewport idiom (`test.use({ viewport: { width: 390, height: 844 } })`)
  already exists for the D17 search case.
- **P13:** a stylelint/css-contract check that `transition`/`animation` declarations sit behind
  a `prefers-reduced-motion` guard (or use a shared motion custom property that a reduced-motion
  block zeroes).
- **P7 (lapsed 2026-08-11):** an e2e single-line invariant on the range-picker group at the
  mobile viewport — the group's bounding-box height ≤ 1 button height (#344's never-wrap rule,
  measured). #431 folded the three window chips behind a calendar trigger
  (`dashboard/range-picker.tsx`), so the row holds one button and there is no group left on it
  to wrap: the candidate now names nothing measurable. Recorded rather than deleted, because
  the rule it would have gated is intact — the fold is a stronger way of keeping #344's line
  than measuring it — and the fit question the row still has is answered by the container query
  `dashboard/fleet-panel.css` owns, which is P7's own idiom rather than a gate candidate.
- **P6:** an e2e no-post-paint-resize case: read the tooltip panel's box on the frame it
  appears and one poll later; the boxes match (#343).

**Judgment rules (review-lens, not lint):** P1, P2 (except the attribution boundary), P4's
unit-membership call, P9's meaning enumeration, P10, P13's where-motion-is-warranted call.
Binding: (a) the CLAUDE.md trigger routes any UI-touching chunk through design.md before acting;
(b) the reviewer agent's standards sweep includes design.md for diffs under `apps/web/src` — its
FIX-NOW/SYSTEMIC vocabulary already fits ("visible text with no named reader decision" is a
findable, arguable finding); (c) the browser-smoke checklist gains two lines: _"new visible
text/control: name the reader decision it serves; new mark: name what it must be distinguishable
from"_ and — on any copy-touching chunk, per the owner's §5.7 rider — _"do we need this copy at
all, or could it be represented visually instead?"_ This mirrors how the frontend gate works
today: the mechanical half catches drift, the residual half is explicitly on the implementer and
named in the config.

---

## 4. Tensions in the evidence, and the reconciliations proposed

1. **D6(a) (delete absent tooltip rows) vs #330 (absent values render `-`).** A genuine
   reversal. Reconciliation (encoded in P5's second sentence): the dash was never the problem —
   its unattributable layout was. Absence stays visible; ambiguity is fixed structurally. #330,
   being latest and explicit, wins; `chart-treatment.md`'s D6 paragraph moves with it.

2. **D14 (focus → range picker) vs #328 (focus stays in the search input) vs #339 (no visible
   rings outside keyboard use).** Superseded twice, not contradictory: every move was away from
   the surprising ring, and #339 finally names the underlying rule — D14's complaint ("the site
   name has a visible focus state, that seems a bit wrong") was a `:focus-visible` problem
   sighted before the vocabulary for it existed. P11 encodes the direction (stay put; rings
   only for keyboard/typing) rather than any one target, so the next opener doesn't relitigate
   it. The deep-link half of #260 is untouched throughout. Note for implementation: #339 also
   softens D14/#328's _practical_ stakes — once pointer interaction paints no rings, where
   focus lands matters mostly to keyboard and AT users, which is exactly whom the landing rules
   in react.md serve.

3. **#265 C10 (add (i) tips) vs D5/D13 (delete two of the three).** Not a reversal — a
   two-step application of one rule. The (i) was already a removal of inline prose; the second
   pass removed (i)s that duplicated visible structure (the axis) or an existing home (About).
   P2's ladder (inline → accessible name → (i)/About → gone) captures the full trajectory.

4. **D9 ("never shrink text to fit") vs #323 ("use the smallest font size").** Superficially
   opposite, actually orthogonal: D9 forbids _fit-driven_ shrinking (thin instead); #323 picks
   the _correct scale step_ for axis labels and pays for it in contrast. P7 + P8 together: size
   comes only from the scale, chrome sits at its bottom step, fit is solved by thinning.

5. **P2 (less chrome) vs P10 (more context).** Not a tension once seen together: the owner
   removes words and adds drawing. The pair is the taste's signature — density of meaning,
   economy of ink — and the proposal keeps them as two rules that cite each other's evidence.

---

## 5. Open questions — RESOLVED (owner answers, 2026-08-10)

The seven questions this proposal originally posed to the owner were answered on 2026-08-10.
This section is now the decisions record; the principles in §1 and the draft doc in §3.3 are
updated to match, so the answers below are normative and the principles are their distillation.

1. **Orientation budget: none needed today.** "Solar forecasting is fairly self-explanatory,
   especially since the fleet is pre-populated and add-a-site has sensible defaults." No
   onboarding or explainer chrome ships. The principle is conditional, not absolute: a future
   feature that genuinely isn't self-evident is first a **design smell to fix structurally**,
   not a prompt for explainer text. → Folded into P2.

2. **Density was never the goal — clutter removal is.** The fleet panel's removal was not an
   appetite for density: a boxed panel forced spacing twice (edge-to-contents AND
   panel-to-surroundings), so the same content cost _more_ space. Only auxiliary information
   was ever asked to shrink, and that was to give the important content prominence and make
   the page feel **less** dense. Normative reframe: the owner optimizes for
   important-content prominence and low clutter; **containers that tax their contents with
   double spacing are the enemy, whitespace itself is not**. → P3 reframed ("prominence, not
   density"; the container tax named), P4 gains the not-a-density-mandate clause.

3. **P8 is a gradient, not a binary.** Secondary text can usually take the smallest size, "but
   it depends how secondary" — and the same grading applies to contrast: attribution needs no
   high contrast "because nobody reads it unless they're keen". Importance drives both size
   and contrast down together. Boundary preserved: the Open-Meteo attribution _link_ is the
   CC BY 4.0 hard constraint — subdued is fine, but visible and legible in every state
   (CLAUDE.md owns the constraint; the standard points at it). → P8 rewritten as a gradient.

4. **Palette stays out of this doc.** Current palette-decision tracking (chart-treatment.md +
   the tokens file's validation record) is fine as-is. The "open" accent-hue question was in
   fact already decided: **issue #273 records the owner's 2026-08-09 decision** — candidate B,
   light-mode `--color-accent: #1d63bd` (all three AA measurements pass), sibling tokens
   (focus ring, brand mark, chart-1, map marker) follow so the brand stays one blue — which is
   the "closest match" the owner recalls choosing. Verified recorded; cited, not reopened.
   → No palette rule in design.md; P9 keeps only the treatment-is-spoken-for clause.

5. **Motion: smooth transitions are much nicer where possible.** A positive taste signal:
   transitions preferred over jump cuts, bounded by `prefers-reduced-motion` (standards
   baseline) and by never delaying interaction. → New P13 / draft rule 13.

6. **Mobile is a first-class demo surface.** "I'm a full-stack dev, I need to show I can build
   production-ready applications and mobile is important here — especially since a hiring
   manager may look at this on their phone." The hiring-manager-on-phone is a canonical
   viewing persona, not an adaptation afterthought. → P1 gains the every-device bar, P3's
   viewport-fit criterion gains a mobile twin, and this is the _why_ behind P7's
   container-measured strategy (#326's "viability on all currently widely-used devices").

7. **Trigger stays broad; copy edits get one extra test.** Any copy-touching chunk also asks:
   **"do we need this copy at all, or could it be represented visually instead?"** — the
   explicit checklist form of P2 + P10. → Trigger row unchanged; the question added to P2,
   draft rule 2, and the §3.4 judgment-lens checklist.

---

## 6. Suggested next steps

1. ~~Owner amends/answers §5~~ — done 2026-08-10; answers folded in above.
2. One PR: `docs/standards/design.md` + CLAUDE.md trigger row (humanAlways → `awaiting-review`).
3. Follow-up `discovered` tickets for the "cheap to add mechanically" items in §3.4 (now
   including the `prefers-reduced-motion` guard check from P13).
4. Reviewer/browser-smoke agent guidance gains the §3.4 judgment-lens lines in the same PR or a
   sibling workflow PR (gate changes via retro PR per CLAUDE.md).
