import {
  canonicalFleetSeed,
  forecastSchema,
  generateFleet,
  type CreateSiteInput,
} from '@cumulo/shared';
import { describe, expect, it } from 'vitest';

import { DemoFleetDataSource } from './demo-fleet-data-source';

/** A mutable instant the tests move by hand — the source never reads a real clock. */
interface MutableClock {
  ms: number;
}

/**
 * The reader half of `MutableClock`, taking the clock as a parameter rather
 * than closing over one from the enclosing test (`structure.md` rule 1).
 */
const clockReader =
  (clock: MutableClock): (() => number) =>
  () =>
    clock.ms;

const START_MS = Date.UTC(2026, 6, 31, 9, 0, 0);
const DELAY_MS = 45_000;

const seedFleet = generateFleet(canonicalFleetSeed);

const validInput: CreateSiteInput = {
  name: 'Visitor rooftop',
  latitude: 53.35,
  longitude: -6.26,
  tiltDegrees: 35,
  azimuthDegrees: 180,
  capacityKw: 4.5,
};

/**
 * Each row is the first value outside a bound `createSiteInputSchema` declares,
 * so a bound dropped from the schema makes exactly that row pass.
 */
const invalidInputCases: readonly [why: string, overrides: Partial<CreateSiteInput>][] = [
  ['a tilt past vertical', { tiltDegrees: 95 }],
  ['a full turn of azimuth, which must normalize to 0', { azimuthDegrees: 360 }],
  ['a site with no capacity', { capacityKw: 0 }],
  ['capacity above the residential sanity ceiling', { capacityKw: 50.1 }],
  ['a nameless site nobody could pick out of the list', { name: '' }],
];

describe('DemoFleetDataSource', () => {
  it('lists the whole canonical demo fleet', async () => {
    const clock: MutableClock = { ms: START_MS };
    const source = new DemoFleetDataSource({ now: clockReader(clock) });

    const result = await source.listSites();

    expect(result.kind).toBe('ok');
    expect(result.kind === 'ok' && result.value).toHaveLength(60);
    expect(result.kind === 'ok' && result.value[0]?.id).toBe(seedFleet[0]?.id);
  });

  it.each(invalidInputCases)(
    'refuses %s as an error value rather than a throw',
    async (_why, overrides) => {
      const clock: MutableClock = { ms: START_MS };
      const source = new DemoFleetDataSource({ now: clockReader(clock) });

      const result = await source.createSite({ ...validInput, ...overrides });

      expect(result.kind).toBe('error');
      expect(result.kind === 'error' && result.error.code).toBe('invalid-response');
      expect(result.kind === 'error' && result.error.message).toContain('Invalid site');
    },
  );

  it('leaves the fleet untouched when creation is refused', async () => {
    const clock: MutableClock = { ms: START_MS };
    const source = new DemoFleetDataSource({ now: clockReader(clock) });

    await source.createSite({ ...validInput, capacityKw: 0 });
    const result = await source.listSites();

    expect(result.kind === 'ok' && result.value).toHaveLength(60);
  });

  it('assigns the id itself and returns the site carrying it', async () => {
    const clock: MutableClock = { ms: START_MS };
    const source = new DemoFleetDataSource({ now: clockReader(clock) });

    const created = await source.createSite(validInput);
    const listed = await source.listSites();

    expect(created.kind).toBe('ok');
    const createdId = created.kind === 'ok' ? created.value.id : '';
    expect(createdId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(seedFleet.some((site) => site.id === createdId)).toBe(false);
    expect(listed.kind === 'ok' && listed.value).toHaveLength(61);
    expect(listed.kind === 'ok' && listed.value.some((site) => site.id === createdId)).toBe(true);
  });

  it('withholds the first forecast until the pipeline delay has elapsed', async () => {
    const clock: MutableClock = { ms: START_MS };
    const source = new DemoFleetDataSource({
      now: clockReader(clock),
      firstForecastDelayMs: DELAY_MS,
    });
    const created = await source.createSite(validInput);
    const siteId = created.kind === 'ok' ? created.value.id : '';

    const immediately = await source.getSiteForecast(siteId);
    clock.ms = START_MS + DELAY_MS - 1;
    const justBefore = await source.getSiteForecast(siteId);
    clock.ms = START_MS + DELAY_MS;
    const onTime = await source.getSiteForecast(siteId);

    expect(immediately.kind === 'error' && immediately.error.code).toBe('not-found');
    expect(justBefore.kind === 'error' && justBefore.error.code).toBe('not-found');
    expect(onTime.kind).toBe('ok');
  });

  it('returns schema-valid physics forecasts for the new site once they exist', async () => {
    const clock: MutableClock = { ms: START_MS };
    const source = new DemoFleetDataSource({
      now: clockReader(clock),
      firstForecastDelayMs: DELAY_MS,
    });
    const created = await source.createSite(validInput);
    const siteId = created.kind === 'ok' ? created.value.id : '';

    clock.ms = START_MS + DELAY_MS;
    const result = await source.getSiteForecast(siteId);
    const forecasts = result.kind === 'ok' ? result.value : [];

    expect(forecasts.length).toBeGreaterThan(0);
    for (const forecast of forecasts) {
      expect(forecastSchema.safeParse(forecast).success).toBe(true);
      expect(forecast.siteId).toBe(siteId);
      expect(forecast.model).toBe('physics');
      expect(forecast.weatherSource).toBe('open-meteo');
      expect(forecast.acPowerKw).toBeLessThanOrEqual(validInput.capacityKw);
    }
    // Distinct, ascending hours — a series the detail panel can tabulate.
    expect(new Set(forecasts.map((forecast) => forecast.validTime)).size).toBe(forecasts.length);
  });

  it('has forecasts for a seeded site from the first instant — the delay is for new sites only', async () => {
    const clock: MutableClock = { ms: START_MS };
    const source = new DemoFleetDataSource({
      now: clockReader(clock),
      firstForecastDelayMs: DELAY_MS,
    });

    const result = await source.getSiteForecast(seedFleet[0]?.id ?? '');

    expect(result.kind).toBe('ok');
  });

  it('reports a site it has never heard of as not-found', async () => {
    const clock: MutableClock = { ms: START_MS };
    const source = new DemoFleetDataSource({ now: clockReader(clock) });

    const result = await source.getSiteForecast('11111111-2222-4333-8444-555555555555');

    expect(result.kind === 'error' && result.error.code).toBe('not-found');
    expect(result.kind === 'error' && result.error.message).toContain('11111111');
  });

  it('runs on the real clock when no clock is injected', async () => {
    const source = new DemoFleetDataSource();

    const created = await source.createSite(validInput);
    const pending = await source.getSiteForecast(created.kind === 'ok' ? created.value.id : '');

    // The production default is a 45-second wait, so a forecast requested in the
    // same millisecond must not exist (`testing.md` rule 7: the injected clock
    // above is the knob, and this test runs with it off).
    expect(pending.kind === 'error' && pending.error.code).toBe('not-found');
  });
});
