# Map treatment

Design record for
[#15 — design system](https://github.com/TomBennett-Lloyd/cumulo/issues/15), covering the fleet
map: what the basemap is allowed to look like, how a site marker behaves in each of its three
states, what happens when sixty markers land on one island, and where the Open-Meteo credit sits.

This document names tokens; it never restates their values. Every colour, size and radius below
resolves through a CSS custom property declared in
[`packages/ui/src/tokens/tokens.css`](../../packages/ui/src/tokens/tokens.css), which is the only
file in the repo permitted to hold a raw value. Where this document and that file disagree, the
file wins — it is the one the browser reads. The map _implementation_ is not owned here: #17
builds the map view and picks the tile provider. This is the treatment it must hold to.

## The basemap carries no colour

**The basemap is desaturated on purpose, and the markers are the only saturated thing on
screen.** This is the single decision the rest of the document depends on. The marker palette was
validated for colour-vision separation against the two chart surfaces, and that validation is
only meaningful over neutral ground: a marker that clears its neighbours by a comfortable margin
on grey can be swallowed whole by a saturated motorway casing or a green park polygon underneath
it. A map that has already spent its colour on roads and landuse has none left for data.

Concretely, the tile style #17 selects has to satisfy:

- **Greyscale or near-greyscale land, water and landuse.** Land/water separation comes from
  lightness, not hue.
- **Surfaces in the token family.** Land reads at roughly `--color-bg`, water and the map frame
  step off it the way `--color-surface` and `--color-border` step off the page — the map should
  look like part of the application, not a window cut into a different product.
- **Labels in muted ink**, at the weight and scale `--color-text-muted` implies, with no coloured
  road shields or POI pins competing with markers.
- **Two styles, one per theme**, swapped with the `data-theme` attribute. The dark basemap is
  chosen against the dark surface, not produced by inverting or CSS-filtering the light one — the
  same rule the dark colour palette follows, for the same reason: an inverted map turns water
  into something that glows and labels into mud.

The provider must be free-tier: the platform's cost ceiling admits no per-tile bill. MapLibre GL
with OpenFreeMap or Protomaps, or a plain OSM raster layer, are all in scope; a keyed commercial
provider is not. Fixing the choice is #17's job, and it is deliberately deferred because the
treatment above is a constraint on _any_ of them rather than a description of one.

## Site markers

A site is a **circle** — `--radius-full`, one flat fill, one ring, no drop shadow, no teardrop
pin. Circles are the shape whose centre is unambiguously the coordinate, which matters when five
sites sit two kilometres apart; a pin's tip and its visual mass are in different places, and at
cluster density that reads as sites drifting.

| State        | Fill                          | Slot               | Diameter                        |
| ------------ | ----------------------------- | ------------------ | ------------------------------- |
| **Default**  | `--color-map-marker`          | categorical slot 1 | `--space-3`                     |
| **Hover**    | `--color-map-marker-hover`    | categorical slot 3 | `--space-4`                     |
| **Selected** | `--color-map-marker-selected` | categorical slot 2 | `--space-4`, with ring emphasis |

All three states are stroked with `--color-map-marker-stroke` — the surface colour, drawn as a
2px ring, expressed as `calc(var(--space-1) / 2)` so no raw length enters a stylesheet. The ring
is not decoration and not a border: it is the spacer that keeps two overlapping markers legible
as two markers, and it is why a darker outline is never the answer to crowding. **Selected**
doubles the ring to a full `--space-1`, which is the size cue that survives at a glance from
across the map.

The three fills are categorical slots 1–3, and the assignment is not arbitrary:

- **Selected takes slot 2** (the warm one) because selection is the strongest signal the map
  emits and slot 2 has the best contrast of the three against the light surface. Selection
  persists, competes with every default marker still on screen, and has to win.
- **Hover takes slot 3.** Hover is transient and pointer-anchored — the reader already knows
  where their cursor is — so it can afford the softer hue.
- **Default keeps slot 1**, the leading blue, which is also the forecast hue in
  [`chart-treatment.md`](./chart-treatment.md): a site is the same blue on the map as its
  forecast band is on the chart.

The triad was validated together, in both modes, under the stricter all-pairs separation rule
rather than the adjacent-pairs default, precisely because default, hover and selected markers are
routinely on screen at the same instant — an adjacent-pairs pass would only have guaranteed
default-vs-hover and hover-vs-selected, and it is default-vs-selected that a reader scans for.

**Colour never carries a state alone.** Light mode carries the documented contrast warning on
slots 3, 4 and 5 against the light surface — slot 3 is the hover fill — so the relief rule
applies here directly: hover always brings a labelled tooltip naming the site, selection always
opens the site's detail panel, and both change the marker's size. A reader who cannot separate
the hues still gets the state from the label and the geometry. The site list under the map is
the table view: every marker state has a row equivalent, and the map is never the only way to
reach a site.

**Hit targets are bigger than the marks.** A `--space-3` circle is a 12px target, which is fine
to look at and hostile to click. The interactive area is a transparent circle of at least
`--space-6` centred on the marker — larger than any painted state — so hover and selection do not
require precision. Markers are focusable in the site's own order, and the keyboard focus
treatment is the selected treatment plus the platform focus ring: everything reachable by pointer
is reachable without one.

**Marker size is zoom-invariant.** Markers are UI drawn on top of geography, not geography. A
site does not become more or less important because the reader zoomed out, and a marker that
scales with zoom silently encodes something the data does not say.

## Fleet scale: sixty markers, twelve places

The seed fleet is 60 sites across 12 cluster centres, jittered by roughly two kilometres —
see [`fleet-simulation.md`](./fleet-simulation.md). At the zoom level that shows Ireland and the
UK at once, that is not sixty markers: it is twelve knots of five overlapping circles, and the
honest count is unreadable. So the map clusters.

- **Below the zoom at which a cluster's members separate, the cluster collapses to one marker**
  carrying a count. The cluster bubble uses `--color-map-marker` with the same
  `--color-map-marker-stroke` ring; the count sits inside it in `--color-accent-contrast` at
  `--text-xs` and `--font-weight-semibold`.
- **Cluster size steps, it does not scale.** Three diameters — `--space-6`, `--space-8`,
  `--space-12` — for small, medium and large count bands. Continuous area scaling asks the reader
  to compare circle areas, which people are reliably bad at; the count label is the precise
  channel and the three sizes are only a coarse "more than that one".
- **A cluster containing the selected site takes `--color-map-marker-selected`.** Selection must
  never disappear inside a collapsed cluster — zooming out is how a reader gets context on the
  thing they just selected, and losing it at that moment is the worst possible time.
- **Cluster hover takes `--color-map-marker-hover`**, matching site markers, and acts: clicking a
  cluster zooms to its bounds (or expands it in place) rather than doing nothing.
- **Crowding is solved by clustering, never by fading or shrinking markers.** Reducing opacity to
  cope with overlap makes density read as uncertainty, which on this platform means something
  specific and different.
- **Identity never depends on position in a list.** Filtering the fleet, panning, or zooming may
  change which markers are visible; it must never repaint the survivors. Colour follows state,
  never rank or draw order.

Encoding a site's _output_ on the map — a sequential ramp, a heatmap layer — is out of scope
here. If it arrives later it is a single-hue light-to-dark ramp with its own validated steps,
and it needs a legend; it does not get to reuse the marker slots.

## Dark mode

Every rule above is written in token names, so dark mode changes nothing structural: the same
stylesheet renders both. `--color-map-marker`, `--color-map-marker-hover` and
`--color-map-marker-selected` resolve to a separately chosen dark triad, validated against the
dark surface under the same all-pairs rule, and `--color-map-marker-stroke` resolves to the dark
surface so the ring keeps doing its job instead of becoming a bright halo. The basemap style
swaps with the theme, as above. Nothing here is a filter applied to the light rendering.

## Attribution

**Any map view that displays weather-derived data composes `OpenMeteoAttribution` from
`@cumulo/ui`.** That covers more than an obvious forecast overlay: a popup showing a site's
predicted output, a cluster tooltip carrying an aggregate, a legend for a weather-driven ramp.
The credit is a CC BY 4.0 licence condition and a hard constraint of this repo, not a courtesy —
if a weather-derived number is on screen, the link is on screen. When in doubt, compose it; there
is no cost to an attribution on a map that turned out not to need one.

Maps carry a second, independent obligation: the **tile provider's own attribution** (OSM and its
contributors, plus whatever the chosen style requires). The two are not substitutes and neither
absorbs the other.

