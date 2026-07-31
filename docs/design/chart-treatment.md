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
  stroke, so the band is never drawn as an outlined polygon.
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
- **The forecast horizon boundary is a vertical hairline** in `--color-chart-grid` with a small
  direct label in `--color-chart-axis-label`, at the last timestamp with a measurement. Actuals
  stop there; band and median continue. The boundary is marked once, in chrome, rather than by
  dashing the forecast line.
- **A gap _inside_ a series breaks the line. It is never bridged.** The horizon rule above says
  where the measurements stop; this says what a missing hour before that boundary looks like. A
  null actual ends the run and the line restarts after the gap, so the actuals series is drawn once
  per contiguous run of measured samples rather than as one path through the hole. The same holds
  for the band: an hour whose forecast carries no P10–P90 is a point estimate, and the band's
  polygon and bound hairlines are drawn once per contiguous run of banded samples. A straight
  segment across a gap is a value that was never measured or never modelled, drawn with exactly the
  confidence of the values on either side of it — partial data is labelled partial, in the chart as
  much as in the API (`error-handling.md` rule 5). The gap itself is left empty: no dotted
  connector, no faded segment, nothing that could be read as an estimate of what was missing.

## Legend

Three series are on the plot, so **a legend is always present** — identity is never carried by
colour alone. Entries are fixed in draw order and do not reorder or repaint when a series is
toggled off:

| Entry              | Swatch                                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| Forecast (P10–P90) | rect filled `--color-chart-band-fill`, with hairline top and bottom edges in `--color-chart-band-stroke` |
| Forecast (median)  | short 2px line key in `--color-chart-1`                                                                  |
| Actuals            | short 2px line key in `--color-chart-actuals`                                                            |

The swatch mirrors the mark: a rect for the area, a line key for the lines. The band's swatch is
the one place where the bound stroke is doing double duty — at swatch size a bare 10% wash is
nearly invisible, and the edges are what make it read as a band.

**Legend text wears text tokens, never the series colour** — `--color-text` for the label, or
`--color-text-muted` where the legend is secondary chrome. Identity comes from the coloured swatch
beside the text. This matters more than usual here: several categorical slots are too light to be
legible as text on the light surface (see below).

Direct labels ride the marks to _supplement_ the legend, never to replace it, and stay sparing —
the endpoint of the actuals line, the peak of the median, the band width at the horizon. A number
on every point is chaos and goes unread.

## Grid, axes, and the single-axis rule

- **Gridlines: `--color-chart-grid`, hairline (1px), solid, horizontal only.** Never dashed —
  dashing reads as "projection" or "threshold" when it is just a grid. The grid sits one step off
  the surface and stays recessive.
- **Axis ticks and labels: `--color-chart-axis-label` at `--text-xs`**, with
  `font-variant-numeric: tabular-nums` so tick values align vertically. Axis titles use
  `--color-text-muted`.
- **One value axis. Never two.** Power (kW) and irradiance (W/m²) do not share a plot: the
  alignment between two y-scales is arbitrary and invents a correlation the data does not contain.
  Two measures of different scale become two charts, small multiples, or both series indexed to a
  common base on one axis.

## The time axis

**The time axis runs on UTC.** Tick labels are UTC wall time — `HH:mm`, gaining a short weekday
prefix (`Thu 14:00`) from a full day of span onwards, which is exactly when a wall-clock time can
appear twice on one axis and a bare `14:00` stops identifying a point. A day, not two: the default
24 h window spans 24 hours of ticks, so its first and last tick are the same hour, and unprefixed
they name two different moments identically — in the chart and in the table twin's row headers.
The rendered value is never the reader's local zone, and never a per-site local zone.
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

- **A crosshair finds the X.** A vertical hairline tracks the pointer and snaps to the nearest
  timestamp — readers aim at a time, not at a 2px line.
- **One tooltip, every series.** The readout lists the actual, the median, and the P10–P90 range at
  that timestamp, so the pointer never has to land on a line or inside the fill to get a number.
  The value leads and is high-contrast; the series name follows in `--color-text-muted`. Series are
  keyed with a short stroke of their colour, not a filled box.
- **Keyboard focus shows exactly what hover shows.**
- **Tooltips enhance, they never gate.** Every value in the tooltip is also reachable without a
  pointer, through direct labels or the table view. Every chart has a table-view twin — the
  WCAG-clean equivalent — reachable from the chart container.

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
| `--color-chart-grid`                                     | gridlines, forecast-horizon rule                             |
| `--color-chart-axis-label`                               | axis ticks, axis labels, horizon label                       |
| `--color-surface`                                        | 2px marker rings, chart card background                      |
| `--color-text`                                           | legend labels, tooltip values                                |
| `--color-text-muted`                                     | axis titles, tooltip series names, secondary legend text     |
| `--color-danger` / `--color-warning` / `--color-success` | reserved status states, never series identity                |
| `--text-xs`                                              | axis tick and label size                                     |
