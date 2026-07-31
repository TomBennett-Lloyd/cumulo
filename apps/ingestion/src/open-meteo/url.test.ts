import { describe, expect, it } from 'vitest';

import {
  buildForecastUrl,
  forecastHours,
  hourlyVariables,
  openMeteoForecastEndpoint,
  type ForecastLocation,
} from './url';

/** Dublin, rounded to the 2 dp bucket ADR 0002 keys weather by. */
const dublin = { latitude: 53.35, longitude: -6.26 };

const paramsFor = (location: ForecastLocation): URLSearchParams =>
  new URL(buildForecastUrl(location)).searchParams;

describe('buildForecastUrl', () => {
  it('pins wind_speed_unit=ms in the request URL', () => {
    // Open-Meteo defaults to km/h, and km/h values sail through weatherReadingSchema's
    // 120 m/s cap — nothing downstream can catch the ~3.6x error, so this is the defence.
    expect(paramsFor(dublin).get('wind_speed_unit')).toBe('ms');
  });

  it('requests hours in UTC so normalization is an append rather than a conversion', () => {
    expect(paramsFor(dublin).get('timezone')).toBe('UTC');
  });

  it('targets the Open-Meteo forecast endpoint', () => {
    const url = new URL(buildForecastUrl(dublin));
    expect(`${url.origin}${url.pathname}`).toBe(openMeteoForecastEndpoint);
  });

  it('carries the requested coordinates verbatim, including a negative longitude', () => {
    const params = paramsFor(dublin);
    expect(params.get('latitude')).toBe('53.35');
    expect(params.get('longitude')).toBe('-6.26');
  });

  it('requests exactly the hourly variables a weather reading is built from', () => {
    expect(paramsFor(dublin).get('hourly')?.split(',')).toEqual([...hourlyVariables]);
  });

  it('asks for the horizon the product uses instead of the seven-day default', () => {
    expect(paramsFor(dublin).get('forecast_hours')).toBe(String(forecastHours));
    expect(forecastHours).toBe(48);
  });
});
