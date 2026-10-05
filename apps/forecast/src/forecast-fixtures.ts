import {
  forecastWeatherReadingSchema,
  sitePhysicsSchema,
  utcIsoTimestampSchema,
  type Forecast,
  type ForecastWeatherReading,
  type SitePhysics,
  type UtcIsoTimestamp,
} from '@cumulo/shared';

import type { BatchWriteOutcome, SeriesRangeResult } from '@cumulo/storage';

import type { ConsumeMessageDeps } from './consume-message';
import type { SqsRecord } from './sqs-event';

/**
 * Fixtures shared by this service's tests: a site, a weather hour, and the two
 * shapes the queue delivers them in.
 *
 * Test support, in one module rather than a copy per test file, for the reason
 * `docs/standards/testing.md` rule 5 gives: each of these encodes one thing — what
 * a site looks like, what a schema-valid weather hour looks like — and a change to
 * the underlying schema has to reach every test at once. Nothing here is imported
 * by `main.ts`, so none of it reaches the deployed bundle.
 *
 * Everything is built through the real schemas rather than asserted into shape, so
 * a fixture that stopped being valid domain data fails here rather than proving a
 * behaviour on input the system would never see.
 */

/** Stable uuids, so a test asserting on a site id is not asserting on randomness. */
export const RANELAGH_ID = '3f1a2b4c-5d6e-4f7a-8b9c-0d1e2f3a4b5c';
export const RATHMINES_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

/** The vintage every test stamps, unless it is testing the clock itself. */
export const ISSUED_AT: UtcIsoTimestamp = utcIsoTimestampSchema.parse('2026-07-31T12:00:00Z');

/**
 * Two sites a kilometre apart in Dublin 6, which `locationId` rounds to the same
 * bucket — the co-location the fan-out exists to serve.
 */
export const sitePhysics = (overrides: Partial<SitePhysics> = {}): SitePhysics =>
  sitePhysicsSchema.parse({
    id: RANELAGH_ID,
    latitude: 53.3245,
    longitude: -6.2601,
    tiltDegrees: 35,
    azimuthDegrees: 180,
    capacityKw: 4.2,
    ...overrides,
  });

/**
 * A midday July hour at the Dublin site: bright, warm, and comfortably inside
 * every bound `weatherReadingSchema` sets.
 */
export const reading = (
  overrides: Partial<Omit<ForecastWeatherReading, 'validTime' | 'kind'>> & {
    readonly validTime?: string;
  } = {},
): ForecastWeatherReading =>
  forecastWeatherReadingSchema.parse({
    latitude: 53.3245,
    longitude: -6.2601,
    validTime: '2026-07-31T13:00:00Z',
    kind: 'forecast',
    source: 'open-meteo',
    shortwaveRadiationWm2: 620,
    directRadiationWm2: 420,
    diffuseRadiationWm2: 200,
    directNormalIrradianceWm2: 780,
    temperature2mC: 21,
    windSpeed10mMs: 3.5,
    cloudCoverPct: 25,
    ...overrides,
  });

/**
 * The same location at 02:00 local: the sun is below the horizon and every
 * radiation field is zero. The hour a naive implementation would skip.
 */
export const nightReading = (): ForecastWeatherReading =>
  reading({
    validTime: '2026-07-31T02:00:00Z',
    shortwaveRadiationWm2: 0,
    directRadiationWm2: 0,
    diffuseRadiationWm2: 0,
    directNormalIrradianceWm2: 0,
    temperature2mC: 11,
    cloudCoverPct: 90,
  });

/**
 * A promise that rejects with an arbitrary value.
 *
 * Adapter doubles need this because JavaScript permits rejecting with anything,
 * and "what does the service do with a non-Error rejection?" is a real question
 * about `describeThrown`. Written as a `then` that throws rather than as
 * `Promise.reject(value)`, because the latter is exactly the pattern
 * `@typescript-eslint/prefer-promise-reject-errors` exists to catch in production
 * code — and the rule is right; this module is where the exception belongs, once,
 * with the reason attached.
 */
export const rejectedWith = <T>(thrown: unknown): Promise<T> =>
  Promise.resolve().then<T>(() => {
    throw thrown;
  });

