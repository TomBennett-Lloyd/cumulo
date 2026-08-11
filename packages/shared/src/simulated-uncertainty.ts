import { type Forecast, uncertaintyBandSchema, type UncertaintyBand } from './forecast';
import { SIMULATED_ACTUAL_FACTOR_MAX, SIMULATED_ACTUAL_FACTOR_MIN } from './simulated-actual';
import { MAX_PLAUSIBLE_RESIDENTIAL_KW } from './site';

/**
 * A simulated uncertainty envelope around a physics forecast's point estimate.
 *
 * The physics core emits a point estimate and nothing else (ADR 0003), so before #295 a live
 * forecast reached the read side with no band of its own — while the chart, the legend and the
 * table each kept a place to draw one, and drew that chrome whether or not anything filled it.
 * That mismatch is the state this module and the gating beside it were decided against. The
 * envelope is manufactured *here*, from the forecast and the cloud cover of the hour it covers,
 * rather than inside the physics chain: `cloudCoverPct` is documented in `weather-reading.ts` as
 * an input the physics core does not use, ADR 0003 pins that core to golden fixtures, and this is
 * simulation rather than physics — the same shape as `simulated-actual.ts`, its precedent in
 * every respect. No claim of a fitted predictive distribution is made anywhere it surfaces: the
 * UI labels the band as simulated (#295). A real band arrives with the ML layer (#20).
 *
 * Pure by construction (`architecture.md` rule 3): no clock, no I/O, no randomness. The width is
 * a function of the forecast's own lead time and the hour's cloud cover, so the same forecast
 * always yields the same band — which is what makes writing these rows idempotent, in any order,
 * from any process.
 *
 * Modelling position, stated because the choice is not neutral (the same duty `aggregation.ts`'s
 * comonotonicity paragraph does):
 *
 * - **Relative, not absolute.** The half-width `h` is a fraction of the point estimate, so the
 *   band closes to nothing at night and opens with the magnitude of the output it brackets.
 * - **Broken cloud is the volatile regime.** A half-covered sky swings a panel's irradiance far
 *   harder than a uniformly clear or uniformly overcast one, so the cloud term is the parabola
 *   `4c(1−c)` on `c = cloudCoverPct/100`: zero at both stable extremes, and the ×4 normalises the
 *   peak to exactly 1 at `c = 0.5` so {@link SIMULATED_UNCERTAINTY_CLOUD_HALF_WIDTH} reads as the
 *   whole extra half-width broken cloud buys.
 * - **Lead widens it.** A linear {@link SIMULATED_UNCERTAINTY_LEAD_WIDENING_PER_HOUR} per hour of
 *   lead, saturating at {@link SIMULATED_UNCERTAINTY_HALF_WIDTH_MAX}. Linear-then-capped is the
 *   deliberately crude choice: nothing in this fleet's history could fit a growth curve yet, and
 *   an unbounded ramp would eventually claim a band wider than the estimate it brackets.
 *   **The cap binds inside the shipped horizon, and the chart shows it.** Under half cover the
 *   three terms above reach the ceiling at a lead of 26 h — well short of the horizon ingestion
 *   fetches (`apps/ingestion/src/open-meteo/url.ts`'s `forecastHours`) — so the far end of a
 *   broken-cloud horizon sits flat at exactly ±50 % instead of widening. That plateau is the
 *   model admitting it has nothing further to say, not a defect; a reader should meet it here
 *   rather than infer it from a ribbon that stops opening.
 * - **Calibrated at the origin, conservative away from it.** At clear sky and zero lead the band
 *   is *exactly* the P10–P90 of the simulated-actuals draw — see
 *   {@link SIMULATED_UNCERTAINTY_BASE_HALF_WIDTH} — so the envelope and the actuals it will be
 *   scored against agree by construction rather than by tuning. Every other regime widens from
 *   there, which overstates spread rather than understating it.
 *
 * No seed, and no draw. The band is a smooth function of cloud and lead, so a run of hours renders
 * as a smooth ribbon instead of a jittery one; the trade accepted is that the envelope has no
 * scatter of its own and never narrows on a lucky hour. Scatter realism already lives in
 * `simulated-actual.ts`'s draw — the very process this width is calibrated against — so a fourth
 * copy of the mulberry32 arithmetic here (`structure.md` rule 7) would only wobble a smooth curve
 * for no gain.
 *
 * The near-duplicate worth naming is not that arithmetic but a *width model*: `apps/web`'s
 * `data/fixture-series.ts` has a `bandHalfWidth` of the same shape — a base fraction, linear
 * growth per hour of lead, the same `Math.min` ceiling, quantiles rounded to the same precision —
 * at different constants and calibrated against nothing, so the product carries two simulated
 * bands rather than one. It stays a separate copy (`structure.md` rule 7, and
 * `simulated-actual.ts` names its own web counterpart for the same reason): that one is a
 * browser fixture whose hours carry no `cloudCoverPct` to feed the term this model is mostly
 * about, packages may not reach into an app to share it (`architecture.md` rule 1), and
 * retuning the live envelope must not move the numbers a chart test asserts. Changing one would
 * not make the other wrong, which is rule 7's test.
 *
 * Restatement ledger (`architecture.md` rule 9): the base half-width is *derived* from
 * `simulated-actual.ts`'s bounds rather than restating `0.12`, so the two cannot drift. The copies
 * that do carry literals include these. In `simulated-uncertainty.test.ts`, because a test that
 * reads the value it is proving moves with it and proves nothing (the same pattern as
 * `simulated-actual.test.ts`'s bounds sweep). The two owned constants move *disjoint* sets, so
 * they are listed apart rather than together. Riding the base half-width, and therefore the
 * actuals bounds: the calibration case's `0.88` and `1.12`, the scaling case's `3.52` and `4.48`,
 * the ceiling case's `44`, and the grid-snap cases' `0.902` and `1.148`. Riding
 * {@link SIMULATED_UNCERTAINTY_HALF_WIDTH_MAX}: the saturation case's `5` and `15`, and the
 * grid-snap cases' `23.124` and `7.708`. Retuning one constant leaves the other's set untouched —
 * `0.5 → 0.6` moves `5`/`15` to `4`/`16` and does not touch `0.88`/`1.12`.
 *
 * A second kind of member rides the same two constants from the other end: a **tuned input**, a
 * value chosen so that an example lands where the case needs it. In `simulated-uncertainty.test.ts`
 * the p10 snap case's estimate `1.025` is tuned against the base half-width, so that
 * `1.025 × (1 − base) × 1000` lands a hair below a whole watt — the product
 * {@link DECIMAL_GRID_TOLERANCE}'s own comment works through — and the p90 snap case's estimate
 * `15.416` is tuned against {@link SIMULATED_UNCERTAINTY_HALF_WIDTH_MAX}, so that
 * `15.416 × (1 + `{@link SIMULATED_UNCERTAINTY_HALF_WIDTH_MAX}`) × 1000` lands a hair above one.
 * Retuning either owned constant does not leave these cases wrong so much as pointless: their
 * asserted literals are in the list above and move with the constant, and once those have been
 * trued the input no longer sits a hair off a watt — so the case stops demonstrating the snap it
 * was written for, silently, and while green. That quiet is the reason they are ledgered: a case
 * that has lost its point looks exactly like one that still has it.
 *
 * Two absences, for different reasons, because "it did not move when I tried it" is not a reason.
 * The ceiling case's `50` is *clamp*-dominated: `Math.min(`{@link MAX_PLAUSIBLE_RESIDENTIAL_KW}`,
 * …)` binds before the rounding, so it moves with that cap and with nothing else here. The
 * sub-watt cases' `0`, `0.001` and `0.003` are stable at today's constants but are *not*
 * invariant — a base half-width of `0.088` flips one of them — so they are omitted as
 * low-sensitivity, not as fixed.
 *
 * Prose carries these constants too, and a paraphrase is invisible to a grep keyed to the literal
 * (`architecture.md` rule 10), so the restatements in words are listed with the assertions.
 * **Read the list below as a floor, not a census**: it is what a sweep for the claim families —
 * the literals themselves, plus `half again|half the estimate|spans|±\d+ ?%|flat at|saturat` —
 * turned up, and the next paraphrase nobody thought to grep for is exactly the copy this ledger
 * cannot promise to hold. Neither half of that sweep reaches a tuned input, which carries neither
 * the owner's literal nor any phrasing of it: the pair above was found by reading each case's
 * arithmetic instead, and that reading is the sweep to repeat for them. Where a figure could be
 * *eliminated* rather than listed it was: the two width constants' own docblocks state their
 * meaning as an expression now, so they no longer quote the numbers they own.
 *
 * Riding {@link SIMULATED_UNCERTAINTY_HALF_WIDTH_MAX}: the lead bullet above says the far horizon
 * "sits flat at exactly ±50 %", which reads `±60 %` at `0.6`; and in
 * `simulated-uncertainty.test.ts` the p90 snap case calls it "half again the estimate" and spells
 * `1.5`, while the saturation case's name says "half the estimate" and its comment "the `0.5`
 * cap". Riding the base
 * half-width: that file's p10 snap case works through `1 − halfWidth` as `0.88` and reads
 * `901.9999999999999`, `902` and `0.901` off it; and {@link DECIMAL_GRID_TOLERANCE}'s comment
 * works the same derivation through `0.88`, `1.12`, `1119.9999999999998`, `1120`,
 * `901.9999999999999`, `902` and `0.901` to locate where the representation error enters. Also in
 * the lead bullet: `26 h` is *solved*, not measured, from all four width constants — base, cloud,
 * per-hour lead, and the ceiling it is solved against — so it moves with any of them, and reads
 * `46 h` at a ceiling of `0.6`. Change either actuals bound, or
 * {@link SIMULATED_UNCERTAINTY_HALF_WIDTH_MAX}, and every copy above is one to change with it.
 *
 * A precondition rather than a copy, listed here for the same reason — it is a fact about another
 * module's value that this one silently depends on. {@link MAX_PLAUSIBLE_RESIDENTIAL_KW} must sit
 * on the watt grid itself, as `50` does. {@link ceilTo} rounds the capped p90 *up*, so a cap off
 * that grid would be lifted just above itself and then refused by the band's own parse: the clamp
 * would throw on precisely the sites it exists to serve.
 */

