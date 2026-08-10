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
 * bands rather than one. It stays a separate copy (`structure.md` rule 7, and `simulated-actual.ts` names its own web
 * counterpart for the same reason): that one is a browser fixture whose hours carry no
 * `cloudCoverPct` to feed the term this model is mostly about, packages may not reach into an app
 * to share it (`architecture.md` rule 1), and retuning the live envelope must not move the numbers
 * a chart test asserts. Changing one would not make the other wrong, which is rule 7's test.
 *
 * Restatement ledger (`architecture.md` rule 9): the base half-width is *derived* from
 * `simulated-actual.ts`'s bounds rather than restating `0.12`, so the two cannot drift. The copies
 * that do carry literals are in `simulated-uncertainty.test.ts` — the clear-sky/lead-0 case
 * asserts `0.88` and `1.12`, and the saturation case asserts a half-width of `0.5` — because a
 * test that reads the value it is proving moves with it and proves nothing (the same pattern as
 * `simulated-actual.test.ts`'s bounds sweep). The lead bullet's `26 h` is the fourth copy: it is
 * solved from the three width constants below, not measured, so it moves when any of them does.
 * Change either actuals bound, or {@link SIMULATED_UNCERTAINTY_HALF_WIDTH_MAX}, and those are the
 * copies to change with it.
 */

/**
 * The half-width a clear-sky, zero-lead forecast gets: the exact P10–P90 of the simulated-actuals
 * draw, derived from that draw's own bounds so the calibration cannot rot.
 *
 * The derivation: the draw is uniform on `[`{@link SIMULATED_ACTUAL_FACTOR_MIN}`, `
 * {@link SIMULATED_ACTUAL_FACTOR_MAX}`)`, centred on 1, so its floor sits half a range below the
 * unit midpoint. Its P90 sits `0.9` of the range above that floor, which is `(0.9 − 0.5) = 0.4`
 * of a range above the midpoint — a relative half-width of `0.4 × range`. P10 is the mirror
 * image. With the bounds as they stand that is `0.12`, i.e. quantiles at `0.88` and `1.12`.
 */
const SIMULATED_UNCERTAINTY_BASE_HALF_WIDTH =
  (SIMULATED_ACTUAL_FACTOR_MAX - SIMULATED_ACTUAL_FACTOR_MIN) * 0.4;

/** Extra half-width at peak cloud variability, i.e. at exactly half cover. */
const SIMULATED_UNCERTAINTY_CLOUD_HALF_WIDTH = 0.25;

/** Extra half-width per hour of forecast lead, before the cap. */
const SIMULATED_UNCERTAINTY_LEAD_WIDENING_PER_HOUR = 0.005;

/** The ceiling on relative half-width: at `0.5` the band spans half to 1.5× the estimate. */
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
 * representation error: `1 × (1 + 0.12) × 1000` is `1119.9999999999998`, not `1120`. Rounding a
 * value like that outward *raw* publishes a watt of pure arithmetic noise, and the same error on
 * the other side of a grid point takes a watt away — which is how a naive `Math.floor(v * 1000)`
 * would move the calibrated `0.88` this module is pinned to. Snapping first makes the outward
 * rounding a function of the value rather than of which side of the grid the last bit landed on.
 *
 * The tolerance is *relative* because the error is. An absolute tolerance wide enough to absorb it
 * up at the residential cap would, down at the sub-watt hours where the bracketing invariant is
 * tightest, swallow the whole watt that separates p10 from the median. At every magnitude this
 * module sees, `1e-9` sits about seven orders of magnitude above a single ulp of the scaled value
 * and at least four below the watt it must never cross.
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
 * Clamping degrades a stray reading to the nearest settled sky instead, and it is what makes
 * `halfWidth >= 0`, which the schema's `p10 <= p90` refinement rests on, a property of this code
 * rather than of its caller.
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
 * of it: the `p10 ≤ p90` refinement holds because `halfWidth` is never negative
 * ({@link cloudVariability}'s clamp is what keeps it so); the `0` floor holds because a
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
