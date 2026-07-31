import {
  forecastWeatherReadingSchema,
  type ForecastWeatherReading,
  type WeatherReading,
} from '@cumulo/shared';
import { z } from 'zod';

import { describeZodIssues } from '../zod-issue-detail';
import type { ForecastLocation, HourlyVariable } from './url';

/**
 * Parsing and normalization of an Open-Meteo forecast response.
 *
 * Pure: takes an already-fetched body as `unknown` and returns either readings or
 * a typed failure. Nothing here performs I/O, so every wire-format hazard the
 * provider hands us is exercised against a captured fixture rather than the network.
 */

const nullableNumbers = z.array(z.number().nullable());

/**
 * One schema per requested hourly variable. Typing this as a `Record` keyed by
 * `HourlyVariable` is what keeps request and response in step: adding a variable
 * to `hourlyVariables` without adding it here (or vice versa) is a compile error,
 * not a field that silently arrives unparsed.
 */
const hourlyVariableSchemas: Record<HourlyVariable, typeof nullableNumbers> = {
  shortwave_radiation: nullableNumbers,
  direct_radiation: nullableNumbers,
  diffuse_radiation: nullableNumbers,
  direct_normal_irradiance: nullableNumbers,
  temperature_2m: nullableNumbers,
  wind_speed_10m: nullableNumbers,
  cloud_cover: nullableNumbers,
};

/**
 * Open-Meteo returns hourly data column-wise: one `time` array plus one array per
 * variable, aligned by index. That alignment is the entire contract — a short
 * column would silently shift every later hour's values onto the wrong timestamp —
 * so equal lengths are checked at the boundary rather than assumed downstream.
 */
const hourlySchema = z
  .object({
    time: z.array(z.string()),
    ...hourlyVariableSchemas,
  })
  .refine(
    (hourly) => Object.values(hourly).every((column) => column.length === hourly.time.length),
    { message: 'hourly columns have different lengths than hourly.time' },
  );

export const openMeteoForecastResponseSchema = z.object({
  hourly: hourlySchema,
});

export type OpenMeteoForecastResponse = z.infer<typeof openMeteoForecastResponseSchema>;

/** The reading fields that come from an hourly column, as opposed to the request. */
type HourlyReadingValues = Pick<
  WeatherReading,
  | 'shortwaveRadiationWm2'
  | 'directRadiationWm2'
  | 'diffuseRadiationWm2'
  | 'directNormalIrradianceWm2'
  | 'temperature2mC'
  | 'windSpeed10mMs'
  | 'cloudCoverPct'
>;

/**
 * The same fields as they arrive: `null` where Open-Meteo has no value for the
 * hour, and `undefined` for an index past the end of a column — unreachable while
 * `hourlySchema`'s equal-length check holds, and handled identically anyway so the
 * code never depends on that being true.
 */
type ReceivedHourlyValues = { [K in keyof HourlyReadingValues]: number | null | undefined };

export type ParsedForecast =
  | { ok: true; readings: ForecastWeatherReading[]; droppedHours: number }
  | { ok: false; reason: 'malformed'; detail: string };

/**
 * Open-Meteo's designator-less local hour, e.g. `2026-07-31T09:00`. With
 * `timezone=UTC` requested (see `buildForecastUrl`) these are UTC instants, so
 * normalizing to the shared schema's fixed-width form is an append, not a
 * conversion.
 */
const openMeteoHourPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

const malformed = (detail: string): ParsedForecast => ({ ok: false, reason: 'malformed', detail });

const hasEveryValue = (values: ReceivedHourlyValues): values is HourlyReadingValues =>
  Object.values(values).every((value) => value !== null && value !== undefined);

/**
 * Turn a forecast response body into `WeatherReading`s for `location`.
 *
 * Failure policy (error-handling.md rule 1): a response we cannot trust is an
 * expected outcome of calling a third party, so it comes back as a value the
 * caller must handle, never a throw. Two failure shapes collapse into `malformed`
 * because the caller's action is the same for both — do not store, report loudly:
 * a body that does not match the wire schema, and a body whose hours are all
 * unusable (every hour dropped, or a reading outside the domain's physical
 * bounds, which is the signature of a changed unit rather than of missing data).
 *
 * Hours with a missing value are dropped and counted instead, because a
 * genuinely partial forecast is normal — Open-Meteo pads the horizon with `null`
 * rather than shortening it — and `droppedHours` is what lets the caller report
 * partial coverage honestly (rule 5) instead of implying a full 48 hours.
 */
export const parseForecastResponse = (
  location: ForecastLocation,
  body: unknown,
): ParsedForecast => {
  const response = openMeteoForecastResponseSchema.safeParse(body);
  if (!response.success) {
    return malformed(describeZodIssues(response.error));
  }

  const { hourly } = response.data;
  const readings: ForecastWeatherReading[] = [];
  let droppedHours = 0;

  for (const [index, hour] of hourly.time.entries()) {
    if (!openMeteoHourPattern.test(hour)) {
      return malformed(`hourly.time[${String(index)}]: expected YYYY-MM-DDTHH:mm, got "${hour}"`);
    }

    const received: ReceivedHourlyValues = {
      shortwaveRadiationWm2: hourly.shortwave_radiation[index],
      directRadiationWm2: hourly.direct_radiation[index],
      diffuseRadiationWm2: hourly.diffuse_radiation[index],
      directNormalIrradianceWm2: hourly.direct_normal_irradiance[index],
      temperature2mC: hourly.temperature_2m[index],
      windSpeed10mMs: hourly.wind_speed_10m[index],
      cloudCoverPct: hourly.cloud_cover[index],
    };
    if (!hasEveryValue(received)) {
      droppedHours += 1;
      continue;
    }

    const reading = forecastWeatherReadingSchema.safeParse({
      // The requested coordinates, never `response.latitude`/`response.longitude`:
      // Open-Meteo echoes the centre of the model grid cell it snapped to, which is
      // a different `locationId` from the one the fleet stores and queries under.
      // Storing the echoed pair would file every reading where nothing looks for it.
      latitude: location.latitude,
      longitude: location.longitude,
      validTime: `${hour}:00Z`,
      kind: 'forecast',
      source: 'open-meteo',
      ...received,
    });
    if (!reading.success) {
      return malformed(`hour ${hour} — ${describeZodIssues(reading.error)}`);
    }
    readings.push(reading.data);
  }

  if (readings.length === 0) {
    return malformed(`every hour was unusable (${String(droppedHours)} dropped)`);
  }

  return { ok: true, readings, droppedHours };
};
