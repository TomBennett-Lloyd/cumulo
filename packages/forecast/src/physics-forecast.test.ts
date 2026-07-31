import {
  forecastSchema,
  siteSchema,
  utcIsoTimestampSchema,
  weatherReadingSchema,
  type Site,
  type WeatherReading,
} from '@cumulo/shared';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { createPhysicsForecast, runPhysicsChain } from './physics-forecast';
import { solarPosition } from './solar-position';

/**
 * Fixtures are built by parsing through the shared schemas rather than by asserting an
 * object literal into shape: a fixture the real boundary would reject proves nothing,
 * and the branded `UtcIsoTimestamp` cannot be produced any other way.
 */
const baseSite: z.input<typeof siteSchema> = {
  id: '9a4c1f2e-6b73-4d58-8a10-2f5e7c9b0d31',
  name: 'Dublin rooftop',
  latitude: 53.3498,
  longitude: -6.2603,
  tiltDegrees: 35,
  azimuthDegrees: 180,
  capacityKw: 4,
};

const baseWeather: z.input<typeof weatherReadingSchema> = {
  latitude: 53.35,
  longitude: -6.26,
  validTime: '2026-06-21T12:00:00Z',
  kind: 'forecast',
  source: 'open-meteo',
  shortwaveRadiationWm2: 620,
  directRadiationWm2: 430,
  diffuseRadiationWm2: 190,
  directNormalIrradianceWm2: 780,
  temperature2mC: 16,
  windSpeed10mMs: 3,
  cloudCoverPct: 25,
};

const buildSite = (overrides: Partial<z.input<typeof siteSchema>> = {}): Site =>
  siteSchema.parse({ ...baseSite, ...overrides });

const buildWeather = (
  overrides: Partial<z.input<typeof weatherReadingSchema>> = {},
): WeatherReading => weatherReadingSchema.parse({ ...baseWeather, ...overrides });

const issuedAt = utcIsoTimestampSchema.parse('2026-06-21T06:00:00Z');

/** Half an hour in ms — the offset the chain applies to reach the hour's midpoint. */
const HALF_HOUR_MS = 1_800_000;

describe('createPhysicsForecast', () => {
  it('emits a schema-valid physics forecast carrying the site, hour, vintage and weather provenance', () => {
    const site = buildSite();
    const weather = buildWeather();

    const forecast = createPhysicsForecast({ site, weather, issuedAt });

    expect(forecastSchema.safeParse(forecast).success).toBe(true);
    expect(forecast.siteId).toBe(site.id);
    expect(forecast.model).toBe('physics');
    expect(forecast.validTime).toBe(weather.validTime);
    expect(forecast.issuedAt).toBe(issuedAt);
    expect(forecast.weatherSource).toBe(weather.source);
    expect(forecast.poaIrradianceWm2).toBeGreaterThan(0);
    expect(forecast.acPowerKw).toBeGreaterThan(0);
  });

  it('omits the uncertainty key entirely rather than setting it undefined', () => {
    // Physics v1 is a point estimate. Under `exactOptionalPropertyTypes` an absent key
    // and a key set to `undefined` are different values, and only the absent form
    // survives a JSON/DynamoDB round trip as "no band" instead of a null nobody meant.
    const forecast = createPhysicsForecast({
      site: buildSite(),
      weather: buildWeather(),
      issuedAt,
    });

    expect('uncertainty' in forecast).toBe(false);
  });

  it('reports exactly zero irradiance and zero power for a night hour', () => {
    // Exact zeros, not small numbers: a fleet total is a sum over thousands of these,
    // and a signed or drifting night-time zero would accumulate into visible drift.
    const forecast = createPhysicsForecast({
      site: buildSite(),
      weather: buildWeather({
        validTime: '2026-01-15T23:00:00Z',
        shortwaveRadiationWm2: 0,
        directRadiationWm2: 0,
        diffuseRadiationWm2: 0,
        directNormalIrradianceWm2: 0,
        temperature2mC: 4,
        windSpeed10mMs: 2,
        cloudCoverPct: 90,
      }),
      issuedAt,
    });

    expect(forecast.poaIrradianceWm2).toBe(0);
    expect(forecast.acPowerKw).toBe(0);
  });

  it('clips a bright cold hour at the nameplate capacity of an undersized site', () => {
    const site = buildSite({ capacityKw: 2 });
    const weather = buildWeather({
      shortwaveRadiationWm2: 900,
      directRadiationWm2: 780,
      diffuseRadiationWm2: 160,
      directNormalIrradianceWm2: 980,
      temperature2mC: -5,
      windSpeed10mMs: 8,
      cloudCoverPct: 0,
    });

    const forecast = createPhysicsForecast({ site, weather, issuedAt });

    expect(forecast.acPowerKw).toBe(site.capacityKw);
    // The equality above would also hold if the array happened to land on nameplate, so
    // assert the clip actually bit: unclipped inverter output exceeds the ceiling.
    expect(runPhysicsChain(site, weather).dcPowerKw * 0.96).toBeGreaterThan(site.capacityKw);
  });

  it('returns identical results when run twice on the same inputs', () => {
    const site = buildSite();
    const weather = buildWeather();

    expect(createPhysicsForecast({ site, weather, issuedAt })).toEqual(
      createPhysicsForecast({ site, weather, issuedAt }),
    );
    expect(runPhysicsChain(site, weather)).toEqual(runPhysicsChain(site, weather));
  });
});

describe('runPhysicsChain', () => {
  it('evaluates the sun position at the midpoint of the hour the reading ends', () => {
    // Radiation fields are means over the hour *ending* at validTime, so the sun that
    // belongs with them is the one halfway through it.
    const site = buildSite();
    const weather = buildWeather();
    const validTimeMs = Date.parse(weather.validTime);

    const { solar } = runPhysicsChain(site, weather);

    expect(solar).toEqual(
      solarPosition({
        latitudeDeg: site.latitude,
        longitudeDeg: site.longitude,
        timeUtcMs: validTimeMs - HALF_HOUR_MS,
      }),
    );
    // The half hour is load-bearing, not a rounding detail: the sun at validTime itself
    // is a measurably different sun.
    expect(solar).not.toEqual(
      solarPosition({
        latitudeDeg: site.latitude,
        longitudeDeg: site.longitude,
        timeUtcMs: validTimeMs,
      }),
    );
  });

  it('takes solar geometry from the site coordinates and never from the reading', () => {
    // A reading is fetched per rounded location and fanned out to nearby sites, so its
    // coordinates legitimately differ from the site's. Pairing is orchestration's job
    // (#11/#13); the engine trusts the site.
    const site = buildSite();
    const nearbyReading = buildWeather();
    const farAwayReading = buildWeather({ latitude: -37.8136, longitude: 144.9631 });

    expect(runPhysicsChain(site, farAwayReading)).toEqual(runPhysicsChain(site, nearbyReading));
    expect(runPhysicsChain(site, farAwayReading).solar).toEqual(
      solarPosition({
        latitudeDeg: site.latitude,
        longitudeDeg: site.longitude,
        timeUtcMs: Date.parse(nearbyReading.validTime) - HALF_HOUR_MS,
      }),
    );
  });
});
