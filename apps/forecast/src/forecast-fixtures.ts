import {
  forecastWeatherReadingSchema,
  sitePhysicsSchema,
  utcIsoTimestampSchema,
  type ForecastWeatherReading,
  type SitePhysics,
  type UtcIsoTimestamp,
} from '@cumulo/shared';

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