/** One SQS record, with the body ingestion's publisher would have sent. */
export const recordOf = (
  messageId: string,
  readings: readonly ForecastWeatherReading[],
): SqsRecord => ({
  messageId,
  body: JSON.stringify(readings),
});
/**
 * The adapter doubles one message's processing runs against, and the recorder they write to.
 *
 * Here rather than in `consume-message.test.ts` because two suites now need the same wiring — that
 * one and `fleet-rollup-write.test.ts`, which has to prove that a roll-up failure leaves the
 * message's own outcome untouched, and can only prove it through `consumeMessage` itself. Copying
 * the harness would mean a fourth `series` method reaching one copy and not the other
 * (`docs/standards/structure.md` rule 7).
 *
 * The doubles are deliberately thin — they answer or they reject — because what is under test is
 * the *conversion*: which adapter answer becomes which outcome, and which throw becomes which
 * `failed` detail. Nothing here asserts that a mock was called
 * (`docs/standards/testing.md` rule 3).
 */

/** What the doubles saw, so a test can assert on writes without a spy framework. */
export interface Recorder {
  readonly written: Forecast[][];
  readonly locationsQueried: string[];
  /** Site ids whose trailing window was read — the simulated-actuals producer's first move. */
  readonly simulatedFor: string[];
  /** What the fleet roll-up write was handed: which location, and how many hours (#494). */
  readonly rolledUp: { readonly locationId: string; readonly hourCount: number }[];
  readonly entries: Record<string, unknown>[];
}

export const emptyRecorder = (): Recorder => ({
  written: [],
  locationsQueried: [],
  simulatedFor: [],
  rolledUp: [],
  entries: [],
});

export interface DepsInput {
  readonly recorder: Recorder;
  /** What the sites lookup answers with; defaults to one Ranelagh site. */
  readonly sites?: readonly SitePhysics[];
  /** Rejected by the sites lookup instead of answering. */
  readonly sitesRejectsWith?: unknown;
  /** What the series write answers with; defaults to a complete drain. */
  readonly storeOutcome?: BatchWriteOutcome;
  /** Rejected by the series write instead of answering. */
  readonly storeRejectsWith?: unknown;
  /** Rejected by the trailing-window read instead of answering with an empty window. */
  readonly trailingRejectsWith?: unknown;
  /** What the fleet roll-up write answers with; defaults to a complete drain (#494). */
  readonly rollupOutcome?: BatchWriteOutcome;
  /** Rejected by the fleet roll-up write instead of answering. */
  readonly rollupRejectsWith?: unknown;
  readonly now?: () => UtcIsoTimestamp;
}

export const deps = (input: DepsInput): ConsumeMessageDeps => ({
  sites: {
    listActiveSitePhysicsAtLocation: (locationId: string): Promise<SitePhysics[]> => {
      input.recorder.locationsQueried.push(locationId);
      return input.sitesRejectsWith === undefined
        ? Promise.resolve([...(input.sites ?? [sitePhysics()])])
        : rejectedWith(input.sitesRejectsWith);
    },
  },
  series: {
    putForecasts: (forecasts): Promise<BatchWriteOutcome> => {
      if (input.storeRejectsWith !== undefined) {
        return rejectedWith(input.storeRejectsWith);
      }
      input.recorder.written.push([...forecasts]);
      return Promise.resolve(input.storeOutcome ?? { status: 'complete' });
    },
    // The simulated-actuals producer's two calls. The window answers empty unless a test rejects
    // it, so every existing case runs the producer over a site with nothing to simulate — which
    // is what makes "the message's outcome does not depend on it" the default rather than a
    // specially wired case.
    querySeriesRange: (siteId): Promise<SeriesRangeResult> => {
      input.recorder.simulatedFor.push(siteId);
      return input.trailingRejectsWith === undefined
        ? Promise.resolve({ points: [], complete: true })
        : rejectedWith(input.trailingRejectsWith);
    },
    putGenerationReadings: (): Promise<BatchWriteOutcome> =>
      Promise.resolve({ status: 'complete' }),
    // The fleet roll-up write (#494). It rejects only where a test asks it to, so every existing
    // case runs it for real and the claim "the message's outcome does not depend on it" is the
    // default rather than a specially wired case — the same arrangement the trailing window above
    // is in, and for the same reason.
    putFleetRollupPartials: (_kind, locationId, partials): Promise<BatchWriteOutcome> => {
      if (input.rollupRejectsWith !== undefined) {
        return rejectedWith(input.rollupRejectsWith);
      }
      input.recorder.rolledUp.push({ locationId, hourCount: partials.length });
      return Promise.resolve(input.rollupOutcome ?? { status: 'complete' });
    },
  },
  log: (entry) => {
    input.recorder.entries.push(entry);
  },
  now: input.now ?? ((): UtcIsoTimestamp => ISSUED_AT),
});

/**
 * The `detail` of an outcome that carries one, or a failure naming what came back
 * instead. A typed narrowing rather than `expect.stringContaining` inside a
 * `toMatchObject`, which types as `any` and would let a wrong-shaped outcome pass.
 */
