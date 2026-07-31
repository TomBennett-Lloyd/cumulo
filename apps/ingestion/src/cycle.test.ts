import { fleetSiteSchema, locationId, weatherReadingSchema } from '@cumulo/shared';
import type { FleetSite, WeatherReading } from '@cumulo/shared';
import type { SiteAdapter, WeatherAdapter } from '@cumulo/storage';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { cycleStartedEvent, locationOutcomeEvent, runCycle, type RunCycleDeps } from './cycle';
import type { ForecastWeatherReading } from './open-meteo/response';
import type { ForecastLocation } from './open-meteo/url';
import type { WeatherPublisher } from './publisher';

/**
 * The cycle is exercised end to end against scripted adapters: a real fleet parsed
 * by `fleetSiteSchema`, the real `activeFetchLocations` collapse, and real readings
 * parsed by the shared schema. Only the four effects are doubles, and each one
 * records what it was asked *in the order it was asked*, because the ordering of
 * store and publish is a correctness property of this module rather than an
 * implementation detail (testing.md rule 1).
 *
 * Locations are identified everywhere by `locationId`, computed from the
 * coordinates the doubles actually receive. That is what ties an assertion to the
 * right location without any double being told which location it is serving — a
 * cycle that fetched one bucket and stored under another would fail here rather
 * than pass with matching counts.
 */

/** Four distinct weather buckets. Listed in the ascending-id order the cycle visits. */
const bristol: ForecastLocation = { latitude: 51.45, longitude: -2.59 };
const dublin: ForecastLocation = { latitude: 53.35, longitude: -6.26 };
const manchester: ForecastLocation = { latitude: 53.48, longitude: -2.24 };
const edinburgh: ForecastLocation = { latitude: 55.95, longitude: -3.19 };

const bristolId = locationId(bristol);
const dublinId = locationId(dublin);
const manchesterId = locationId(manchester);
const edinburghId = locationId(edinburgh);

const readingsPerLocation = 2;
const droppedHoursPerFetch = 1;
const unprocessedOnPartial = 3;
const malformedDetail = 'hourly columns have different lengths than hourly.time';
const unreachableDetail = '2 attempts failed; last: TypeError: fetch failed';

interface TestSiteInput {
  readonly index: number;
  readonly location: ForecastLocation;
  readonly active: boolean;
}

/**
 * Parsed rather than cast: a fixture that could not survive `fleetSiteSchema` is a
 * fixture describing a site the control plane cannot hold, and would prove nothing
 * about a cycle that reads real ones.
 */
const siteAt = (input: TestSiteInput): FleetSite =>
  fleetSiteSchema.parse({
    id: `00000000-0000-4000-8000-00000000000${String(input.index)}`,
    name: `Site ${String(input.index)}`,
    latitude: input.location.latitude,
    longitude: input.location.longitude,
    tiltDegrees: 35,
    azimuthDegrees: 180,
    capacityKw: 4,
    origin: 'seed',
    createdAt: '2026-07-30T00:00:00Z',
    active: input.active,
  });

/** Dublin carries two sites, so the fleet is five sites over four fetch locations. */
const fleetLocations: readonly ForecastLocation[] = [
  bristol,
  dublin,
  dublin,
  manchester,
  edinburgh,
];

const fleetOf = (active: boolean): FleetSite[] =>
  fleetLocations.map((location, index) => siteAt({ index, location, active }));

const activeFleet = fleetOf(true);
const inactiveFleet = fleetOf(false);

/** `weatherReadingSchema` with the `kind` axis fixed, mirroring what the parser emits. */
const forecastReadingSchema = weatherReadingSchema.extend({ kind: z.literal('forecast') });

