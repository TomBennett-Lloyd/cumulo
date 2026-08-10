import { type Forecast, uncertaintyBandSchema, type UncertaintyBand } from './forecast';
import { SIMULATED_ACTUAL_FACTOR_MAX, SIMULATED_ACTUAL_FACTOR_MIN } from './simulated-actual';
import { MAX_PLAUSIBLE_RESIDENTIAL_KW } from './site';

/**
 * A simulated uncertainty envelope around a physics forecast's point estimate.
 *
 * The physics core emits a point estimate and nothing else (ADR 0003), so live forecasts have no
 * band of their own — while the chart, the legend and the table all have a place to draw one. The
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
 *   a cap is what keeps a 168-hour look-back from claiming a band wider than the estimate.
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
 * Restatement ledger (`architecture.md` rule 9): the base half-width is *derived* from
 * `simulated-actual.ts`'s bounds rather than restating `0.12`, so the two cannot drift. The copies
 * that do carry literals are in `simulated-uncertainty.test.ts` — the clear-sky/lead-0 case
 * asserts `0.88` and `1.12`, and the saturation case asserts a half-width of `0.5` — because a
 * test that reads the value it is proving moves with it and proves nothing (the same pattern as
 * `simulated-actual.test.ts`'s bounds sweep). Change either actuals bound, or
 * {@link SIMULATED_UNCERTAINTY_HALF_WIDTH_MAX}, and those are the copies to change with it.
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
 * Deliberately a local copy of `simulated-actual.ts`'s constant and rounding helper rather than an
 * import of either (`structure.md` rule 7): these are two independent simulations that happen to
 * agree on precision today, and retuning one must not silently retune the other. The shared thing
 * is arithmetic, not intent.
 */
const POWER_DECIMALS = 3;

const MILLISECONDS_PER_HOUR = 3_600_000;

const PERCENT_FULL_SCALE = 100;

/** The `c(1−c)` parabola normalised to peak at exactly 1, at half cover. */
const CLOUD_VARIABILITY_NORMALISER = 4;

const roundTo = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

/**
 * Cloud's contribution in `[0, 1]`: nil under a clear or a fully overcast sky, peaking at half
 * cover. Values outside the `0`–`100` bound `weatherReadingSchema` puts on `cloudCoverPct` would
 * go negative here; the band's own parse is the backstop that refuses the result rather than
 * publishing an inverted one.
 */
const cloudVariability = (cloudCoverPct: number): number => {
  const cover = cloudCoverPct / PERCENT_FULL_SCALE;
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
 * The result is parsed rather than asserted — the clamps are what keep the schema's `0`–
 * {@link MAX_PLAUSIBLE_RESIDENTIAL_KW} bounds and its `p10 ≤ p90` refinement satisfied, and a
 * parse is what proves they stayed true. The upper clamp makes the band asymmetric about the
 * estimate for a site already at the residential cap; that is the honest reading, since output
 * above nameplate is not a thing that happens (ADR 0003).
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
    p10AcPowerKw: roundTo(Math.max(0, median * (1 - halfWidth)), POWER_DECIMALS),
    p90AcPowerKw: roundTo(
      Math.min(MAX_PLAUSIBLE_RESIDENTIAL_KW, median * (1 + halfWidth)),
      POWER_DECIMALS,
    ),
  });
};
