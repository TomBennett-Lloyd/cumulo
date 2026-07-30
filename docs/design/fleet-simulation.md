# Fleet simulation

Design record for
[#9 — simulated fleet](https://github.com/TomBennett-Lloyd/cumulo/issues/9).

The seed fleet is 60 synthetic residential PV sites generated from a fixed seed, produced by
`generateFleet` exported from `@cumulo/shared`. It exists so that every downstream ticket —
ingestion, forecast, aggregation, the dashboard — has a realistic fleet to run against before
a single visitor has added a site, and so that two runs of the platform are comparable.

This document is the reasoning behind the numbers. The numbers themselves are code constants;
where the two disagree, the code is wrong, because this document and the generator were written
to the same parameter list. The `Site` shape is not restated here — it is `siteSchema` in
`packages/shared/src/site.ts`, and the generator emits sites that parse against it, including
that module's conventions for tilt (degrees from horizontal) and azimuth (degrees clockwise from
true north).

## Fleet shape

**60 sites.** Large enough that fleet-level aggregation has a shape worth plotting — an
uncertainty band over 60 sites is visibly narrower than over one, which is the whole point of
the aggregation feature — and small enough that per-site fan-out reads and per-site forecast
computation stay trivial at demo scale.

**12 cluster centres**, one per real population centre across Ireland and the UK:

| Location   | Latitude | Longitude |
| ---------- | -------- | --------- |
| Dublin     | 53.3498  | -6.2603   |
| Cork       | 51.8985  | -8.4756   |
| Galway     | 53.2707  | -9.0568   |
| Limerick   | 52.6638  | -8.6267   |
| Belfast    | 54.5973  | -5.9301   |
| London     | 51.5072  | -0.1276   |
| Manchester | 53.4808  | -2.2426   |
| Birmingham | 52.4862  | -1.8904   |
| Bristol    | 51.4545  | -2.5879   |
| Leeds      | 53.8008  | -1.5491   |
| Edinburgh  | 55.9533  | -3.1883   |
| Cardiff    | 51.4816  | -3.1791   |

Real cities rather than a uniform scatter, because the fleet has to look like a fleet: rooftop
PV follows housing stock, not graph paper. The 12 centres span roughly 51.4°N to 56.0°N, which
is a wide enough latitude range that solar geometry differs measurably between the extremes, and
they sit under genuinely different weather — an Atlantic-facing west coast and an eastern one —
so fleet aggregation smooths across real decorrelated cloud cover rather than across noise.

**5 sites per location.** Co-location is the deliberate design decision of this ticket, not an
artefact of picking round numbers: weather is fetched per _location_, so five sites sharing a
location share one weather fetch. See the budget section below for what that buys.

**Jitter of ±0.02° latitude and ±0.03° longitude**, uniform, applied to each site's cluster
centre — roughly ±2 km in each axis at these latitudes (a degree of longitude is shorter than a
degree of latitude here, hence the asymmetry). Sites are neighbours in the same town, not
stacked on one pin: map markers separate visually, and no downstream code can accidentally
depend on co-located sites having byte-identical coordinates. The offset is small enough that
sites in a cluster genuinely share weather, which is what makes the de-duplication honest rather
than a rounding trick.

## Distributions

All three physical parameters are drawn from **triangular distributions**, written
`triangular(min, mode, max)`. A triangular distribution is the right tool when the realistic
bounds and the typical value are known but the underlying shape is not: it has hard support
limits, so no draw can ever fall outside a physically sensible range, and it concentrates mass
around the mode without pretending to a precision the source data does not support.

| Parameter        | Distribution               | Unit                         |
| ---------------- | -------------------------- | ---------------------------- |
| `capacityKw`     | triangular(2.0, 4.0, 10.0) | kWp (nameplate DC)           |
| `tiltDegrees`    | triangular(20, 35, 50)     | degrees from horizontal      |
| `azimuthDegrees` | triangular(90, 180, 270)   | degrees clockwise from north |

Draws are rounded to the precision a site record would plausibly be recorded at — capacity to
0.1 kWp, tilt and azimuth to whole degrees. A synthetic site should not carry eleven significant
figures of fictional survey accuracy.

**Capacity — triangular(2.0, 4.0, 10.0) kWp.** The mode sits at 4.0 kWp because that is where
the IE/UK residential population actually clusters: the historic domestic connection cap and the
long-standing MCS/G98 single-phase inverter limit both landed around 3.68–4 kW, and a decade of
installations were sized to fit under it. The 2.0 kWp floor is a small starter array on a
constrained roof. The 10.0 kWp ceiling is the tail — a large modern install with a bigger roof
and no legacy cap — and it stays well inside `siteSchema`'s 50 kW sanity bound, which exists to
reject data-entry errors rather than to describe residential norms.