const readingsFor = (location: ForecastLocation): ForecastWeatherReading[] =>
  Array.from({ length: readingsPerLocation }, (_, hour) =>
    forecastReadingSchema.parse({
      latitude: location.latitude,
      longitude: location.longitude,
      validTime: `2026-07-31T0${String(hour)}:00:00Z`,
      kind: 'forecast',
      source: 'open-meteo',
      shortwaveRadiationWm2: 400,
      directRadiationWm2: 250,
      diffuseRadiationWm2: 150,
      directNormalIrradianceWm2: 600,
      temperature2mC: 18,
      windSpeed10mMs: 3,
      cloudCoverPct: 40,
    }),
  );

/**
 * Which location a batch belongs to, recovered from the readings themselves. An
 * empty batch throws rather than being recorded under some placeholder: the cycle
 * only ever hands on readings it received from a successful fetch, so an empty one
 * would be a bug this fixture must not hide.
 */
const locationIdOfBatch = (readings: readonly WeatherReading[]): string => {
  const [first] = readings;
  if (first === undefined) {
    throw new Error('the cycle passed on an empty batch of readings');
  }
  return locationId(first);
};

type LogEntry = Record<string, unknown>;

/** Everything the cycle did, in order, and everything it said about it. */
interface CycleRecord {
  readonly calls: string[];
  readonly entries: LogEntry[];
}

const emptyRecord = (): CycleRecord => ({ calls: [], entries: [] });

type FetchBehaviour = 'ok' | 'rate-limited' | 'malformed' | 'unreachable' | 'throws';
type StoreBehaviour = 'complete' | 'partial' | 'throws';
type PublishBehaviour = 'ok' | 'throws';

/** How one location's three effects behave. Anything unstated succeeds. */
interface LocationScript {
  readonly fetch?: FetchBehaviour;
  readonly store?: StoreBehaviour;
  readonly publish?: PublishBehaviour;
}

interface CycleDepsInput {
  readonly sites: readonly FleetSite[];
  readonly scripts?: Readonly<Record<string, LocationScript>>;
  readonly record: CycleRecord;
}

const everythingSucceeds: LocationScript = {};

const scriptFor = (input: CycleDepsInput, id: string): LocationScript =>
  input.scripts?.[id] ?? everythingSucceeds;

const sitesDouble = (input: CycleDepsInput): Pick<SiteAdapter, 'listFleetSites'> => ({
  listFleetSites: () => Promise.resolve([...input.sites]),
});

const fetchForecastDouble =
  (input: CycleDepsInput): RunCycleDeps['fetchForecast'] =>
  (location) => {
    const id = locationId(location);
    input.record.calls.push(`fetch:${id}`);

    switch (scriptFor(input, id).fetch ?? 'ok') {
      case 'ok':
        return Promise.resolve({
          outcome: 'ok',
          readings: readingsFor(location),
          droppedHours: droppedHoursPerFetch,
        });
      case 'rate-limited':
        return Promise.resolve({ outcome: 'rate-limited' });
      case 'malformed':
        return Promise.resolve({ outcome: 'malformed', detail: malformedDetail });
      case 'unreachable':
        return Promise.resolve({ outcome: 'unreachable', detail: unreachableDetail });
      case 'throws':
        return Promise.reject(new Error(`fetch exploded for ${id}`));
    }
  };

const weatherDouble = (input: CycleDepsInput): Pick<WeatherAdapter, 'putForecastWeather'> => ({
  putForecastWeather: (readings) => {
    const id = locationIdOfBatch(readings);
    input.record.calls.push(`store:${id}`);

    switch (scriptFor(input, id).store ?? 'complete') {
      case 'complete':
        return Promise.resolve({ status: 'complete' });
      case 'partial':
        return Promise.resolve({ status: 'partial', unprocessedCount: unprocessedOnPartial });
      case 'throws':
        return Promise.reject(new Error(`DynamoDB exploded for ${id}`));
    }
  },
});

const publisherDouble = (input: CycleDepsInput): WeatherPublisher => ({
  publishLocationReadings: (readings) => {
    const id = locationIdOfBatch(readings);
    input.record.calls.push(`publish:${id}`);

    return scriptFor(input, id).publish === 'throws'
      ? Promise.reject(new Error(`the queue exploded for ${id}`))
      : Promise.resolve();
  },
});