/**
 * The half-width a clear-sky, zero-lead forecast gets: the exact P10–P90 of the simulated-actuals
 * draw, derived from that draw's own bounds so the calibration cannot rot.
 *
 * The derivation: the draw is uniform on `[`{@link SIMULATED_ACTUAL_FACTOR_MIN}`, `
 * {@link SIMULATED_ACTUAL_FACTOR_MAX}`)`, centred on 1, so its floor sits half a range below the
 * unit midpoint. Its P90 sits `0.9` of the range above that floor, which is `(0.9 − 0.5) = 0.4`
 * of a range above the midpoint — a relative half-width of `0.4 × range`. P10 is the mirror
 * image. The figures that follow from today's bounds are in the restatement ledger above, not
 * repeated here: this is the owner, and an owner that also quotes its own output is one more copy
 * to keep in step.
 */
const SIMULATED_UNCERTAINTY_BASE_HALF_WIDTH =
  (SIMULATED_ACTUAL_FACTOR_MAX - SIMULATED_ACTUAL_FACTOR_MIN) * 0.4;

/** Extra half-width at peak cloud variability, i.e. at exactly half cover. */
const SIMULATED_UNCERTAINTY_CLOUD_HALF_WIDTH = 0.25;

/** Extra half-width per hour of forecast lead, before the cap. */
const SIMULATED_UNCERTAINTY_LEAD_WIDENING_PER_HOUR = 0.005;

