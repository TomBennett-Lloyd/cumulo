# Chart treatment

Design record for
[#15 — design system](https://github.com/TomBennett-Lloyd/cumulo/issues/15), direction B
("Meridian").

This is the visual spec for every chart Cumulo draws: the forecast uncertainty band, the median
forecast, the measured actuals, and the chrome around them. It is written at the SVG level and is
deliberately **library-agnostic** — the charting library for the dashboard is chosen in
[#19](https://github.com/TomBennett-Lloyd/cumulo/issues/19), and whichever one wins has to be able
to produce what is described here. If it can't, that is a reason to reject the library, not a
reason to amend this document.

Colour selection followed the bundled `dataviz` skill: the categorical slots are its fixed hue
order, both modes were validated independently with its `validate_palette.js`, and the mark specs
below are its specs, not house style. **No colour value appears in this document.** Tokens are
referenced by custom-property name only; the values live in
[`packages/ui/src/tokens/tokens.css`](../../packages/ui/src/tokens/tokens.css), which is the only
file in the repo allowed to hold them. Where the two disagree, this document is wrong, because the
tokens are the artefact that ships.

## The uncertainty band

A fleet or per-site forecast is a distribution, not a line, and the band is how that distribution
is drawn. It is the area between two quantile bounds — P10 and P90 by default — as a single closed
path:

- **Fill: `--color-chart-band-fill`.** The token resolves to the slot-1 forecast hue at **10%
  alpha**, the skill's area-fill wash. The alpha is baked into the token, so the correct SVG usage
  is `fill="var(--color-chart-band-fill)"` with **no `fill-opacity` attribute** — setting one
  double-dips and produces a band nobody can see.
- **Never the plain series colour at full opacity.** `--color-chart-1` as a solid area fill is
  banned. The band is context; the median is the value. A saturated block that size is the loudest
  thing on the chart and would be encoding the least certain information.
- **Bounds: `--color-chart-band-stroke`.** The P10 and P90 paths are each stroked as a **hairline
  (1px, solid)** in the same hue at 35% alpha. The stroke exists because the bounds are _data_ —
  they are quantiles the reader is entitled to trace — not because the fill needs an outline. The
  closing left and right edges of the path are plot boundaries rather than data and carry no
  stroke, so the band is never drawn as an outlined shape.
- **Nested bands compose by alpha.** If an inner band (P25–P75) is shown as well, it uses the _same
  two tokens_, not a second colour: two overlapping 10% washes read as a denser core, which is
  exactly the right visual for "more likely here". Only the outermost bounds are stroked, so the
  reader gets one unambiguous pair of edges rather than four competing hairlines.

## Median forecast and actuals

**The median forecast** is a **2px line, round join and cap**, in `--color-chart-1`, drawn on top
of the band it belongs to. Slot 1 is the forecast's hue everywhere in the product — the band, its
bounds, and the median line are one visual family, which is what lets a reader see the band as the
median's uncertainty rather than as a separate series.

**Actuals** are a **2px line in `--color-chart-actuals`**, a near-ink tone rather than a
categorical slot. That is a deliberate choice of direction B: the measured series is the one thing
on the chart that is not a model output, it reads as ink on the page, and it never competes with
the forecast hue for attention. It also means actuals cost nothing from the categorical budget —
slots 1–6 stay available for identity work.

**Both are drawn as monotone curves, never as a chain of straight segments.** Hourly generation is
a smooth physical quantity, and joining its samples with corners draws a fleet that changes
direction on the hour. The interpolation is **monotone cubic, in x**, and that is a requirement
rather than a preference — a library that cannot produce it fails this document on the same terms
as one that cannot produce the band. Every other smoothing family in common use — Catmull-Rom,
natural and cardinal cubics — overshoots between samples, and on a morning ramp from zero the
overshoot goes _below_ the axis, which is a chart drawing generation the fleet could not have made.
Monotone interpolation cannot: the curve's extrema are its own data points, so the ink between two
samples stays inside the range those two samples span, and a smoothed line never implies a value
nobody produced. This holds for the median, the actuals, an overlay and the band's two edges alike.

**Smoothing is ink, never data.** The hover readout, the spoken announcement and the table twin all
stay keyed to the real samples — the crosshair still snaps to an hour, and no cell ever holds a
number the curve passed through on its way between two. What the interpolation changes is where the
stroke goes between the marks, and nothing else. That also settles what the band is: an _area_
between two monotone edges rather than a shape of its own, so the P10 and P90 hairlines and the
edges of the wash are the same curve over the same points and cannot drift apart.

Composition rules that keep both legible where they overlap:

- **Draw order is back to front: grid → band fill → band bounds → median → actuals → markers.**
  Actuals are drawn last and therefore win every overlap. Where the measurement sits inside the
  band — the normal case for a good forecast — hue _and_ lightness both separate it from a 10%
  blue wash, so nothing collapses.
- **Actuals never have their opacity reduced to "let the band show through".** If the two fight,
  the band recedes; the measurement does not. There is no case where the honest fix is to fade the
  data.
- **Markers carry a 2px ring in `--color-surface`.** End-dots and hover markers are ≥ 8px
  (r ≥ 4) and ringed in the surface colour so that an actuals dot crossing the median line, or two
  dots overlapping at a shared timestamp, stay countable. The ring is spacing, not a border — no
  mark ever gets a stroke drawn around it to separate it from another mark.
- **The forecast horizon boundary is a dashed vertical hairline** in `--color-chart-grid` with a
  small direct label in `--color-chart-axis-label`, at the last timestamp with a measurement.
  Actuals stop there; band and median continue past it. On the live fleet chart they do not merely
  continue past it, they _begin_ at it — the two windows are disjoint, so the boundary is where one
  series hands over to the other rather than where they overlap. The boundary is marked once, in
  chrome, rather than by dashing the forecast line. **The dash is what makes it read as a
  boundary** ([#284](https://github.com/TomBennett-Lloyd/cumulo/issues/284) D11): drawn solid it
  wore the gridlines' ink at the gridlines' weight, so the one vertical on the plot that means
  something was told from the ones that mean nothing only by where it happened to fall. It stays
  recessive — same ink, same hairline weight, chrome rather than data — because what changed is
  legibility, not importance. This is the single exception to the no-dashed-chrome rule below, and
  it is an exception on that rule's own terms: a dash reads as a threshold, and a threshold is
  exactly what the seam is. The dash pattern itself belongs to `.forecast-chart-horizon` in
  [`apps/web/src/charts/charts.css`](../../apps/web/src/charts/charts.css) and is not restated here.
- **A gap _inside_ a series breaks the line. It is never bridged.** The horizon rule above says
  where the measurements stop; this says what a missing hour before that boundary looks like. A
  null actual ends the run and the line restarts after the gap, so the actuals series is drawn once
  per contiguous run of measured samples rather than as one path through the hole. The same holds
  for the band: an hour whose forecast carries no P10–P90 is a point estimate, and the band's
  area and bound hairlines are drawn once per contiguous run of banded samples. **And for the
  median**, which was the one series exempt from this until #264, because until then a sample
  existed only where a forecast did. It does not any more: the fleet chart's x-domain is the union
  of the forecast's hours and the actuals' hours, and in live mode those two windows are disjoint —
  the forecast read reaches forward from the clock, the actuals read reaches back from it — so
  the hours behind the horizon carry a measurement and no forecast at all. The median is drawn once
  per contiguous run of forecast samples, and an hour with no forecast gets no median mark and an
  em dash in the table twin, never a zero. A straight
  segment across a gap is a value that was never measured or never modelled, drawn with exactly the
  confidence of the values on either side of it — partial data is labelled partial, in the chart as
  much as in the API (`error-handling.md` rule 5). The gap itself is left empty: no dotted
  connector, no faded segment, nothing that could be read as an estimate of what was missing.
- **A run that would be a degenerate path is drawn in the marker vocabulary instead.** Breaking a
  series at every gap can leave a run holding a single sample, and a path with one vertex paints
  nothing at all — so an isolated hour between two gaps would vanish and the chart would silently
  understate how much was measured or modelled. It is the same defect as bridging the gap, arrived
  at from the other side. Three cases, each reusing a mark the treatment already defines rather
  than inventing a fourth:
  - An **isolated measured hour** is a ≥ 8px dot ringed in `--color-surface` — the end-dot
    vocabulary above, at an ordinary sample instead of at the horizon.
  - A **lone banded hour** draws its P90→P10 interval as a vertical **2px round-capped stroke** in
    `--color-chart-band-stroke`, and omits the wash: a 1px hairline at 35% alpha over a single
    column is invisible, which would defeat the fix, and 2px is the chart's existing data-line
    weight rather than a new one. The median line still passes through the hour, so the interval
    reads as that hour's uncertainty. An interval whose bounds coincide collapses to its round cap.
  - A **single-sample series** draws its median as a ringed dot in `--color-chart-1`.

## Legend

Several series are on the plot, so **a legend is always present** — identity is never carried by
colour alone. The three forecast entries are fixed in draw order and do not reorder or repaint when
a series is toggled off, or when a fourth arrives:

| Entry              | Swatch                                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| Forecast (P10–P90) | rect filled `--color-chart-band-fill`, with hairline top and bottom edges in `--color-chart-band-stroke` |
| Forecast (median)  | short 2px line key in `--color-chart-1`                                                                  |
| Actuals            | short 2px line key in `--color-chart-actuals`                                                            |
| _an overlay_       | short 2px line key in `--color-chart-2` — see below                                                      |

The swatch mirrors the mark: a rect for the area, a line key for the lines. The band's swatch is
the one place where the bound stroke is doing double duty — at swatch size a bare 10% wash is
nearly invisible, and the edges are what make it read as a band.

## An overlay is a fourth series, and the rules it is held to

A chart may carry **one overlay** — a second series on the same plot, in slot 2. The fleet chart is
the shipped case: selecting a site draws that site's forecast over the fleet's sum, so a reader can
see how much of the afternoon is one roof without holding two charts in their head. Four
decisions govern it, and each of them was previously written only in a code comment:

- **It appends rather than taking a place in draw order.** The legend's three forecast entries keep
  their positions and their swatches whether or not an overlay is present. Slotting a fourth entry
  _into_ the order would repaint or shift the fixed three on a selection — the exact instability
  the fixed-order rule above exists to prevent — for the sake of an ordering nobody reads the
  legend by. The mark itself is drawn between the median and the actuals, so the measurement still
  wins every overlap; the legend and the draw order are allowed to differ because they answer
  different questions.
- **The overlay draws its median only — never a band.** Its source may well carry P10–P90 (a
  per-site forecast does), and it is deliberately dropped: the band treatment at the top of this
  document belongs to the plot's primary series, and two washes over one another leave the reader
  with a question the chart cannot answer, namely whose uncertainty they are looking at. An overlay
  is a line. Measured actuals are dropped for the same shape of reason plus a cost — they are a
  second metered source call, spent to draw a second near-ink line where the treatment reserves
  near-ink for exactly one series.
- **It shares the one value axis**, like everything else here — see the single-axis rule below.
  The axis is scaled to whatever is on the plot, so an overlay running above the primary series
  raises the axis rather than being drawn off the top of it.
- **It reaches every surface from one join.** The overlay arrives in its own time base and is
  resolved onto the plot's x-domain once; the mark, the legend row, the tooltip row, the spoken
  readout and the table column all read that one result, so no two of them can disagree about what
  the overlay says at an hour. An hour the plot does not show is dropped; an hour the overlay does
  not cover is a gap, on the gap rules above.

`apps/web/src/charts/` owns the implementation of all four — `ForecastChart.tsx` composes them,
`chart-series.ts` owns the join, and `forecast-chart-legend.tsx`, `-marks.tsx`, `-hover.tsx` and
`-table.tsx` own the four surfaces. This document owns the rules; none of the values above are
restated there.

**Legend text wears text tokens, never the series colour** — `--color-text` for the label, or
`--color-text-muted` where the legend is secondary chrome. Identity comes from the coloured swatch
beside the text. This matters more than usual here: several categorical slots are too light to be
legible as text on the light surface (see below).

Direct labels ride the marks to _supplement_ the legend, never to replace it, and stay sparing —
the endpoint of the actuals line, the peak of the median, the band width at the horizon. A number
on every point is chaos and goes unread.

**A direct label never runs off the plot.** A label placed relative to its mark reads outwards
until that would cross the plot edge, then flips and reads inwards from the same mark; where it
fits on neither side it pins to the near edge rather than overflow. This applies to every label
positioned by a mark — the horizon label, the hover readout — because the mark that needs labelling
most is usually the last one, and a label clipped at the edge is worse than one overlapping its own
rule.

## Grid, axes, and the single-axis rule

- **Gridlines: `--color-chart-grid`, hairline (1px), solid, horizontal only.** Never dashed —
  dashing reads as "projection" or "threshold" when it is just a grid. The grid sits one step off
  the surface and stays recessive. The horizon rule is the one dashed mark on the canvas and does
  not weaken this: it is not a gridline, and it is dashed for the reason the grid is not — it
  genuinely is a threshold (see the horizon bullet above).
- **Axis ticks and labels: `--color-chart-axis-label` at `--text-xs`**, with
  `font-variant-numeric: tabular-nums` so tick values align vertically. Axis titles use
  `--color-text-muted`.
- **One value axis. Never two.** Power (kW) and irradiance (W/m²) do not share a plot: the
  alignment between two y-scales is arbitrary and invents a correlation the data does not contain.
  Two measures of different scale become two charts, small multiples, or both series indexed to a
  common base on one axis.

**A chart is drawn 1:1 with the width it is rendered at, and text never scales with the panel.**
The plot measures its own column and takes that width as its drawing space, so one unit of chart
geometry is one pixel on screen. The alternative — a fixed drawing space stretched to fill the
column, which is how these charts were drawn until #284 D15 — scales the _chrome_ along with the
marks: the same axis label is set at one size in a wide panel and another in a narrow one, so a
chart's type drifts away from every other size on the page, and the margins that keep a label
inside the canvas stop meaning a fixed distance. Height does not follow width. It is the owned
constant `CHART_VIEW_BOX_HEIGHT` (`apps/web/src/charts/chart-geometry.ts`, which carries the
reasoning for the value), because a kW axis rescaling on every resize would make one series a
different chart at every window size — and because the height is what decides whether the whole
plot clears the fold under the map, which is what D15 is actually about.

## The time axis

**The time axis runs on UTC.** Every label it prints is UTC wall time. The rendered value is never
the reader's local zone, and never a per-site local zone.
Settled in [#19](https://github.com/TomBennett-Lloyd/cumulo/issues/19) rather than left to whoever
writes the next chart, for two reasons:

- **The data is UTC and nothing carries a timezone.** Forecasts and readings hold `UtcIsoTimestamp`
  instants, and no site record carries a timezone through to a renderer. Site-local labelling is
  therefore a data change, not a formatting option — it wants a timezone on the site first.
- **UTC has no DST transition, so every rendered day is 24 hours.** A local axis has to show a 23-
  or 25-hour day twice a year, or silently drop or duplicate an hour. An axis that quietly loses an
  hour is the exact class of error the forecast-accuracy work exists to detect, and it would be
  introduced by the chrome.

The cost is accepted rather than hidden: through British and Irish summer time the modelled peak
sits an hour to the left of local solar noon, which reads as a modelling error to anyone who knows
where solar noon is. So a chart shown to readers who are not holding this document owes the clock
in words somewhere in its chrome — an axis title, a caption, or the table twin's heading. A
per-site local axis stays open as a product decision, gated on carrying a timezone per site; it is
not a rendering tweak.

**Settled: every chart states the clock, under the axis the clock applies to.** The time axis is
titled `Time (UTC)` beneath its labels, and the table twin heads its time column with the same
words out of the same constant — `TIME_COLUMN_HEADER` in `apps/web/src/charts/chart-copy.ts`, which
a new chart or table twin consumes rather than inventing its own spelling of "UTC". The obligation
above is only inheritable if the words are. This closes the chrome half of
[#104](https://github.com/TomBennett-Lloyd/cumulo/issues/104). The per-site local axis stays open,
still gated on carrying a timezone per site.

Until #284 D10 a second string discharged the same obligation — `Times in UTC`, floated in the
plot's top-right corner as a note about the whole chart, beside a `kW` title at the other end of
that band. One phrase, printed under the ticks it governs, replaced both: an axis title is where a
reader looks for the units of an axis, and two constants saying "UTC" were two things to keep true.

**Two tiers, and labels that thin rather than shrink** (#284 D9). The axis carries two rows: bare
two-digit UTC hours (`06`, `12`, `18`) and, beneath them, the day each run of hours falls in
(`Wed 6` — weekday plus day-of-month, because a week-long window carries each weekday twice).
Between them they say what one tier needed `Thu 14:00` on every tick to say, in about a third of
the width, which is what makes the rule below satisfiable on a narrow chart at all.

The rule is that **no label may crowd its neighbour**, stated as an inequality rather than as a
label budget: for consecutive labels in one tier, the distance between their centres is at least
half of each label's width plus a fixed gap. An axis that cannot satisfy it labels fewer instants —
never smaller ones. Text is the one thing on this canvas that does not scale with the panel (see
the 1:1 rule above), so shrinking is not an available answer, and it would trade a legibility
problem for a worse one. The invariant, the character-width model behind it and the search for the
coarsest hour step that satisfies it are `apps/web/src/charts/chart-axis-ticks.ts`'s, swept over
plot widths and window spans by its colocated suite; `apps/web/e2e/chart-surfaces.spec.ts` is what
checks the modelled widths against glyphs a browser actually shaped.

What this replaced thinned to a fixed count — at most eight labels, whatever the width — which is a
guess about how much room eight labels need. It was wrong in the narrow direction: at about 436px
of chart the `Thu 14:00` ticks ran into each other while every one of them stayed inside the
canvas, so the containment case that guards the plot edge could not see it. That is the defect
[#259](https://github.com/TomBennett-Lloyd/cumulo/issues/259) was opened about, and the invariant
absorbs it.

The day-qualified long form (`Thu 14:00`) did not go away — it moved to the surfaces that show one
instant with no neighbouring tick to qualify it: the table twin's row headers, the hover tooltip,
and the spoken readout. There a prefix is the whole of what identifies the sample.

**Axis titles run parallel to the axis they name** (#284 D10). `Power (kW)` is rotated a quarter
turn and reads up the left gutter beside the values it counts; `Time (UTC)` sits centred under the
time axis. Both used to sit side by side in the band above the plot, where `kW` was as close to the
time axis as to the one it belonged to. Position is most of what makes an axis title unambiguous,
and a rotated title costs nothing but the gutter width it already needed.

**Settled: the axis is index-spaced, and the seam is marked rather than left as a gap**
([#290](https://github.com/TomBennett-Lloyd/cumulo/issues/290)). Samples are placed at even
intervals by their position in the series, not by their distance in time. Time-proportional
placement was considered and declined: the product's series are hourly and regular, so the two
agree everywhere except across the join between measured hours and forecast ones, where the partial
current hour is elided by construction rather than drawn as a hole the reader would have to
interpret. The horizon rule already stands exactly at that join — it is where the measurements stop
— so the seam is marked by a mark that is there for other reasons, and no second one is drawn for
the elided hour. That puts real weight on the horizon rule being _seen_, which is why it is dashed
([#284](https://github.com/TomBennett-Lloyd/cumulo/issues/284) D11, in the horizon bullet above): a
seam marked by a line indistinguishable from the grid is a seam marked in name only.
Reopen this only if a data source ever produces genuinely irregular sampling,
which would make the two placements disagree about every point rather than about one.

## Categorical series order

Multi-series charts — per-site comparison, per-cluster aggregation — take
`--color-chart-1` … `--color-chart-6` **in fixed order, assigned in sequence, never cycled**. A
seventh series is not a generated hue: it folds into "Other", or the view becomes small multiples.

Slot 1 is spoken for. Any chart that shows a forecast alongside other series assigns the forecast
slot 1 and starts the remaining series at slot 2, so "blue is the forecast" holds across the whole
product. Colour follows the entity, never its rank — filtering a site out of a comparison chart
must not repaint the survivors.

Status tokens (`--color-danger`, `--color-warning`, `--color-success`) are reserved for state and
never stand in for "series 4". When a series genuinely _means_ good or bad it wears status tokens
and ships with an icon and a label; when it is identity, it wears a categorical slot. Never both in
one chart.

## Light and dark

Both modes render from **the same token names**. A chart's SVG contains `var(--color-chart-1)`,
not a mode branch; theming happens entirely in `tokens.css`, where the `[data-theme='dark']` block
re-declares every colour token. The dark values are an independently selected and independently
validated palette — steps chosen against the dark surface and run through the validator on their
own — not an automatic inversion of the light values.

The two modes are not symmetric in one respect, and it constrains chart design. On the light
surface three categorical slots land below the 3:1 mark-contrast threshold:

| Token             | Contrast on `--color-surface` (light) |
| ----------------- | ------------------------------------- |
| `--color-chart-3` | 2.74:1                                |
| `--color-chart-4` | 2.11:1                                |
| `--color-chart-5` | 2.62:1                                |

This is a documented WARN, and **a contrast WARN is not dismissable** — it obligates a relief
channel. Any light-mode chart that reaches slot 3 or beyond must ship **direct labels on those
series or the table view**; shipping the sub-threshold fill with neither is a failure, not a
tolerance. Slots 1, 2 and 6 clear the threshold on the light surface, and on the dark surface every
slot clears it, so the obligation is a light-mode, four-or-more-series condition specifically.

In practice the relief is already there, because a table view is required of every chart regardless
(next section). The rule is written out anyway so that nobody ships a light-mode comparison chart
having decided the table twin was optional.

## Hover layer and the table view

An SVG chart is interactive by default; the hover layer is part of the deliverable.

- **A crosshair finds the X.** A vertical line tracks the pointer and snaps to the nearest
  timestamp — readers aim at a time, not at a 2px line. It is drawn **solid, at the data weight
  (2px), in `--color-text`** ([#284](https://github.com/TomBennett-Lloyd/cumulo/issues/284) D11):
  chrome, but the reader's own chrome rather than part of the frame. The plot draws exactly two
  vertical lines — the horizon rule and this — and at the grid's hairline weight in the grid's ink
  they were the same mark twice over, separated only by the fact that one of them moved. The grid
  is no part of that: it is horizontal only (see the gridline bullet above), so orientation tells
  it from both before ink or weight is asked to. Full ink at the data weight is what separates the
  pair at a glance, with the horizon's dash doing the other half of the work, and the crosshair can
  afford to be the loudest thing in the chrome because it exists
  only while a pointer is held on the plot and leaves with it. No new token: `--color-text` is the
  strong ink in both modes and already the validated body ink on these surfaces, so a stroke drawn
  in it inherits a measurement rather than owing one.
- **One tooltip, every series present at that timestamp.** The readout lists the actual, the
  median, the P10–P90 range and an overlay if the chart carries one — so the pointer never has to
  land on a line or inside the fill to get a number. **The rows are two columns**
  ([#284](https://github.com/TomBennett-Lloyd/cumulo/issues/284) D12): the series name in
  `--color-text-muted`, then its value high-contrast in a column of its own, every name starting at
  one x and every value at another. Packed instead — each value beginning wherever the text to its
  left ended — comparing two numbers was an eye-movement rather than a glance; the panel is a small
  table and now reads as one. The **name leads**, because a column of labels is what a reader scans
  down, and because the spoken readout is composed from the same rows and "Median 6.0" is how a
  label reads aloud. Series are keyed with a short stroke of their
  colour, not a filled box — shorter since D12, since a key beside a name column is read as a
  colour rather than as the start of a line of text. **A series with nothing at the sample gets no
  row**, drawn or spoken:
  the band where a point carries no modelled uncertainty, the measurement past the horizon, the
  hour an overlay does not cover. An absent row says "there is nothing here"; the em dash that used
  to hold those places said the same thing more quietly, and said it to nobody at all in speech —
  screen readers at default punctuation verbosity voice an em dash as silence, so a dashed row
  announced a labelled series with no value. Settled in
  [#284](https://github.com/TomBennett-Lloyd/cumulo/issues/284) (D6): the drawn tooltip now drops
  the same rows speech always dropped, and the readout changing height as the reader moves along
  the series is the accepted cost of the two saying one thing. **The table twin keeps the em
  dash** — it is a grid, its columns are fixed by the header, and a cell cannot be absent the way
  a list item can.
- **The panel sizes to its content and floats above the plot.** Width is its two columns measured
  over the rows they hold — the widest name, the widest value, and the air between them — floored
  at a minimum so short samples do not read as a different component. An overlay's name is a site
  name a visitor typed, so the widest name is routinely one nobody could have sized for. **And
  capped at the plot's own width**, which is the floor's opposite number and matters for
  the same reason: a site name may run to 120 characters, and past a length that depends on how
  wide the plot is an uncapped panel is wider than the chart it is reading, so the readout
  blankets the marks it exists to explain. That length is arithmetic rather than design, so it is
  stated once where it is computed — `tooltipPanelWidth` in `apps/web/src/charts/tooltip-geometry.ts`
  gives the figure and the width it holds at, and a case in `tooltip-geometry.test.ts` measures it. Capped, a name that long overflows its panel instead — text past one edge is a defect
  a reader can see around, a panel over the whole plot is not. Columns were the first half of
  [#284](https://github.com/TomBennett-Lloyd/cumulo/issues/284) D12 and they do not retire this
  cap: no arrangement of two columns fits 120 characters into a panel narrower than they are.
  **Eliding the name that overflows is the half still open**, and the cap bounds what it costs
  until then. Padding is equal on all four sides, the corner takes `--radius-sm`, and the panel casts a
  small drop shadow in `--color-shadow`: it is the one surface in the product genuinely floated
  over live data, and the marks beneath it are the same ink and weights it is drawn in. The
  hairline border in `--color-border` stays under the shadow rather than being replaced by it.
- **The panel follows the pointer; the data snaps.** The crosshair and the rows belong to the
  nearest sample and change only at the midpoint between two samples — that is how often the data
  actually changes, and a landmark that slides between hours would be lying about which hour it is
  naming. The panel itself tracks the pointer continuously, clamped inside the plot by the same
  edge rule as any direct label, so the readout stays under the reader's eye instead of jumping a
  step behind it. Position updates are rate-limited to **30 a second**, with the last move always
  applied so the panel never freezes short of where the pointer came to rest; and the panel's
  **content is memoised against those frames**, so moving it re-renders nothing inside it. Motion
  comes from the pointer, never from a transition — there is no animation for
  `prefers-reduced-motion` to reduce. Settled in
  [#284](https://github.com/TomBennett-Lloyd/cumulo/issues/284) (D7); a keyboard selection has no
  pointer, so the panel sits at the sample and steps with the arrow keys.
- **Keyboard focus shows exactly what hover shows — and says so out loud.** The plot's `<svg>`
  keeps `role="img"` with one `aria-label`: a reader arriving at the chart should hear its name,
  not wade through every text node inside it. That is also why the tooltip cannot carry the
  announcement — the label collapses the whole subtree, so nothing drawn inside the SVG is spoken
  however it is marked up. The selected sample reaches assistive tech through **one visually
  hidden `aria-live="polite"` region in the figure**, between the plot and the legend. It is
  mounted empty with the chart and filled only when a reader moves the selection, so every
  announcement is a real change — a live region mounted with its text already inside it announces
  nothing. It is styled off-screen and never with `display: none` or `visibility: hidden`, either
  of which would remove it from the accessibility tree it exists to reach.
  **The announcement and the tooltip are composed from the same rows**, so the spoken readout
  cannot drift from the drawn one; and pointer and keyboard both feed that single region, because
  both settle on the same active sample. The pointer carries one thing the keyboard does not — the
  continuous position the panel tracks, per the D7 bullet above — but that rides beside the sample
  rather than being a second selection, and nothing spoken reads it: a frame that only moves the
  panel leaves the announcement's text exactly as it was. Forking the source per input device would
  recreate exactly the drift this rule exists to prevent, and `polite` coalescing bounds the chatter
  a moving pointer produces.
  The live region is the focus-mode and VoiceOver enhancement, not the accessible surface: a
  screen reader in browse mode consumes arrow keys before the chart ever sees them, so **the table
  twin below remains the canonical route** to every value — one press on its disclosure away, per
  the fold bullet below, which is where what a closed `<details>` does and does not withhold is
  set out.
- **Tooltips enhance, they never gate.** Every value in the tooltip is also reachable without a
  pointer, through direct labels or the table view. Every chart has a table-view twin — the
  WCAG-clean equivalent — reachable from the chart container.
- **The twin is folded away, behind a `Raw data` disclosure.** Settled in
  [#284](https://github.com/TomBennett-Lloyd/cumulo/issues/284) (D3). A 193-hour window is 193 rows,
  and open by default they were the tallest thing on the page — while the plot above them was held
  to a measure narrower than its own panel to leave them somewhere to sit. Closed, the chart fills
  the panel it is in and the twin is one keystroke away. The disclosure is a native
  `<details>`/`<summary>`, the same element the fleet's table uses (`dashboard/SiteTable.tsx`), so
  the open/closed semantics, the keyboard operation and the announcement are the platform's.
  **This does not weaken the bullet above** — but what discharges it is reachability, not
  presence, and the difference is worth stating precisely. A closed `<details>` keeps its children
  in the **document**; it does not keep them in the **accessibility tree**, because a browser does
  not render them and unrendered content is excluded. What a screen reader meets is therefore a
  collapsed disclosure with a name and a state, not the table behind it. That is enough: the twin
  is one press on a named, keyboard-operable control away, and **a route one press away is a
  route** — which is also exactly what the light-mode contrast WARN's relief channel asks for,
  since what that rule refuses is a chart with **no** text route to its values.
  `dashboard/dashboard-test-fixture.tsx` does query the table without opening anything, and that is
  a fact about jsdom rather than a claim about readers: jsdom omits the `<details>` shadow-tree
  styles, so nothing is hidden there. The `<caption>` stays on the table, because it
  names the table — which window, which units — while a summary names the disclosure.
- **The table twin carries a column per plotted value, and grows one for an overlay.** The time
  column heads each row; the forecast's three quantities and the measurement take one each; an
  overlay takes a sixth, headed by the series' own name. `forecast-chart-table.tsx` owns the
  columns and their order. The extra column is not only symmetry with the legend: the contrast
  WARN above obligates a relief channel for a light-mode chart reaching slot 3, and a chart that
  drew a fourth series without a fourth way to read it would be shipping the sub-threshold case
  the WARN refuses. An overlay sits in slot 2, which clears the threshold, so the column is not
  yet discharging that obligation — it is there so the _next_ series added does not have to
  invent it.

## Attribution

Every view that renders one of these charts **must compose `OpenMeteoAttribution`** from
`@cumulo/ui`. Forecasts are weather-derived, Open-Meteo is CC BY 4.0, and the attribution is a hard
constraint of the project rather than a courtesy. One instance per view, at the foot, is
sufficient; a chart that can appear on its own — an embed, a modal, a shared panel — carries its
own instance, because the view it came from is not there to carry it.

## Token map

Every token this treatment uses. Values, and the reasoning behind each value, are in
[`packages/ui/src/tokens/tokens.css`](../../packages/ui/src/tokens/tokens.css).

| Token                                                    | Used for                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------ |
| `--color-chart-band-fill`                                | uncertainty band area fill (slot-1 hue, 10% alpha, baked in) |
| `--color-chart-band-stroke`                              | P10 / P90 bound hairlines (same hue, 35% alpha)              |
| `--color-chart-1`                                        | median forecast line; first categorical slot                 |
| `--color-chart-2` … `-6`                                 | additional series, fixed order, never cycled                 |
| `--color-chart-actuals`                                  | measured actuals line (near-ink, not a categorical slot)     |
| `--color-chart-grid`                                     | gridlines, forecast-horizon rule (dashed)                    |
| `--color-chart-axis-label`                               | axis ticks, axis labels, horizon label                       |
| `--color-surface`                                        | 2px marker rings, chart card background, tooltip panel fill  |
| `--color-border`                                         | tooltip panel hairline                                       |
| `--color-shadow`                                         | tooltip panel drop shadow (elevation ink)                    |
| `--radius-sm`                                            | tooltip panel corner                                         |
| `--color-text`                                           | legend labels, tooltip values, hover crosshair               |
| `--color-text-muted`                                     | axis titles, tooltip series names, secondary legend text     |
| `--color-danger` / `--color-warning` / `--color-success` | reserved status states, never series identity                |
| `--text-xs`                                              | axis tick and label size                                     |