**Tilt — triangular(20, 35, 50)°.** Rooftop PV is almost always mounted flush to the pitch, so
this is really a distribution over IE/UK domestic roof pitches. 35° is both the typical pitch and
close to the annual-yield optimum at these latitudes, which is not a coincidence — it is why
retrofit rooftop solar performs as well as it does here. 20° is a shallow modern pitch, 50° a
steep older or gable-heavy roof.

**Azimuth — triangular(90, 180, 270)°.** 180° is due south and the mode, because south-facing
roof planes are the ones that get chosen when a house offers a choice. The support runs from due
east to due west: installers will take an east or west plane when that is what the roof has, but
a north-facing array is not a thing anyone pays for, so the distribution has zero mass there. The
spread is what makes the fleet interesting to aggregate — east-facing sites peak before solar
noon and west-facing ones after, so the fleet curve is broader and flatter than any single site's.

Per [`docs/standards/architecture.md`](../standards/architecture.md) rule 3 (pure core, effectful
edges), the generator is a pure function: seed in, fleet out. No clock, no environment access, no
I/O, no `Math.random`. The distributions above are inverse-transform draws from the seeded PRNG
described below, which is what makes the whole thing reproducible and trivially testable.

## Weather locations and the Open-Meteo budget

**The fleet implies 12 distinct weather locations by design, because sites are co-located in
clusters.** The worst case — no de-duplication at all, one fetch per site — is 60. At the
platform's hourly ingestion cadence:

| Case                      | Locations | Calls/hour | Calls/day |
| ------------------------- | --------- | ---------- | --------- |
| De-duplicated (by design) | 12        | 12         | 288       |
| Worst case (no de-dup)    | 60        | 60         | 1,440     |

Against the Open-Meteo free tier — **10,000 calls/day, 5,000/hour, 600/minute** — both cases are
comfortably inside every limit. The de-duplicated case uses 2.9% of the daily allowance; even the
worst case uses 14.4%, and neither approaches the hourly or per-minute ceilings even if a whole
cycle's calls were issued in the same minute (60 of 600). The headroom is deliberate: it leaves
room for visitor-added sites at new locations, for the hindcast archive fetches of #16 drawing on
the same quota, and for a re-run after a failed cycle, without any of those needing a quota
conversation.

The 5-sites-per-location choice is therefore worth a **5× reduction in weather calls** — the
single largest lever this ticket has on the platform's API frugality constraint. That said,
**the de-duplication mechanism itself is not owned here.** This ticket produces a fleet whose
sites are co-located so that de-duplication has something to collapse; #11 (ingestion) owns the
`locationId` rounding function and the actual "fetch once per location" behaviour. The 288
figure is what #11 achieves given this fleet, not something this generator enforces.

One note for sizing elsewhere in the repo: ADR 0002 sized DynamoDB capacity against an assumed
~50 sites over ~30 locations. This fleet is 60 sites over 12 locations — 20% more per-site series
volume, and well under half the weather volume, than that ADR assumed. Its own headroom table
covers 100 sites at 14% of the free write allowance, so the fleet as specified here sits inside
the sizing; the 30-location assumption is simply more pessimistic than the fleet it was sizing
for.

## Determinism

The generator is seeded. It uses **mulberry32**, a 32-bit PRNG chosen for being a dozen lines of
readable integer arithmetic with good statistical properties for this use — this is a simulation
of rooftops, not a cryptographic context, and an auditable implementation in the repo is worth
more here than an opaque dependency.

**The canonical seed is `20260730`.** Running `generateFleet(20260730)` produces byte-identical
sites — same ids, same names, same coordinates, same capacities, tilts, and azimuths — on every
machine, every run, forever. That is what makes the seed fleet a fixture rather than a surprise:

- Forecast accuracy figures from two runs of the platform describe the same fleet and are
  therefore comparable.
- A test can assert on a specific site's parameters without pinning a snapshot of random output.
- A bug reproduced locally reproduces in CI, because the input is a literal, not a draw.

Site ids are uuids derived from the same seeded stream rather than generated from entropy, so
they too are stable across runs — a site's identity is a function of the seed and its index in
the fleet, nothing else.

Changing the seed produces a different but equally valid fleet; changing it silently invalidates
every stored forecast and metric keyed by the old site ids, so `20260730` is a constant in the
code and treated as part of the data contract.