/**
 * The ceiling on relative half-width: the band spans `1 − max` to `1 + max` times the estimate.
 *
 * That span is the width only where nothing else binds, which is the qualifier the summary above
 * omits: p90 is clamped at {@link MAX_PLAUSIBLE_RESIDENTIAL_KW} *before* the rounding, so a site
 * near nameplate publishes a band asymmetric about its estimate and narrower above than this
 * ceiling alone implies.
 */
const SIMULATED_UNCERTAINTY_HALF_WIDTH_MAX = 0.5;

/**
 * Power values are recorded to watt precision; the underlying forecast claims nothing finer.
 *
 * Deliberately a local copy of `simulated-actual.ts`'s constant rather than an import of it
 * (`structure.md` rule 7): these are two independent simulations that happen to agree on precision
 * today, and retuning one must not silently retune the other. The shared thing is arithmetic, not
 * intent — and here not even that, since this module rounds *outward* from the estimate rather
 * than to the nearest watt (see {@link floorTo}).
 */
const POWER_DECIMALS = 3;

const MILLISECONDS_PER_HOUR = 3_600_000;

const PERCENT_FULL_SCALE = 100;

/** The `c(1−c)` parabola normalised to peak at exactly 1, at half cover. */
const CLOUD_VARIABILITY_NORMALISER = 4;

