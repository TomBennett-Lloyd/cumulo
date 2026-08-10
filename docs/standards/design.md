# Design standards

**Trigger:** adding, moving, or restyling anything a user sees — a component, layout, spacing,
visible text or a label, a chart mark, a breakpoint or media query, focus or hover behaviour.

These are the owner's standing design decisions, distilled from the #265/#284 design passes
(D1–D18), the 2026-08-10 feedback batch, and the owner's 2026-08-10 answers to the distillation's
open questions (`docs/design/design-principles.md`, from #337, is the distillation record — the
evidence corpus, the grounding behind each rule, and the owner's answers live there). They are
prospective rules for choices no design record has decided; the decided surfaces live in
`docs/design/chart-treatment.md`, `map-treatment.md`, and `dashboard-composition.md`, and a rule
here that gets decided into a surface lands in that surface's record.

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
    position via transform at the throttled pointer rate — `docs/design/chart-treatment.md`'s D7
    "the panel follows the pointer" bullet owns that rate (~30 a second there today), and a
    surface changing it changes it there — and content at data cadence from precomputed rows;
    data layers never re-render per pointer frame; linked interactions work
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
