# Design-direction exploration (issue #15)

Candidate visual directions produced during planning for
[#15 — design system](https://github.com/TomBennett-Lloyd/cumulo/issues/15), kept as the
record of how the direction was chosen rather than as living design source. The token
source of truth will live in `packages/ui` (plan chunk C1); once it lands, these files are
history, not reference.

- `design-directions.html` — all three candidates side by side, light and dark: token
  swatches, the forecast uncertainty-band chart treatment, site-map marker states
  (default / hover / selected / cluster), and the Open-Meteo attribution component in place.
- `direction-a.png` / `direction-b.png` / `direction-c.png` — per-direction renders of the
  same page, embedded in the issue thread.

Method: every categorical palette was validated with the dataviz skill's
`validate_palette.js` (lightness band, chroma floor, CVD ΔE under protan/deutan simulation,
normal-vision floor, contrast vs surface) in **both** light and dark modes; the first three
slots additionally pass the stricter all-pairs check used for map markers, where any two
marks can be neighbours. Type scale and the 4px-base spacing scale are held constant across
candidates so the choice is about colour, mood, and the band treatment.

**Outcome: direction B — Meridian** was chosen at plan approval (see the issue thread).