/**
 * How far a scaled value may sit from a whole watt and still be treated as that watt, as a
 * fraction of the value itself.
 *
 * `median × (1 ± halfWidth) × 1000` lands on a whole number only up to floating-point
 * representation error, which enters at more than one step. `halfWidth` is one:
 * {@link SIMULATED_UNCERTAINTY_BASE_HALF_WIDTH} is *derived* from the actuals bounds rather than
 * written as a decimal, so `1 + base` sits a hair under the `1.12` it reads as, and a `1 kW`
 * estimate under a clear sky at issue time scales to `1119.9999999999998` rather than `1120`.
 * That one is harmless *on this side*: `Math.ceil` of a value a hair *below* a grid point already
 * lands on it. Either step can bite on either side, though — a `1 − halfWidth` landing a hair
 * below a grid point costs a watt at `Math.floor` by the identical mechanism — so the example
 * below is one instance rather than a rule about which step is dangerous. `1 − base` *is* exactly
 * `0.88`, yet `1.025 × 0.88 × 1000` comes out `901.9999999999999` against an exact `902`, so a
 * raw `Math.floor` publishes a p10 of `0.901`: a watt taken off the band by nothing but the last
 * bit of a product. Snapping first makes the outward rounding a function of the value rather than
 * of which side of the grid the last bit happened to land on.
 *
 * The tolerance is *relative* because the error it absorbs is: an ulp scales with the value
 * carrying it, so a relative tolerance holds one constant multiple of an ulp across the whole
 * range instead of running slack at the top of it and tight at the bottom.
 *
 * It is also the choice that needs no lower bound on the estimate, and that is the load-bearing
 * part. A *relative* tolerance can never snap a non-zero value onto zero: `|s − 0| ≤ 1e-9 · s`
 * is impossible for any `s > 0`. A fixed *absolute* tolerance `t` can, and does — it snaps p90
 * onto zero for every median whose scaled value falls below `t`, and `ceil(0)` then publishes a
 * `{0, 0}` band around a positive estimate, which `uncertaintyBandSchema` accepts without
 * complaint. That is precisely the quiet unbracketed band outward rounding exists to remove.
 *
 * The failure is scale-free in `t`, so there is no safe absolute tolerance — not a small one, not
 * any. The boundary is `t / (1000 × (1 + h))`, so it moves with the half-width, and any figure
 * quoted without one is only true in the regime it was computed in — the
 * **worst-case boundary being** `t / (10 **`{@link POWER_DECIMALS}` × (1 + `
 * {@link SIMULATED_UNCERTAINTY_HALF_WIDTH_MAX}`))`, below which an estimate fails at *every*
 * half-width this model produces. `t = 1e-3` fails a `5e-7 kW` estimate, `t = 1e-9` fails
 * `5e-13 kW`, and so on down — and neither example has margin to spare: at a ceiling of exactly
 * `1.0` both scale to precisely `t`, so the snap-to-zero they demonstrate survives
 * **only because the comparison** in {@link onDecimalGrid} is `<=` rather than `<`. Zero margin,
 * not "enough".
 *
 * Nothing floors a non-zero `acPowerKw` away from zero (`z.number().gte(0)`, and the physics
 * chain does not quantise), so there is no smallest estimate for such a bound to sit under, and
 * the invariant this module leads with is "at every magnitude". Relative is not the better of two
 * workable choices here; it is the only one. At every magnitude this module sees, `1e-9` sits
 * about seven orders of magnitude above a single ulp of the scaled value and at least four below
 * the watt it must never cross.
 */
const DECIMAL_GRID_TOLERANCE = 1e-9;

/**
 * `value` scaled to whole-watt units, with a scaled value that misses a whole number only by
 * representation error snapped onto it.
 *
 * Non-negative inputs only, which is what lets the tolerance be taken against `scaled` directly:
 * every caller passes a non-negative median times a non-negative factor.
 */
const onDecimalGrid = (value: number, decimals: number): number => {
  const scaled = value * 10 ** decimals;
  const nearest = Math.round(scaled);
  return Math.abs(scaled - nearest) <= DECIMAL_GRID_TOLERANCE * scaled ? nearest : scaled;
};

/** The largest value on the `decimals` grid that is not above `value`. */
const floorTo = (value: number, decimals: number): number =>
  Math.floor(onDecimalGrid(value, decimals)) / 10 ** decimals;

/** The smallest value on the `decimals` grid that is not below `value`. */
const ceilTo = (value: number, decimals: number): number =>
  Math.ceil(onDecimalGrid(value, decimals)) / 10 ** decimals;

