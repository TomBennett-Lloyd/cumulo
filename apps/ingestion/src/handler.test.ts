import { fleetSiteSchema, locationId, weatherReadingSchema } from '@cumulo/shared';
import type { FleetSite } from '@cumulo/shared';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  cycleStartedEvent,
  locationOutcomeEvent,
  type CycleBudget,
  type RunCycleDeps,
} from './cycle';
import { SteppingClock, cycleStartMs, productionBudget } from './cycle-test-harness';
import { createHandler, cycleSummaryEvent, jsonLineLog, CycleFailedError } from './handler';
import type { ForecastWeatherReading } from './open-meteo/response';
import type { ForecastLocation } from './open-meteo/url';

/**
 * The handler is tested through the real `runCycle` — the question it answers is
 * "did this invocation fail?", and that answer is a function of what the cycle
 * actually did, not of a stub's say-so (testing.md rule 1). Only the four effects
 * are doubles, and they are deliberately thinner than `cycle.test.ts`'s: nothing
 * here depends on which location did what, only on how many published.
 */

const bristol: ForecastLocation = { latitude: 51.45, longitude: -2.59 };
const dublin: ForecastLocation = { latitude: 53.35, longitude: -6.26 };
const edinburgh: ForecastLocation = { latitude: 55.95, longitude: -3.19 };

const threeLocations: readonly ForecastLocation[] = [bristol, dublin, edinburgh];

const forecastReadingSchema = weatherReadingSchema.extend({ kind: z.literal('forecast') });

const readingAt = (location: ForecastLocation): ForecastWeatherReading =>
  forecastReadingSchema.parse({
    latitude: location.latitude,
    longitude: location.longitude,
    validTime: '2026-07-31T00:00:00Z',
    kind: 'forecast',
    source: 'open-meteo',
    shortwaveRadiationWm2: 400,
    directRadiationWm2: 250,
    diffuseRadiationWm2: 150,
    directNormalIrradianceWm2: 600,
    temperature2mC: 18,
    windSpeed10mMs: 3,
    cloudCoverPct: 40,
  });

const siteAt = (index: number, location: ForecastLocation): FleetSite =>
  fleetSiteSchema.parse({
    id: `00000000-0000-4000-8000-00000000000${String(index)}`,
    name: `Site ${String(index)}`,
    latitude: location.latitude,
    longitude: location.longitude,
    tiltDegrees: 35,
    azimuthDegrees: 180,
    capacityKw: 4,
    origin: 'seed',
    createdAt: '2026-07-30T00:00:00Z',
    active: true,
  });

type LogEntry = Record<string, unknown>;

interface HandlerRecord {
  /** Location ids the publisher accepted — the cycle's real output. */
  readonly published: string[];
  readonly entries: LogEntry[];
}

const emptyRecord = (): HandlerRecord => ({ published: [], entries: [] });

interface HandlerDepsInput {
  readonly locations: readonly ForecastLocation[];
  /** Ids whose fetch is rate-limited: a location that fails without anything throwing. */
  readonly rateLimited?: readonly string[];
  /** Ids whose publish throws. */
  readonly publishThrows?: readonly string[];
  readonly record: HandlerRecord;
  /** Defaults to {@link productionBudget}; narrowed by the tests about the bounds. */
  readonly budget?: CycleBudget;
  readonly now?: () => number;
}

const handlerDeps = (input: HandlerDepsInput): RunCycleDeps => ({
  sites: {
    listFleetSites: () =>
      Promise.resolve(input.locations.map((location, index) => siteAt(index, location))),
  },
  weather: { putForecastWeather: () => Promise.resolve({ status: 'complete' }) },
  publisher: {
    publishLocationReadings: (readings) => {
      const [first] = readings;
      if (first === undefined) {
        throw new Error('the cycle published an empty batch');
      }
      const id = locationId(first);
      if (input.publishThrows?.includes(id) ?? false) {
        return Promise.reject(new Error(`the queue exploded for ${id}`));
      }
      input.record.published.push(id);
      return Promise.resolve();
    },
  },
  fetchForecast: (location) =>
    Promise.resolve(
      (input.rateLimited ?? []).includes(locationId(location))
        ? { outcome: 'rate-limited' }
        : { outcome: 'ok', readings: [readingAt(location)], droppedHours: 0 },
    ),
  log: (entry) => {
    input.record.entries.push(entry);
  },
  // The shipped budget, so these tests exercise the configuration that deploys
  // (`docs/standards/testing.md` rule 7). Three locations is far inside both
  // bounds, so nothing here is ever skipped — `cycle.test.ts` owns the cases
  // where they bite.
  now: input.now ?? ((): number => cycleStartMs),
  budget: input.budget ?? productionBudget,
});

const expectCycleFailure = (thrown: unknown): CycleFailedError => {
  if (!(thrown instanceof CycleFailedError)) {
    throw new Error(`expected a CycleFailedError, got ${String(thrown)}`);
  }
  return thrown;
};

/** The rejection reason, or a failure if the promise resolved after all. */
const rejectionOf = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    (value) => {
      throw new Error(`expected a rejection, got ${JSON.stringify(value)}`);
    },
    (error: unknown) => error,
  );

const eventsIn = (record: HandlerRecord): unknown[] => record.entries.map((entry) => entry.event);

