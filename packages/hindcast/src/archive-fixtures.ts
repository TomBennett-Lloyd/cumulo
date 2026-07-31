import {
  locationId,
  utcIsoTimestampSchema,
  type ArchiveWeatherReading,
  type GeoCoordinates,
  type UtcIsoTimestamp,
  type WeatherReading,
} from '@cumulo/shared';

import type { ArchiveDayCoverage } from './archive-cache';
import type { UtcDay } from './archive-days';
import type { HindcastWeatherStore } from './hindcast';

/**
 * What an archive day looks like, and where a test puts one.
 *
 * Shared by `archive-cache.test.ts` and `hindcast.test.ts` because they stand in
 * for the *same* real collaborator — `@cumulo/storage`'s `WeatherAdapter` — and a
 * change to that contract has to reach both at once. Two fakes of one adapter is
 * the duplication `docs/standards/structure.md` rule 7 asks about by its own
 * test: if one copy changed, the other would be wrong until it changed the same
 * way.
 *
 * What the two suites do *not* share stays with them: the coverage tests script
 * a fixed list of provider answers, while the hindcast tests generate days
 * against a call budget. Those are different intents, and forcing them into one
 * stub behind a mode flag is what rule 7 warns against.
 *
 * The store implements the ports for real rather than recording calls: it
 * refuses a marker with no readings, refuses readings dated to another day —
 * exactly as `putArchiveDay` does — and honours the half-open read window
 * exactly as `queryArchiveRange`'s `BETWEEN` does. A mock asserted for its own
 * sake would prove nothing (`docs/standards/testing.md` rule 3).
 */

export const DUBLIN: GeoCoordinates = { latitude: 53.35, longitude: -6.26 };

export const HOURS_PER_DAY = 24;

const MS_PER_DAY = 86_400_000;

const stamp = (value: string): UtcIsoTimestamp => utcIsoTimestampSchema.parse(value);

/** A crude but strictly positive daylight curve: zero before 05:00 and from 19:00. */
export const daylight = (hour: number): number =>
  Math.max(0, Math.sin(((hour - 5) / 14) * Math.PI));

export const hourOf = (day: UtcDay, hour: number): UtcIsoTimestamp =>
  stamp(`${day}T${String(hour).padStart(2, '0')}:00:00Z`);

/**
 * One hour of archive weather on a diurnal curve.
 *
 * Values vary by hour rather than sitting flat, because the hindcast replays
 * these through the real physics chain and a constant irradiance would make
 * every scored hour identical — hiding any alignment bug behind a series that
 * cannot disagree with itself. The coverage tests assert only on counts, so the
 * curve costs them nothing.
 *
 * Timestamps are parsed, never cast: `validTime` is a branded UTC stamp, and a
 * fixture has to earn the brand the same way the response parser does.
 */
const archiveHour = (day: UtcDay, hour: number): ArchiveWeatherReading => {
  const sun = daylight(hour);
  return {
    ...DUBLIN,
    validTime: hourOf(day, hour),
    kind: 'archive',
    source: 'open-meteo',
    shortwaveRadiationWm2: 700 * sun,
    directRadiationWm2: 500 * sun,
    diffuseRadiationWm2: 200 * sun,
    directNormalIrradianceWm2: 800 * sun,
    temperature2mC: 15,
    windSpeed10mMs: 4,
    cloudCoverPct: 40,
  };
};

/** The 24 hour-ending readings of one whole day, as the parser would hand them over. */
export const wholeDay = (day: UtcDay): ArchiveWeatherReading[] =>
  Array.from({ length: HOURS_PER_DAY }, (_, hour) => archiveHour(day, hour));

export const consecutiveDays = (firstDay: UtcDay, count: number): UtcDay[] => {
  const startMs = Date.parse(`${firstDay}T00:00:00Z`);
  return Array.from({ length: count }, (_, offset) =>
    new Date(startMs + offset * MS_PER_DAY).toISOString().slice(0, 10),
  );
};

/** The closed range a `DayRun` names, as the list of days it covers. */
export const daysBetween = (firstDay: UtcDay, lastDay: UtcDay): UtcDay[] =>
  consecutiveDays(
    firstDay,
    (Date.parse(`${lastDay}T00:00:00Z`) - Date.parse(`${firstDay}T00:00:00Z`)) / MS_PER_DAY + 1,
  );

const dayKey = (partition: string, day: UtcDay): string => `${partition}#${day}`;

export interface StoreOptions {
  /** Days the store answers `undetermined` for, as DynamoDB declining a key would. */
  readonly undeterminedDays?: readonly UtcDay[];
}

export class InMemoryArchiveStore implements HindcastWeatherStore {
  private readonly markedDays = new Map<string, readonly ArchiveWeatherReading[]>();
  private readonly undeterminedDays: ReadonlySet<UtcDay>;

  constructor(options: StoreOptions = {}) {
    this.undeterminedDays = new Set(options.undeterminedDays ?? []);
  }

  listFetchedArchiveDays(
    coords: GeoCoordinates,
    days: readonly UtcDay[],
  ): Promise<ArchiveDayCoverage> {
    const partition = locationId(coords);
    const undetermined = days.filter((day) => this.undeterminedDays.has(day));
    const fetched = new Set(
      days.filter(
        (day) => this.markedDays.has(dayKey(partition, day)) && !this.undeterminedDays.has(day),
      ),
    );
    return Promise.resolve(
      undetermined.length === 0
        ? { status: 'complete', fetched }
        : { status: 'incomplete', fetched, undeterminedDays: undetermined },
    );
  }

  putArchiveDay(day: UtcDay, readings: readonly ArchiveWeatherReading[]): Promise<void> {
    const [first] = readings;
    if (first === undefined) {
      return Promise.reject(new Error(`refusing to mark ${day} with no readings`));
    }
    const misdated = readings.find((reading) => !reading.validTime.startsWith(`${day}T`));
    if (misdated !== undefined) {
      return Promise.reject(new Error(`${day} was given a reading at ${misdated.validTime}`));
    }
    this.markedDays.set(dayKey(locationId(first), day), readings);
    return Promise.resolve();
  }

  queryArchiveRange(
    coords: GeoCoordinates,
    fromInclusive: UtcIsoTimestamp,
    toExclusive: UtcIsoTimestamp,
  ): Promise<WeatherReading[]> {
    const prefix = `${locationId(coords)}#`;
    const readings = [...this.markedDays]
      .filter(([key]) => key.startsWith(prefix))
      .flatMap(([, day]) => day)
      .filter((reading) => reading.validTime >= fromInclusive && reading.validTime < toExclusive);
    return Promise.resolve(readings);
  }

  /**
   * Hours stored under a day's marker — `0` when the day carries no marker at
   * all. One accessor rather than a separate `hasMarker`, because marker and
   * readings land together: "is it marked?" and "is the whole day there?" are
   * the same question, and asking it as a count catches a marker vouching for a
   * partial day.
   */
  storedHours(coords: GeoCoordinates, day: UtcDay): number {
    return this.markedDays.get(dayKey(locationId(coords), day))?.length ?? 0;
  }
}
