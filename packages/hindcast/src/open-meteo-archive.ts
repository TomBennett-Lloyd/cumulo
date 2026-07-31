import {
  archiveWeatherReadingSchema,
  locationId,
  type ArchiveWeatherReading,
  type GeoCoordinates,
  type WeatherReading,
} from '@cumulo/shared';
import { z } from 'zod';

import type { UtcDay } from './archive-days';

/**
 * The Open-Meteo **archive** (ERA5) adapter: the one module in `@cumulo/hindcast`
 * allowed to touch the network (`docs/standards/architecture.md` rule 3).
 *
 * Everything below the fetch is pure — request construction and
 * {@link parseArchiveResponse} are functions of their arguments — so every
 * wire-format hazard is exercised against a captured fixture and no test in this
 * package needs the network (`docs/standards/testing.md` rule 3).
 *
 * Ingestion's forecast adapter (`apps/ingestion/src/open-meteo/`, #11) parses a
 * near-identical body, and this module deliberately does not share code with it.
 * Two reasons, in order: a package may not import from an app
 * (`docs/standards/architecture.md` rule 1), and the two have different intent —
 * ingestion drops individual unusable *hours* from a live horizon and reports a
 * count, while backfill's unit is a whole *day* that is either storable in full or
 * not storable at all. If one changed, the other would not be wrong
 * (`docs/standards/structure.md` rule 7). What is shared is shared where it
 * belongs: `archiveWeatherReadingSchema` (the `kind`-narrowed half of
 * `weatherReadingSchema`) and `locationId`, both in `@cumulo/shared`.
 *
 * Standalone functions over an explicit deps parameter, not a client object:
 * nothing here outlives a call, so each step is legible from its signature alone.
 */

export const ARCHIVE_BASE_URL = 'https://archive-api.open-meteo.com/v1/archive';

/**
 * The hourly variables requested, in request order. Names are Open-Meteo's own;
 * `weatherReadingSchema` carries the camel-cased, unit-suffixed counterpart of
 * each, so the mapping below is a rename a reviewer can check by eye.
 */
export const ARCHIVE_HOURLY_VARIABLES = [
  'temperature_2m',
  'wind_speed_10m',
  'cloud_cover',
  'shortwave_radiation',
  'direct_radiation',
  'diffuse_radiation',
  'direct_normal_irradiance',
] as const;

export type ArchiveHourlyVariable = (typeof ARCHIVE_HOURLY_VARIABLES)[number];

/**
 * Days covered by one archive HTTP request. Backfill asks for a contiguous *run*
 * of missing days (`contiguousDayRuns`), never one request per day — and that
 * difference is the whole frugality argument (CLAUDE.md's 10,000 calls/day):
 *
 * Open-Meteo weights a call by how much data it covers rather than counting every
 * request as one, so a long range is billed as several calls. Budgeting
 * conservatively at one weighted call per 7 days requested:
 * - **runs of 31**: two years for one site is 730 ÷ 31 ≈ 24 requests, each
 *   weighted ⌈31 / 7⌉ = 5 → ≈ 120 weighted calls per site. A 20-site demo fleet
 *   backfills in ≈ 2,400 — under a quarter of one day's allowance, leaving room
 *   for the hourly forecast cycle that shares the quota.
 * - **one request per day**: 730 requests per site, weighted 1 each → 14,600 for
 *   the same fleet, over the daily limit before a single forecast cycle has run.
 *
 * 31 rather than something larger because a month is the unit an operator reasons
 * about, and it bounds what a single failed request costs: at most one month of a
 * site's history has to be asked for again.
 */
export const MAX_ARCHIVE_REQUEST_DAYS = 31;

/**
 * Generous relative to Open-Meteo's typical sub-second response, because the cost
 * of a premature abort is a wasted call against a hard daily quota, while the cost
 * of waiting is a slower backfill. Longer than ingestion's live-cycle deadline:
 * an archive request covering a month of hours is a genuinely bigger query than a
 * 48-hour forecast, and backfill has no hourly cycle to miss.
 */
export const ARCHIVE_TIMEOUT_MS = 30_000;

const HOURS_PER_DAY = 24;

/** Longest provider text carried in a `reason`; an HTML error page must not flood the logs. */
const MAX_REASON_LENGTH = 200;

/**
 * Open-Meteo's designator-less hour, e.g. `2026-06-01T00:00`, as it appears in
 * `hourly.time`.
 */