describe('createHandler', () => {
  it('a fully successful cycle returns its report and logs a summary', async () => {
    const record = emptyRecord();
    const handler = createHandler(handlerDeps({ locations: threeLocations, record }));

    const report = await handler();

    expect(report).toMatchObject({ activeLocations: 3, published: 3, failed: 0 });
    expect(record.published).toHaveLength(3);
    expect(eventsIn(record)).toEqual([
      cycleStartedEvent,
      locationOutcomeEvent,
      locationOutcomeEvent,
      locationOutcomeEvent,
      cycleSummaryEvent,
    ]);
    expect(record.entries.at(-1)).toEqual({
      event: cycleSummaryEvent,
      activeLocations: 3,
      published: 3,
      failed: 0,
      deferred: 0,
      skippedForDeadline: 0,
    });
  });

  it('a cycle with any failed location throws CycleFailedError after processing every location', async () => {
    const record = emptyRecord();
    const handler = createHandler(
      handlerDeps({
        locations: threeLocations,
        publishThrows: [locationId(dublin)],
        record,
      }),
    );

    const failure = expectCycleFailure(await rejectionOf(handler()));

    expect(failure).toMatchObject({ name: 'CycleFailedError', failed: 1, total: 3 });
    expect(failure.message).toBe('ingestion cycle failed: 1 of 3 locations did not publish');
    // The throw is the *last* thing that happens: the other two locations were
    // published and every outcome was logged before the invocation failed.
    expect(record.published).toEqual([locationId(bristol), locationId(edinburgh)]);
    expect(eventsIn(record)).toEqual([
      cycleStartedEvent,
      locationOutcomeEvent,
      locationOutcomeEvent,
      locationOutcomeEvent,
      cycleSummaryEvent,
    ]);
  });

  it('a cycle whose locations all failed politely still fails the invocation', async () => {
    // Nothing throws anywhere in this run — every location is rate-limited, which
    // is a domain value. Without the handler's verdict the Lambda would return
    // normally and the `Errors` metric would show a healthy cycle that fetched,
    // stored and published nothing (error-handling rule 5).
    const record = emptyRecord();
    const handler = createHandler(
      handlerDeps({
        locations: threeLocations,
        rateLimited: threeLocations.map((location) => locationId(location)),
        record,
      }),
    );

    const failure = expectCycleFailure(await rejectionOf(handler()));

    expect(failure).toMatchObject({ failed: 3, total: 3 });
    expect(record.published).toEqual([]);
  });

  it('an empty active fleet is a successful invocation', async () => {
    const record = emptyRecord();
    const handler = createHandler(handlerDeps({ locations: [], record }));

    const report = await handler();

    expect(report).toMatchObject({ activeLocations: 0, published: 0, failed: 0 });
    expect(eventsIn(record)).toEqual([cycleStartedEvent, cycleSummaryEvent]);
  });

  it('jsonLineLog writes each entry as one line of JSON', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...data: unknown[]) => {
      lines.push(data.map(String).join(' '));
    });

    try {
      const record = emptyRecord();
      const deps = handlerDeps({ locations: [dublin], record });
      await createHandler({ ...deps, log: jsonLineLog })();
    } finally {
      spy.mockRestore();
    }

    expect(lines).toEqual([
      `{"event":"${cycleStartedEvent}","fleetSites":1,"activeLocations":1,"attemptedLocations":1}`,
      `{"event":"${locationOutcomeEvent}","locationId":"${locationId(dublin)}","status":"published","readingCount":1,"droppedHours":0}`,
      `{"event":"${cycleSummaryEvent}","activeLocations":1,"published":1,"failed":0,"deferred":0,"skippedForDeadline":0}`,
    ]);
  });

  it('a cycle that defers locations to the cap is still a successful invocation', async () => {
    // The #115 ruling, pinned where it actually bites. A fleet legitimately
    // larger than the cap defers on *every* cycle, so counting deferrals as
    // failures would make this function's error metric permanently red — and
    // the CloudWatch alarm on it permanently useless — for a system working
    // exactly as designed.
    const record = emptyRecord();
    const handler = createHandler(
      handlerDeps({
        locations: threeLocations,
        budget: { ...productionBudget, maxLocations: 2 },
        record,
      }),
    );

    const report = await handler();

    expect(report).toMatchObject({ activeLocations: 3, published: 2, failed: 0, deferred: 1 });
    expect(record.entries.at(-1)).toMatchObject({
      event: cycleSummaryEvent,
      failed: 0,
      deferred: 1,
      skippedForDeadline: 0,
    });
  });

  it('a cycle cut short by its deadline does fail the invocation', async () => {
    // The other half of the same ruling: a deadline skip is pathology, not
    // scheduling, so it stays in `failed` and still raises the alarm.
    const record = emptyRecord();
    const clock = new SteppingClock(400);
    const handler = createHandler(
      handlerDeps({
        locations: threeLocations,
        budget: { deadlineMs: 500, maxLocations: productionBudget.maxLocations },
        now: () => clock.read(),
        record,
      }),
    );

    const failure = expectCycleFailure(await rejectionOf(handler()));

    expect(failure).toMatchObject({ failed: 2, total: 3 });
    expect(record.entries.at(-1)).toMatchObject({
      event: cycleSummaryEvent,
      published: 1,
      failed: 2,
      deferred: 0,
      skippedForDeadline: 2,
    });
  });
});
