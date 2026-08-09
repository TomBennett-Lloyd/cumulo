import type { Forecast } from './forecast';
import { generationReadingSchema, type GenerationReading } from './generation-reading';
import { MAX_PLAUSIBLE_RESIDENTIAL_KW } from './site';

/**
 * Simulated generation actuals, derived from the forecast that was stored for the same hour.
 *
 * The fleet has no telemetry feed — the sites are synthetic — so "what actually happened" has to
 * be manufactured. It is manufactured *here*, from the stored physics forecast, rather than by a
 * second weather fetch or a second model: a simulated actual is the forecast knocked off course
 * by a bounded per-site-per-hour draw, which is exactly the relationship the error metrics exist
 * to measure. Zero Open-Meteo calls, and no claim of measurement is made anywhere it surfaces —
 * the UI labels these readings as simulated (#264).
 *
 * Pure by construction (`architecture.md` rule 3): no clock, no I/O, no randomness. The draw is
 * keyed by `(siteId, validTime)`, so the same forecast always yields the same actual — which is
 * what makes writing these rows idempotent, in any order, from any process.
 */

/**
 * The draw's bounds — a simulated actual sits in `[85 %, 115 %)` of its forecast.
 *
 * Restatement ledger (`architecture.md` rule 9): these two are the owners of the ±15 % figure.
 * `simulated-actual.test.ts`'s bounds sweep asserts the literals `0.85` and `1.15` rather than
 * importing these constants, because a test that reads the value it is proving moves with it and
 * proves nothing. Change either bound and that test is the copy to change with it.
 */
export const SIMULATED_ACTUAL_FACTOR_MIN = 0.85;

/** @see SIMULATED_ACTUAL_FACTOR_MIN — the ledger comment covers both bounds. */
export const SIMULATED_ACTUAL_FACTOR_MAX = 1.15;

/** Power values are recorded to watt precision; the underlying forecast claims nothing finer. */
const POWER_DECIMALS = 3;

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * FNV-1a, 32-bit — a small, dependency-free string hash, used only to fold the `(siteId,
 * validTime)` pair into the single integer the scramble below consumes. Not a cryptographic
 * primitive and not asked to be one; what it must be is byte-identical across JS engines, so a
 * site's actual for an hour reads the same in Node, the browser and CI.
 */
const fnv1a32 = (text: string): number => {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), FNV_PRIME);
  }
  return hash >>> 0;
};

/**
 * A seeded draw in `[0, 1)` — mulberry32's step arithmetic applied once, keyed by `seed`.
 *
 * Deliberately a local copy of the arithmetic in `fleet.ts` (and of the copy in `apps/web`'s
 * `fixture-series.ts`) rather than an import of either (`docs/standards/structure.md` rule 7):
 * `fleet.ts`'s is a *stream* whose draw order is the canonical fleet's contract, and the web
 * one belongs to a demo fixture the packages must not depend on (`architecture.md` rule 1).
 * This one is a pure hash over an explicit key. Retuning any of the three must not move the
 * other two.
 */
const seededUnit = (seed: number): number => {
  let t = (seed + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const roundTo = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

/**
 * The simulated actual for the hour a forecast covers: the forecast's `acPowerKw` scaled by a
 * deterministic factor in `[`{@link SIMULATED_ACTUAL_FACTOR_MIN}`, `
 * {@link SIMULATED_ACTUAL_FACTOR_MAX}`)`, clamped to the `0`–{@link MAX_PLAUSIBLE_RESIDENTIAL_KW}
 * range every power value in this domain lives in.
 *
 * A zero forecast yields exactly zero: night is night however the draw lands.
 *
 * The result is parsed rather than asserted — the clamping above is what keeps the schema's
 * bounds satisfied, and a parse is what proves it stayed true.
 */
export const simulatedActualFromForecast = (forecast: Forecast): GenerationReading => {
  const unitDraw = seededUnit(fnv1a32(`${forecast.siteId}|${forecast.validTime}`));
  const factor =
    SIMULATED_ACTUAL_FACTOR_MIN +
    unitDraw * (SIMULATED_ACTUAL_FACTOR_MAX - SIMULATED_ACTUAL_FACTOR_MIN);
  return generationReadingSchema.parse({
    siteId: forecast.siteId,
    validTime: forecast.validTime,
    acPowerKw: roundTo(
      Math.min(MAX_PLAUSIBLE_RESIDENTIAL_KW, Math.max(0, forecast.acPowerKw * factor)),
      POWER_DECIMALS,
    ),
  });
};