Placement:

- Both credits live in a **persistent band across the bottom of the map**, backed by
  `--color-surface-veil` and overlaid on the tiles.

  This band used to be a strip _under_ the map, on `--color-surface`, and the argument for that
  was contrast: a caption floating on imagery has whatever contrast the pixel beneath it happens
  to give, while on a surface it has the contrast the palette was validated for. The veil is what
  carries that argument across the move (#265) — a mostly-opaque surface colour, so the ink reads
  against a mostly-known colour rather than against tiles, while the map does not stop at the
  credit line. A credit painted directly on tiles is still refused.

  The veil is validated against the composite a reader actually sees — veil over marker fills,
  land, and basemap label ink — rather than against itself, because a translucent surface has no
  contrast of its own. At the shipped mix the credit's muted ink measures 4.91:1 and its
  hover/focus ink 12.16:1, both clearing AA for small text. **That mix is the legibility floor for
  muted ink, not a taste setting**: a lower one stops the credit reading over dark basemap ink, and
  a higher one stops the map showing through, which is the whole point. The numbers and the ratio
  live in [`tokens.css`](../../packages/ui/src/tokens/tokens.css)'s validation header, which owns
  them; this document names the decision and does not restate the value.

  What forced the question was the map going full bleed
  ([`dashboard-composition.md`](dashboard-composition.md)): a strip below an edge-to-edge map is
  a band of chrome across the page rather than part of the map, and it takes its height out of
  the map on every screen.

- **Both are visible without interaction.** No "i" toggle, no hover-to-reveal, no collapsing the
  credits behind a control at narrow widths — the band wraps to two lines instead. Overlaying
  does not weaken this: the band is opaque enough to read at rest, and it is never faded,
  animated in, or suppressed while the reader is panning.
- **Both stay clickable.** The band takes pointer events like any other content; a credit whose
  link cannot be followed is not a credit, and `pointer-events: none` on an overlay is the
  obvious way to lose one by accident.
- Tile credit first, weather credit second, reading order matching what the reader is looking at:
  the map, then the data drawn on it.
- The Open-Meteo credit's own styling belongs to the `OpenMeteoAttribution` component — muted ink
  at `--text-xs`, with the **link also in muted ink, underlined**, brightening to full text ink on
  hover and keyboard focus. Map views do not restyle it, and do not hand-roll their own copy of
  the string.

  The link is not accent-coloured, and that is a legibility rule rather than a stylistic
  preference: on the veil, `--color-accent` is below AA for small text in **both** modes. Tuning
  the mix is not the way out of that, and for different reasons per mode — in light the accent is
  under the bar on the opaque surfaces too, so it has no ceiling to reach; in dark it would need a
  mix with essentially no translucency left. The per-mode numbers are
  [`tokens.css`](../../packages/ui/src/tokens/tokens.css)'s to state. Dropping the colour means
  the underline is the only thing left marking the link as a link, which is exactly what WCAG
  1.4.1 asks for and why the underline is permanent rather than revealed on hover. The tile credit
  beside it takes the identical treatment — the same obligation on the same surface, so the two
  would be wrong if only one changed.
