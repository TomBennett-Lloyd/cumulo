/**
 * The shape of the committed pvlib golden-fixture file, as a zod schema.
 *
 * The fixtures are external data: they are produced by a Python generator under `tools/`
 * (see `tools/pvlib-fixtures/README.md`) that no TypeScript build step can check, so they
 * are `unknown` until parsed here rather than cast into shape (typing rule 3). The schema
 * is the contract between the two languages, and it is the only place the file's layout is
 * written down on this side of the boundary.
 *
 * Every object is strict: an unrecognised key is a load failure, not a silently stripped
 * field. That is deliberate for reference data — if the generator starts emitting a new
 * expected quantity, the comparison test does not know how to check it, and a fixture
 * nobody checks is worse than no fixture at all (ADR 0003: fixtures that look like
 * validation without being it are the failure mode).
 *
 * Physical bounds are deliberately *not* restated here. Each case's site and weather are
 * parsed through `siteSchema` / `weatherReadingSchema` by the test that consumes them, so
 * the domain schemas stay the single source of truth for what a valid input is — and
 * every fixture case is thereby proven to be an input production would accept.
 */

import { utcIsoTimestampSchema } from '@cumulo/shared';
import { z } from 'zod';

const nonEmptyString = z.string().min(1);

/**
 * The exact pvlib function and model option used for each step of the chain, recorded as
 * free text by the generator.
 *
 * ADR 0003 requires this: "generator and port must use the same named model", and a
 * tolerance comparison against an unrecorded model measures the gap between two different
 * physics rather than the fidelity of the port. The keys are enumerated so that a step
 * losing its provenance line fails the load.
 */
export const goldenModelPinsSchema = z.strictObject({
  solarPosition: nonEmptyString,
  evaluationInstant: nonEmptyString,
  extraterrestrial: nonEmptyString,
  aoi: nonEmptyString,
  skyDiffuse: nonEmptyString,
  groundDiffuse: nonEmptyString,
  cellTemperature: nonEmptyString,
  dcPower: nonEmptyString,
  acPower: nonEmptyString,
  /** How the generator synthesised the clear-sky irradiance inputs themselves. */
  clearSkyWeather: nonEmptyString,
});

/**
 * Where the numbers came from: library versions, the generating script and commit, and the
 * models above. Without it, a mismatch after a pvlib upgrade is a mystery rather than a
 * diagnosis (ADR 0003).
 */
export const goldenProvenanceSchema = z.strictObject({
  pvlibVersion: nonEmptyString,
  numpyVersion: nonEmptyString,
  pandasVersion: nonEmptyString,
  pythonVersion: nonEmptyString,
  /** SHA-256 of `generate_fixtures.py`, so the file names the code that produced it. */
  scriptSha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** `git rev-parse HEAD` at generation time, with a `-dirty` suffix when applicable. */
  gitCommit: nonEmptyString,
  /** The one run-varying field: `SOURCE_DATE_EPOCH` when set, otherwise the wall clock. */
  generatedAt: utcIsoTimestampSchema,
  models: goldenModelPinsSchema,
});

/** The array geometry and nameplate a case was generated for. */
export const goldenCaseSiteSchema = z.strictObject({
  latitude: z.number(),
  longitude: z.number(),
  tiltDegrees: z.number(),
  azimuthDegrees: z.number(),
  capacityKw: z.number(),
});

/** The weather inputs of a case, in the units their names carry. */
export const goldenCaseWeatherSchema = z.strictObject({
  ghiWm2: z.number(),
  dniWm2: z.number(),
  dhiWm2: z.number(),
  temperature2mC: z.number(),
  windSpeed10mMs: z.number(),
});

/**
 * pvlib's answer for one case — every intermediate, not just the final power.
 *
 * ADR 0003 requires the intermediates: a fixture that asserts only AC power lets two
 * compensating errors through and, when it does fail, says nothing about which stage of
 * the chain is wrong.
 */
export const goldenCaseExpectedSchema = z.strictObject({
  apparentZenithDeg: z.number(),
  azimuthDeg: z.number(),
  aoiDeg: z.number(),
  poaBeamWm2: z.number(),
  poaSkyDiffuseWm2: z.number(),
  poaGroundWm2: z.number(),
  poaTotalWm2: z.number(),
  cellTemperatureC: z.number(),
  dcPowerKw: z.number(),
  acPowerKw: z.number(),
});

/** One reference case: typed inputs paired with pvlib's outputs for them. */
export const goldenCaseSchema = z.strictObject({
  /** Stable identifier, e.g. `edge-clipping` or a `grid-…` parameter encoding. */
  id: nonEmptyString,
  description: nonEmptyString,
  site: goldenCaseSiteSchema,
  /** End of the hour the weather means cover; geometry is evaluated 30 minutes earlier. */
  validTime: utcIsoTimestampSchema,
  weather: goldenCaseWeatherSchema,
  params: z.strictObject({ albedo: z.number() }),
  expected: goldenCaseExpectedSchema,
});

/** The committed fixture file as a whole. */
export const goldenFixtureFileSchema = z.strictObject({
  provenance: goldenProvenanceSchema,
  cases: z.array(goldenCaseSchema).min(1),
});

export type GoldenModelPins = z.infer<typeof goldenModelPinsSchema>;
export type GoldenProvenance = z.infer<typeof goldenProvenanceSchema>;
export type GoldenCase = z.infer<typeof goldenCaseSchema>;
export type GoldenCaseExpected = z.infer<typeof goldenCaseExpectedSchema>;
export type GoldenFixtureFile = z.infer<typeof goldenFixtureFileSchema>;