/**
 * Cloud's contribution in `[0, 1]`: nil under a clear or a fully overcast sky, peaking at half
 * cover.
 *
 * `weatherReadingSchema` bounds `cloudCoverPct` to `0`–`100`, but this function's parameter is a
 * bare number and the parabola only means anything on the unit interval, so the cover is clamped
 * onto it. Unclamped, a stray reading fails quietly rather than loudly: a cover just above `100 %`
 * returns a *narrower* band, which the band's own parse accepts without complaint, and the
 * half-width — the one failure a parse could catch — does not go negative until around `111 %`.
 * Clamping degrades a stray reading to the nearest settled sky instead, and for every *non-`NaN`*
 * cover it is what makes `halfWidth >= 0`, which the schema's `p10 <= p90` refinement rests on, a
 * property of this code rather than of its caller. The infinities are absorbed like any other
 * out-of-range cover — `Math.max(0, -Infinity)` is `0` and `Math.min(1, Infinity)` is `1`, both
 * settled skies — so `NaN` is the only cover the clamp cannot answer for.
 *
 * `NaN` is the one cover the clamp cannot absorb: `Math.max(0, NaN)` is `NaN`, which carries
 * through both quantiles and surfaces as a `ZodError` from the band's own parse. It is documented
 * rather than guarded, because both halves of the reason to guard are already absent —
 * `weatherReadingSchema` rejects a `NaN` reading well upstream of here, and a throw at the parse
 * is the loud failure this paragraph wants anyway, not the quiet one it is arguing against.
 */
const cloudVariability = (cloudCoverPct: number): number => {
  const cover = Math.min(1, Math.max(0, cloudCoverPct / PERCENT_FULL_SCALE));
  return CLOUD_VARIABILITY_NORMALISER * cover * (1 - cover);
};

/**
 * Hours between issue and the hour forecast, floored at zero: no ordering constraint holds between
 * the two (`forecast.ts`), and a hindcast replay's negative lead is not negative uncertainty.
 */
const leadHours = (forecast: Forecast): number =>
  Math.max(
    0,
    (Date.parse(forecast.validTime) - Date.parse(forecast.issuedAt)) / MILLISECONDS_PER_HOUR,
  );

/**
 * The simulated uncertainty band for one forecast hour, given that hour's cloud cover.
 *
 * A zero estimate yields an exactly zero-width band: night is night, and there is no uncertainty
 * about the output of an unlit panel.
 *
 * **The band brackets its own estimate at every magnitude**, and rounding *outward* — down for
 * p10, up for p90 — is what buys that. The quantiles are published on the watt grid while
 * `acPowerKw` is not, so at the first and last lit hour of a day, where the estimate's own
 * distance to its quantiles is under half a watt, rounding both to the *nearest* watt put them on
 * the same grid point as each other and on the wrong side of the median: a 0.6 W estimate came
 * back bracketed by 1 W and 1 W. Outward rounding cannot do that — it only ever moves p10 further
 * below the median and p90 further above — so `p10 <= acPowerKw <= p90` holds from zero up to
 * {@link MAX_PLAUSIBLE_RESIDENTIAL_KW}. It also never narrows the band, which is the direction
 * this module's stated position already leans.
 *
 * The result is parsed rather than asserted, and the three things the parse re-proves have three
 * different guarantors, worth separating because the previous note credited the clamps with all
 * of it: the `p10 ≤ p90` refinement holds because `halfWidth` is never negative for a non-`NaN`
 * cover ({@link cloudVariability}'s clamp is what keeps it so, and its note owns the `NaN` case);
 * the `0` floor holds because a
 * non-negative estimate times a non-negative factor cannot floor below zero, so there is
 * deliberately no `Math.max(0, …)` here — a clamp that can never bind is defence a reader has to
 * disprove; and the {@link MAX_PLAUSIBLE_RESIDENTIAL_KW} ceiling holds because of the one clamp
 * that does bind. A parse is what proves all three stayed true. That clamp makes the band
 * asymmetric about the estimate for a site already at the residential cap; that is the honest
 * reading, since output above nameplate is not a thing that happens (ADR 0003).
 */
export const simulatedUncertaintyBand = (
  forecast: Forecast,
  cloudCoverPct: number,
): UncertaintyBand => {
  const halfWidth = Math.min(
    SIMULATED_UNCERTAINTY_HALF_WIDTH_MAX,
    SIMULATED_UNCERTAINTY_BASE_HALF_WIDTH +
      SIMULATED_UNCERTAINTY_CLOUD_HALF_WIDTH * cloudVariability(cloudCoverPct) +
      SIMULATED_UNCERTAINTY_LEAD_WIDENING_PER_HOUR * leadHours(forecast),
  );
  const median = forecast.acPowerKw;
  return uncertaintyBandSchema.parse({
    p10AcPowerKw: floorTo(median * (1 - halfWidth), POWER_DECIMALS),
    p90AcPowerKw: ceilTo(
      Math.min(MAX_PLAUSIBLE_RESIDENTIAL_KW, median * (1 + halfWidth)),
      POWER_DECIMALS,
    ),
  });
};