const ARCHIVE_HOUR_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/**
 * The whole of this package's timestamp normalization: append `:00Z` to
 * Open-Meteo's designator-less stamp to get `weatherReadingSchema`'s fixed-width
 * UTC form. No hour is added or subtracted, and that zero shift is a decision,
 * not an omission:
 *
 * - Open-Meteo stamps its hourly radiation variables as the mean over the
 *   **preceding** hour — the reason it offers separate `*_instant` variants at all
 *   is that the defaults are not instantaneous. That is precisely the hour-*ending*
 *   convention `weatherReadingSchema` documents in
 *   `packages/shared/src/weather-reading.ts`, so the provider's label and the
 *   domain's label already denote the same instant.
 * - Ingestion (#11) ships that same reading: `parseForecastResponse` in
 *   `apps/ingestion/src/open-meteo/response.ts` normalizes with the identical bare
 *   append. Archive and forecast readings land in the same `cumulo-weather`
 *   partition and are compared hour-for-hour by the hindcast this package exists
 *   for, so a shift applied here and not there would not fail loudly — it would
 *   quietly bias every accuracy metric by one hour.
 *
 * The zero shift is also why the raw request never needs widening at a day edge:
 * the hours Open-Meteo returns for `start_date..end_date` are exactly the hours
 * whose `validTime` falls on those days, so each requested day arrives whole.
 */
const UTC_HOUR_SUFFIX = ':00Z';

const nullableNumbers = z.array(z.number().nullable());

/**
 * One schema per requested hourly variable. Typing this as a `Record` keyed by
 * `ArchiveHourlyVariable` is what keeps request and response in step: adding a
 * variable to {@link ARCHIVE_HOURLY_VARIABLES} without adding it here (or vice
 * versa) is a compile error, not a column that silently arrives unparsed.
 */
const hourlyVariableSchemas: Record<ArchiveHourlyVariable, typeof nullableNumbers> = {
  temperature_2m: nullableNumbers,
  wind_speed_10m: nullableNumbers,
  cloud_cover: nullableNumbers,
  shortwave_radiation: nullableNumbers,
  direct_radiation: nullableNumbers,
  diffuse_radiation: nullableNumbers,
  direct_normal_irradiance: nullableNumbers,
};

/**
 * Open-Meteo returns hourly data column-wise: one `time` array plus one array per
 * variable, aligned by index. That alignment is the entire contract — a short
 * column would shift every later hour's values onto the wrong timestamp — so
 * equal lengths are checked at the boundary rather than assumed downstream.
 */
const hourlySchema = z
  .object({ time: z.array(z.string()), ...hourlyVariableSchemas })
  .refine(
    (hourly) => Object.values(hourly).every((column) => column.length === hourly.time.length),
    {
      message: 'hourly columns have different lengths than hourly.time',
    },
  );

export const archiveResponseSchema = z.object({ hourly: hourlySchema });

/** The reading fields that come from an hourly column, as opposed to from the request. */
type HourlyReadingValues = Pick<
  WeatherReading,
  | 'temperature2mC'
  | 'windSpeed10mMs'
  | 'cloudCoverPct'
  | 'shortwaveRadiationWm2'
  | 'directRadiationWm2'
  | 'diffuseRadiationWm2'
  | 'directNormalIrradianceWm2'
>;

/**
 * The same fields as they arrive: `null` where the reanalysis has no value for the
 * hour, and `undefined` for an index past the end of a column — unreachable while
 * {@link hourlySchema}'s equal-length check holds, and handled identically anyway
 * so nothing here depends on that being true.
 */
type ReceivedHourlyValues = { [K in keyof HourlyReadingValues]: number | null | undefined };

/**
 * Days that arrived whole, keyed by `YYYY-MM-DD`, plus the days that did not.
 *
 * A day is either complete — 24 readings, every variable present — or it is named
 * in `incompleteDays` and carries no readings at all. There is no third state and
 * no gap-filling: a fabricated value would be indistinguishable from measurement
 * in the accuracy metrics this package computes, which is exactly the corruption
 * `docs/standards/error-handling.md` rule 5 is about. Storage relies on the same
 * split — `putArchiveDay` writes a day's readings and its "this day is cached"
 * marker together, so a marker must never be written for a partial day.
 */
export interface ParsedArchiveDays {
  readonly completeDays: Map<UtcDay, ArchiveWeatherReading[]>;
  readonly incompleteDays: UtcDay[];
}

const hasEveryValue = (values: ReceivedHourlyValues): values is HourlyReadingValues =>
  Object.values(values).every((value) => value !== null && value !== undefined);