const cycleDeps = (input: CycleDepsInput): RunCycleDeps => ({
  sites: sitesDouble(input),
  weather: weatherDouble(input),
  publisher: publisherDouble(input),
  fetchForecast: fetchForecastDouble(input),
  log: (entry) => {
    input.record.entries.push(entry);
  },
});

const publishedOutcome = (id: string): LogEntry => ({
  locationId: id,
  status: 'published',
  readingCount: readingsPerLocation,
  droppedHours: droppedHoursPerFetch,
});

const effectsFor = (id: string): string[] => [`fetch:${id}`, `store:${id}`, `publish:${id}`];

describe('runCycle', () => {
  it('a fully successful cycle resolves', async () => {
    const record = emptyRecord();

    const report = await runCycle(cycleDeps({ sites: activeFleet, record }));

    expect(report).toEqual({
      locations: [bristolId, dublinId, manchesterId, edinburghId].map(publishedOutcome),
      activeLocations: 4,
      published: 4,
      failed: 0,
    });
    expect(record.calls).toEqual([
      ...effectsFor(bristolId),
      ...effectsFor(dublinId),
      ...effectsFor(manchesterId),
      ...effectsFor(edinburghId),
    ]);
    expect(record.entries).toEqual([
      { event: cycleStartedEvent, fleetSites: 5, activeLocations: 4 },
      ...[bristolId, dublinId, manchesterId, edinburghId].map((id) => ({
        event: locationOutcomeEvent,
        ...publishedOutcome(id),
      })),
    ]);
  });

  it("a location's readings are stored before they are published", async () => {
    // The ordering ADR 0004 rests on: the table is the record, the message is a
    // trigger carrying a copy. Publishing first would announce readings the
    // forecast service could then fail to read back.
    const record = emptyRecord();
    const oneSite = [siteAt({ index: 1, location: dublin, active: true })];

    await runCycle(cycleDeps({ sites: oneSite, record }));

    expect(record.calls).toEqual([`fetch:${dublinId}`, `store:${dublinId}`, `publish:${dublinId}`]);
  });

  it('an empty active fleet resolves without calling fetch', async () => {
    // API frugality at its limit (CLAUDE.md): no active site anywhere means no
    // third-party call at all — and the cycle still says so, because a silent
    // zero-call run is indistinguishable from a run that never happened.
    const record = emptyRecord();

    const report = await runCycle(cycleDeps({ sites: inactiveFleet, record }));

    expect(report).toEqual({ locations: [], activeLocations: 0, published: 0, failed: 0 });
    expect(record.calls).toEqual([]);
    expect(record.entries).toEqual([
      { event: cycleStartedEvent, fleetSites: 5, activeLocations: 0 },
    ]);
  });

  it('one rate-limited location does not stop the remaining locations from publishing', async () => {
    const record = emptyRecord();

    const report = await runCycle(
      cycleDeps({
        sites: activeFleet,
        scripts: { [bristolId]: { fetch: 'rate-limited' } },
        record,
      }),
    );

    expect(report.locations).toEqual([
      { locationId: bristolId, status: 'rate-limited' },
      ...[dublinId, manchesterId, edinburghId].map(publishedOutcome),
    ]);
    expect(report).toMatchObject({ activeLocations: 4, published: 3, failed: 1 });
    expect(record.calls).toEqual([
      `fetch:${bristolId}`,
      ...effectsFor(dublinId),
      ...effectsFor(manchesterId),
      ...effectsFor(edinburghId),
    ]);
  });

  it('rate-limited, malformed, and unreachable locations are reported as distinct outcomes', async () => {
    // The client draws these distinctions because the response to each differs —
    // back off, alert, or wait for the next cycle. Collapsing them into one
    // "fetch failed" here would throw that away at the only place it is logged.
    const record = emptyRecord();

    const report = await runCycle(
      cycleDeps({
        sites: activeFleet,
        scripts: {
          [bristolId]: { fetch: 'rate-limited' },
          [dublinId]: { fetch: 'malformed' },
          [manchesterId]: { fetch: 'unreachable' },
        },
        record,
      }),
    );

    expect(report.locations).toEqual([
      { locationId: bristolId, status: 'rate-limited' },
      { locationId: dublinId, status: 'malformed', detail: malformedDetail },
      { locationId: manchesterId, status: 'unreachable', detail: unreachableDetail },
      publishedOutcome(edinburghId),
    ]);
    expect(report).toMatchObject({ activeLocations: 4, published: 1, failed: 3 });
    expect(record.calls).toEqual([
      `fetch:${bristolId}`,
      `fetch:${dublinId}`,
      `fetch:${manchesterId}`,
      ...effectsFor(edinburghId),
    ]);
  });

  it('a partial batch write is reported and its location is not published', async () => {
    // BatchWriteItem answers 200 while handing back what it declined (ADR 0002
    // Consequence 4), so a partial store is a location whose readings are not in
    // the table — announcing them would be a message the consumer cannot honour.
    const record = emptyRecord();

    const report = await runCycle(
      cycleDeps({ sites: activeFleet, scripts: { [dublinId]: { store: 'partial' } }, record }),
    );

    expect(report.locations).toEqual([
      publishedOutcome(bristolId),
      { locationId: dublinId, status: 'store-partial', unprocessedCount: unprocessedOnPartial },
      publishedOutcome(manchesterId),
      publishedOutcome(edinburghId),
    ]);
    expect(report).toMatchObject({ activeLocations: 4, published: 3, failed: 1 });
    expect(record.calls).toContain(`store:${dublinId}`);
    expect(record.calls).not.toContain(`publish:${dublinId}`);
  });

  it('a throw from any one location fails only that location', async () => {
    // The isolation the whole per-location catch exists for: three different
    // effects blow up in three different locations, and the fourth still ships.
    const record = emptyRecord();

    const report = await runCycle(
      cycleDeps({
        sites: activeFleet,
        scripts: {
          [bristolId]: { fetch: 'throws' },
          [dublinId]: { store: 'throws' },
          [manchesterId]: { publish: 'throws' },
        },
        record,
      }),
    );

    expect(report.locations).toEqual([
      {
        locationId: bristolId,
        status: 'failed',
        detail: `fetchForecast threw — Error: fetch exploded for ${bristolId}`,
      },
      {
        locationId: dublinId,
        status: 'failed',
        detail: `putForecastWeather threw — Error: DynamoDB exploded for ${dublinId}`,
      },
      {
        locationId: manchesterId,
        status: 'failed',
        detail: `publishLocationReadings threw — Error: the queue exploded for ${manchesterId}`,
      },
      publishedOutcome(edinburghId),
    ]);
    expect(report).toMatchObject({ activeLocations: 4, published: 1, failed: 3 });
    expect(record.calls).toEqual([
      `fetch:${bristolId}`,
      `fetch:${dublinId}`,
      `store:${dublinId}`,
      `fetch:${manchesterId}`,
      `store:${manchesterId}`,
      `publish:${manchesterId}`,
      ...effectsFor(edinburghId),
    ]);
  });

  it('a fleet listing that fails is not reported as an empty cycle', async () => {
    // Rule 1: this one is not a per-location outcome. A cycle that never learned
    // what to fetch must fail the invocation, not resolve with zero locations —
    // which would look identical to a fleet with nothing active.
    const record = emptyRecord();
    const deps: RunCycleDeps = {
      ...cycleDeps({ sites: activeFleet, record }),
      sites: { listFleetSites: () => Promise.reject(new Error('cumulo-sites is unreachable')) },
    };

    await expect(runCycle(deps)).rejects.toThrow('cumulo-sites is unreachable');
    expect(record.calls).toEqual([]);
  });
});
