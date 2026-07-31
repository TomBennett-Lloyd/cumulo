import { fleetSiteSchema, locationId, weatherReadingSchema } from '@cumulo/shared';
import type { FleetSite, WeatherReading } from '@cumulo/shared';
import type { SiteAdapter, WeatherAdapter } from '@cumulo/storage';
import { z } from 'zod';

import type { RunCycleDeps } from './cycle';
import type { ForecastWeatherReading } from './open-meteo/response';
import type { ForecastLocation } from './open-meteo/url';
import type { WeatherPublisher } from './publisher/weather-publisher';

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
export const bristol: ForecastLocation = { latitude: 51.45, longitude: -2.59 };
export const dublin: ForecastLocation = { latitude: 53.35, longitude: -6.26 };
export const manchester: ForecastLocation = { latitude: 53.48, longitude: -2.24 };
export const edinburgh: ForecastLocation = { latitude: 55.95, longitude: -3.19 };

export const bristolId = locationId(bristol);
export const dublinId = locationId(dublin);
export const manchesterId = locationId(manchester);
export const edinburghId = locationId(edinburgh);

export const readingsPerLocation = 2;
export const droppedHoursPerFetch = 1;
export const unprocessedOnPartial = 3;
export const malformedDetail = 'hourly columns have different lengths than hourly.time';
export const unreachableDetail = '2 attempts failed; last: TypeError: fetch failed';

export interface TestSiteInput {
  readonly index: number;
  readonly location: ForecastLocation;
  readonly active: boolean;
}

/**
 * Parsed rather than cast: a fixture that could not survive `fleetSiteSchema` is a
 * fixture describing a site the control plane cannot hold, and would prove nothing
 * about a cycle that reads real ones.
 */
export const siteAt = (input: TestSiteInput): FleetSite =>
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
export const fleetLocations: readonly ForecastLocation[] = [
  bristol,
  dublin,
  dublin,
  manchester,
  edinburgh,
];

export const fleetOf = (active: boolean): FleetSite[] =>
  fleetLocations.map((location, index) => siteAt({ index, location, active }));

export const activeFleet = fleetOf(true);
export const inactiveFleet = fleetOf(false);

/** `weatherReadingSchema` with the `kind` axis fixed, mirroring what the parser emits. */
export const forecastReadingSchema = weatherReadingSchema.extend({ kind: z.literal('forecast') });

export const readingsFor = (location: ForecastLocation): ForecastWeatherReading[] =>
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
export const locationIdOfBatch = (readings: readonly WeatherReading[]): string => {
  const [first] = readings;
  if (first === undefined) {
    throw new Error('the cycle passed on an empty batch of readings');
  }
  return locationId(first);
};

export type LogEntry = Record<string, unknown>;

/** Everything the cycle did, in order, and everything it said about it. */
export interface CycleRecord {
  readonly calls: string[];
  readonly entries: LogEntry[];
}

export const emptyRecord = (): CycleRecord => ({ calls: [], entries: [] });

export type FetchBehaviour = 'ok' | 'rate-limited' | 'malformed' | 'unreachable' | 'throws';
export type StoreBehaviour = 'complete' | 'partial' | 'throws';
export type PublishBehaviour = 'ok' | 'throws';

/** How one location's three effects behave. Anything unstated succeeds. */
export interface LocationScript {
  readonly fetch?: FetchBehaviour;
  readonly store?: StoreBehaviour;
  readonly publish?: PublishBehaviour;
}

export interface CycleDepsInput {
  readonly sites: readonly FleetSite[];
  readonly scripts?: Readonly<Record<string, LocationScript>>;
  readonly record: CycleRecord;
}

export const everythingSucceeds: LocationScript = {};

export const scriptFor = (input: CycleDepsInput, id: string): LocationScript =>
  input.scripts?.[id] ?? everythingSucceeds;

export const sitesDouble = (input: CycleDepsInput): Pick<SiteAdapter, 'listFleetSites'> => ({
  listFleetSites: () => Promise.resolve([...input.sites]),
});

export const fetchForecastDouble =
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

export const weatherDouble = (
  input: CycleDepsInput,
): Pick<WeatherAdapter, 'putForecastWeather'> => ({
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

export const publisherDouble = (input: CycleDepsInput): WeatherPublisher => ({
  publishLocationReadings: (readings) => {
    const id = locationIdOfBatch(readings);
    input.record.calls.push(`publish:${id}`);

    return scriptFor(input, id).publish === 'throws'
      ? Promise.reject(new Error(`the queue exploded for ${id}`))
      : Promise.resolve();
  },
});

export const cycleDeps = (input: CycleDepsInput): RunCycleDeps => ({
  sites: sitesDouble(input),
  weather: weatherDouble(input),
  publisher: publisherDouble(input),
  fetchForecast: fetchForecastDouble(input),
  log: (entry) => {
    input.record.entries.push(entry);
  },
});

export const publishedOutcome = (id: string): LogEntry => ({
  locationId: id,
  status: 'published',
  readingCount: readingsPerLocation,
  droppedHours: droppedHoursPerFetch,
});

export const effectsFor = (id: string): string[] => [`fetch:${id}`, `store:${id}`, `publish:${id}`];