/**
 * Turn an archive response body into whole days of readings for `request`'s
 * coordinates.
 *
 * Failure policy: a body that does not match the wire schema, a `time` entry that
 * is not Open-Meteo's hour format, or a value outside `weatherReadingSchema`'s
 * physical bounds all **throw**. None of these is an expected outcome a backfill
 * caller could act on — each means the provider contract moved (a changed unit
 * looks exactly like an out-of-bounds value), and the only safe response is to
 * stop rather than to store something plausible. Missing data, by contrast, is
 * ordinary: it is reported as an incomplete day, never as an error and never as a
 * filled-in value (`docs/standards/error-handling.md` rule 1).
 *
 * Readings carry the **requested** coordinates, never the ones the response
 * echoes: Open-Meteo snaps a request to its model grid and reports the cell
 * centre, kilometres away, and ADR 0002 derives the `cumulo-weather` partition key
 * from the coordinates a reading carries. Storing the echoed pair would file every
 * reading under a `locationId` nothing ever queries — the cache would miss forever
 * and re-fetch the same days against a quota this project is built to respect.
 */
export const parseArchiveResponse = (
  payload: unknown,
  request: GeoCoordinates,
): ParsedArchiveDays => {
  const { hourly } = archiveResponseSchema.parse(payload);

  const readingsByDay = new Map<UtcDay, ArchiveWeatherReading[]>();
  const incompleteDays = new Set<UtcDay>();

  for (const [index, hour] of hourly.time.entries()) {
    if (!ARCHIVE_HOUR_PATTERN.test(hour)) {
      throw new Error(
        `hourly.time[${String(index)}]: expected YYYY-MM-DDTHH:mm, got ${JSON.stringify(hour)}`,
      );
    }
    const received: ReceivedHourlyValues = {
      temperature2mC: hourly.temperature_2m[index],
      windSpeed10mMs: hourly.wind_speed_10m[index],
      cloudCoverPct: hourly.cloud_cover[index],
      shortwaveRadiationWm2: hourly.shortwave_radiation[index],
      directRadiationWm2: hourly.direct_radiation[index],
      diffuseRadiationWm2: hourly.diffuse_radiation[index],
      directNormalIrradianceWm2: hourly.direct_normal_irradiance[index],
    };

    const validTime = `${hour}${UTC_HOUR_SUFFIX}`;
    // The UTC calendar day of the *normalized* stamp, which is what `putArchiveDay`
    // checks each reading against — bucketing on the raw stamp would only agree by
    // accident if the normalization ever gained a shift.
    const day = validTime.slice(0, 10);
    if (!hasEveryValue(received)) {
      incompleteDays.add(day);
      continue;
    }

    const reading = archiveWeatherReadingSchema.parse({
      latitude: request.latitude,
      longitude: request.longitude,
      validTime,
      kind: 'archive',
      source: 'open-meteo',
      ...received,
    });
    readingsByDay.set(day, [...(readingsByDay.get(day) ?? []), reading]);
  }

  const completeDays = new Map<UtcDay, ArchiveWeatherReading[]>();
  for (const [day, readings] of readingsByDay) {
    // A short day is incomplete even with no `null` in it: the window's edges can
    // land mid-day, and 20 stored hours under a "day cached" marker would be read
    // back forever as if it were the whole day.
    if (incompleteDays.has(day) || readings.length !== HOURS_PER_DAY) {
      incompleteDays.add(day);
      continue;
    }
    completeDays.set(day, readings);
  }

  return { completeDays, incompleteDays: [...incompleteDays].sort() };
};

/**
 * The parts of the request policy a caller may override. Both fields are optional
 * because production overrides neither — the defaults *are* the shipped policy —
 * and a test replaces exactly the piece that would otherwise reach the network.
 */
