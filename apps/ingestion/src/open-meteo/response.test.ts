import { weatherReadingSchema } from '@cumulo/shared';
import { describe, expect, it } from 'vitest';

import fixture from './fixtures/dublin-forecast.json';
import { parseForecastResponse, type ForecastWeatherReading } from './response';
import type { HourlyVariable } from './url';

/**
 * `fixtures/dublin-forecast.json` is a real 48-hour Open-Meteo response, captured
 * once with the exact URL `buildForecastUrl` produces (testing.md rule 3: adapters
 * are tested against recorded provider responses, never against a mock). No test
 * here touches the network.
 *
 * `dublin` is the location that response was *requested* for — the 2 dp bucket ADR
 * 0002 keys weather by, deliberately different from the coordinates the fixture
 * echoes back.
 */
const dublin = { latitude: 53.35, longitude: -6.26 };

/** Editable copy of the fixture: hourly columns widened so a test can punch holes in them. */
interface ForecastBody {
  hourly: { time: string[] } & Record<HourlyVariable, (number | null)[]>;
}

const capturedBody = (): ForecastBody => structuredClone(fixture);

/** The fixture's parsed readings, or a failure naming why the parse refused them. */
interface ParsedFixture {
  readings: ForecastWeatherReading[];
  droppedHours: number;
}

const parseFixture = (body: unknown = capturedBody()): ParsedFixture => {
  const result = parseForecastResponse(dublin, body);
  if (!result.ok) {
    return expect.fail(`expected a parsed forecast, got malformed: ${result.detail}`);
  }
  return { readings: result.readings, droppedHours: result.droppedHours };
};

describe('parseForecastResponse', () => {
  it('carries requested coordinates, not the grid-snapped response coordinates', () => {
    // Open-Meteo answers a request with the centre of the model grid cell it snapped
    // to; the fixture's 53.34692/-6.2677307 rounds to a different locationId bucket
    // than the 53.35/-6.26 the fleet stores and queries under.
    expect(fixture.latitude).not.toBe(dublin.latitude);
    expect(fixture.longitude).not.toBe(dublin.longitude);

    const { readings } = parseFixture();
    expect(readings.every((reading) => reading.latitude === dublin.latitude)).toBe(true);
    expect(readings.every((reading) => reading.longitude === dublin.longitude)).toBe(true);
  });

  it('every normalized reading parses against weatherReadingSchema', () => {
    const { readings } = parseFixture();
    expect(readings).toHaveLength(fixture.hourly.time.length);
    for (const reading of readings) {
      expect(weatherReadingSchema.safeParse(reading).success).toBe(true);
    }
  });

  it('normalizes designator-less local hours to fixed-width UTC timestamps', () => {
    const { readings } = parseFixture();
    expect(readings.map((reading) => reading.validTime)).toEqual(
      fixture.hourly.time.map((hour) => `${hour}:00Z`),
    );
  });

  it('renames each hourly column onto its unit-suffixed reading field', () => {
    const { readings } = parseFixture();
    const column = (pick: (reading: ForecastWeatherReading) => number): number[] =>
      readings.map(pick);

    expect(column((reading) => reading.shortwaveRadiationWm2)).toEqual(
      fixture.hourly.shortwave_radiation,
    );
    expect(column((reading) => reading.directRadiationWm2)).toEqual(
      fixture.hourly.direct_radiation,
    );
    expect(column((reading) => reading.diffuseRadiationWm2)).toEqual(
      fixture.hourly.diffuse_radiation,
    );
    expect(column((reading) => reading.directNormalIrradianceWm2)).toEqual(
      fixture.hourly.direct_normal_irradiance,
    );
    expect(column((reading) => reading.temperature2mC)).toEqual(fixture.hourly.temperature_2m);
    expect(column((reading) => reading.windSpeed10mMs)).toEqual(fixture.hourly.wind_speed_10m);
    expect(column((reading) => reading.cloudCoverPct)).toEqual(fixture.hourly.cloud_cover);
  });

  it('stamps every reading as a forecast from open-meteo', () => {
    const { readings } = parseFixture();
    // Re-parsed through the shared schema so the assertion tests the value that
    // would be stored, not the literal type the compiler already knows.
    const stored = readings.map((reading) => weatherReadingSchema.parse(reading));
    expect(new Set(stored.map((reading) => reading.kind))).toEqual(new Set(['forecast']));
    expect(new Set(stored.map((reading) => reading.source))).toEqual(new Set(['open-meteo']));
  });

  it('drops hours with null variables and reports the count', () => {
    const body = capturedBody();
    body.hourly.cloud_cover[3] = null;
    body.hourly.temperature_2m[10] = null;
    const droppedTimes = [fixture.hourly.time[3], fixture.hourly.time[10]];

    const { readings, droppedHours } = parseFixture(body);

    expect(droppedHours).toBe(2);
    expect(readings).toHaveLength(fixture.hourly.time.length - 2);
    const kept = readings.map((reading) => String(reading.validTime));
    for (const dropped of droppedTimes) {
      expect(kept).not.toContain(`${String(dropped)}:00Z`);
    }
  });

  it('returns malformed when every hour is dropped', () => {
    const body = capturedBody();
    body.hourly.wind_speed_10m = body.hourly.wind_speed_10m.map(() => null);

    const result = parseForecastResponse(dublin, body);

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.detail).toContain('48 dropped');
  });

  it('returns malformed when a body is not a forecast response at all', () => {
    const result = parseForecastResponse(dublin, { error: true, reason: 'No data available' });

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.detail).toContain('hourly');
  });

  it('returns malformed when an hourly column is shorter than the time column', () => {
    // A short column would shift every later hour's values onto the wrong timestamp.
    const body = capturedBody();
    body.hourly.direct_radiation = body.hourly.direct_radiation.slice(0, -1);

    expect(parseForecastResponse(dublin, body).ok).toBe(false);
  });

  it('returns malformed when a time is not the expected local-hour format', () => {
    const body = capturedBody();
    body.hourly.time[2] = '2026-07-31T11:00:00Z';

    const result = parseForecastResponse(dublin, body);

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.detail).toContain('hourly.time[2]');
  });

  it('returns malformed when a value is outside the domain bounds, not silently stored', () => {
    // The signature of a changed unit: km/h wind arriving where m/s is expected is
    // invisible, but an irradiance in the thousands is not — refuse the whole body.
    const body = capturedBody();
    body.hourly.shortwave_radiation[5] = 9_999;

    const result = parseForecastResponse(dublin, body);

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.detail).toContain('shortwaveRadiationWm2');
  });
});