export interface ArchiveFetchDeps {
  /** Defaults to the global `fetch`; tests pass a stub so no test hits the network. */
  readonly fetchFn?: typeof fetch;
  /** Request deadline. Defaults to {@link ARCHIVE_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/**
 * Every way an archive fetch can end, as a value rather than a throw
 * (`docs/standards/error-handling.md` rule 1). Three cases because the caller's
 * action differs for each: `ok` stores the complete days and leaves the incomplete
 * ones un-marked so a later run retries them; `rate-limited` stops the backfill
 * until its next scheduled run; `rejected` means the request itself is wrong or
 * refused, so repeating it verbatim can only fail the same way.
 */
export type ArchiveFetchResult =
  | { status: 'ok'; completeDays: Map<UtcDay, ArchiveWeatherReading[]>; incompleteDays: UtcDay[] }
  | { status: 'rate-limited' }
  | { status: 'rejected'; httpStatus: number; reason: string };

/**
 * Build the archive request URL for one location and one closed day range.
 *
 * Three parameters are load-bearing rather than stylistic:
 * - `wind_speed_unit=ms` — Open-Meteo defaults to km/h, and ordinary wind speeds
 *   in km/h parse cleanly as m/s against `weatherReadingSchema`'s 120 m/s sanity
 *   cap. Nothing downstream can detect the resulting ~3.6× error in the Faiman
 *   cell-temperature term, so pinning the unit here *is* the defence, and the
 *   request test in `open-meteo-archive.test.ts` is what keeps it pinned.
 * - `timezone=UTC` — Open-Meteo returns designator-less local times; asking for
 *   UTC is what makes {@link UTC_HOUR_SUFFIX} an append rather than a silent
 *   offset bug.
 * - `start_date`/`end_date` — inclusive at both ends, which is why
 *   `archive-days.ts`'s `DayRun` is a closed range rather than a half-open one.
 */
const buildArchiveUrl = (coords: GeoCoordinates, firstDay: UtcDay, lastDay: UtcDay): string => {
  const url = new URL(ARCHIVE_BASE_URL);
  url.search = new URLSearchParams({
    latitude: String(coords.latitude),
    longitude: String(coords.longitude),
    hourly: ARCHIVE_HOURLY_VARIABLES.join(','),
    wind_speed_unit: 'ms',
    timezone: 'UTC',
    start_date: firstDay,
    end_date: lastDay,
  }).toString();
  return url.toString();
};

const truncate = (text: string): string =>
  text.length <= MAX_REASON_LENGTH ? text : `${text.slice(0, MAX_REASON_LENGTH)}…`;

/** Open-Meteo answers a rejected request with `{"error":true,"reason":…}`. */
const openMeteoErrorSchema = z.object({ error: z.literal(true), reason: z.string() });

/**
 * Whatever the provider put in a rejected request's body, as a log-safe string:
 * its `reason` when the body is the documented error envelope, the raw text when
 * it is anything else. Both are useful; guessing between them is not, so the shape
 * is parsed rather than assumed (`docs/standards/typing.md` rule 3).
 */
const describeRejection = async (response: Response): Promise<string> => {
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    // Not swallowed: the read failure *is* the description being returned.
    return `unreadable body — ${String(error)}`;
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return truncate(text);
  }

  const envelope = openMeteoErrorSchema.safeParse(body);
  return truncate(envelope.success ? envelope.data.reason : text);
};

/**
 * Fetch one contiguous run of archive days for one location.
 *
 * Failure policy, stated here at the call site rather than inherited from library
 * defaults (`docs/standards/error-handling.md` rule 3):
 * - every request carries an {@link ARCHIVE_TIMEOUT_MS} deadline via
 *   `AbortSignal.timeout`;
 * - HTTP 429 → `rate-limited` with **zero** retries, not even a delayed one. Hot-
 *   retrying a rate limit spends the very quota that is exhausted, and free-tier
 *   frugality is a hard constraint in CLAUDE.md. Backfill is not time-critical:
 *   the next scheduled run is the retry, and the day markers mean it resumes
 *   exactly where this one stopped;
 * - any other non-2xx → `rejected`, carrying the status and the provider's own
 *   reason so the operator sees why;
 * - a network failure, an aborted deadline or a body that is not JSON → **throws**
 *   with the location and day range attached (rule 2b: add context and rethrow).
 *   Unlike a 429 or a 400, these say nothing about whether the request was
 *   understood, so there is no honest value to return; the backfill boundary logs
 *   and stops.
 *
 * `deps` is a parameter rather than captured state: the resolved `fetch` and
 * deadline are configuration, not shared mutable state, so this stays a function
 * of its arguments alone (`docs/standards/structure.md` rules 1–2).
 */
export const fetchArchiveDays = async (
  deps: ArchiveFetchDeps,
  coords: GeoCoordinates,
  firstDay: UtcDay,
  lastDay: UtcDay,
): Promise<ArchiveFetchResult> => {
  const fetchFn = deps.fetchFn ?? fetch;
  const timeoutMs = deps.timeoutMs ?? ARCHIVE_TIMEOUT_MS;
  const context = `${locationId(coords)} ${firstDay}..${lastDay}`;

  let response: Response;
  try {
    response = await fetchFn(buildArchiveUrl(coords, firstDay, lastDay), {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`Open-Meteo archive request failed for ${context}`, { cause: error });
  }

  if (response.status === 429) {
    return { status: 'rate-limited' };
  }
  if (!response.ok) {
    return {
      status: 'rejected',
      httpStatus: response.status,
      reason: await describeRejection(response),
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new Error(`Open-Meteo archive body was not JSON for ${context}`, { cause: error });
  }

  const parsed = parseArchiveResponse(body, coords);
  return {
    status: 'ok',
    completeDays: parsed.completeDays,
    incompleteDays: parsed.incompleteDays,
  };
};
