import {
  canonicalFleetSeed,
  FLEET_ROLLUP_FORECAST_KIND,
  forecastSchema,
  generateFleet,
  type CreateSiteInput,
} from '@cumulo/shared';
import { describe, expect, it } from 'vitest';

import { DemoFleetDataSource } from './demo-fleet-data-source';
import { FIXTURE_NOW } from './fixture-series';

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
      expect(result.kind === 'error' && result.error.code).toBe('invalid-request');
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
    // Distinct, ascending hours — one point per hour, which is what the fleet
    // chart's overlay joins onto its x-domain by timestamp. Duplicated hours
    // would collapse there rather than fail, and the line would silently lose
    // samples.
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

/**
 * The window-scoped reads the chart views make. They are the same fleet as the
 * calls above — one source, one site list — but a different question: a window
 * of history rather than "is there a forecast yet".
 */
describe('DemoFleetDataSource window-scoped reads', () => {
  const seededSiteId = seedFleet[0]?.id ?? '';

  it('serves one site over a window, ascending and hourly', async () => {
    const source = new DemoFleetDataSource();

    const result = await source.siteForecasts(seededSiteId, 24);
    const forecasts = result.kind === 'ok' ? result.value : [];
    const validTimes = forecasts.map((forecast) => forecast.validTime);

    // 24 h back + the current hour + the 24 h horizon.
    expect(forecasts).toHaveLength(49);
    expect(validTimes).toEqual([...validTimes].sort());
    expect(new Set(validTimes).size).toBe(validTimes.length);
  });

  it('measures nothing later than the pinned fixture now', async () => {
    const source = new DemoFleetDataSource();

    const result = await source.siteActuals(seededSiteId, 168);
    const actuals = result.kind === 'ok' ? result.value : [];

    expect(actuals.length).toBeGreaterThan(0);
    expect(actuals.every((actual) => actual.validTime <= FIXTURE_NOW)).toBe(true);
  });

  it('reports an unknown site id as not-found, naming the operation and the id', async () => {
    const source = new DemoFleetDataSource();

    const forecasts = await source.siteForecasts('not-a-site', 24);
    const actuals = await source.siteActuals('not-a-site', 24);

    expect(forecasts.kind === 'error' && forecasts.error.code).toBe('not-found');
    expect(forecasts.kind === 'error' && forecasts.error.message).toContain('siteForecasts');
    expect(forecasts.kind === 'error' && forecasts.error.message).toContain('not-a-site');
    expect(actuals.kind === 'error' && actuals.error.message).toContain('siteActuals');
  });

  it('serves every site from the fleet-level calls', async () => {
    const source = new DemoFleetDataSource();

    const forecasts = await source.fleetForecasts(24);
    const actuals = await source.fleetActuals(24);
    const everyHourCarriesTheFleet = (
      points: readonly { readonly contributingSiteCount: number }[],
    ): boolean => points.every((point) => point.contributingSiteCount === seedFleet.length);

    // Both halves are summed by this source (#494, #506), so "every site is in it" is read off the
    // contributing count rather than off distinct site ids: 49 forecast hours, every one of them
    // carrying the whole fleet, and every actuals hour likewise.
    expect(forecasts.kind === 'ok' && forecasts.value).toHaveLength(49);
    expect(forecasts.kind === 'ok' && everyHourCarriesTheFleet(forecasts.value)).toBe(true);
    expect(actuals.kind === 'ok' && actuals.value.length).toBeGreaterThan(0);
    expect(actuals.kind === 'ok' && everyHourCarriesTheFleet(actuals.value)).toBe(true);
  });

  /**
   * The point of the unification (#105): one source means a site added on the
   * map is a site the chart views aggregate, rather than two fleets that agree
   * only by having started from the same seed.
   */
  it('includes a site created this session in the fleet-level series', async () => {
    const source = new DemoFleetDataSource();
    const before = await source.fleetForecasts(24);
    const beforeCount = before.kind === 'ok' ? (before.value[0]?.contributingSiteCount ?? 0) : 0;

    await source.createSite(validInput);

    const result = await source.fleetForecasts(24);
    const points = result.kind === 'ok' ? result.value : [];

    // The summed shape cannot be asked "is this site in it?" by id, so it is asked the question the
    // sum can answer: one more site contributed, and the capacity behind the hour grew with it.
    expect(points[0]?.contributingSiteCount).toBe(beforeCount + 1);
    expect(points[0]?.contributingCapacityKw).toBeGreaterThan(0);
  });

  /**
   * The fleet total is the sum of the sites' *rolled-up-model* forecasts, which is what stops this
   * source being correct by coincidence (#531).
   *
   * Before the kind was a parameter, the demo summed whatever `fixture-series.ts` emitted, and that
   * was one model only because the fixture says so. The assertion is on the kilowatts rather than on
   * the contributing count because a second model for a site-hour does not add a site — it replaces
   * the row, so only the power moves. The issue's own proof is the mutant of that fixture, run
   * against this case and recorded in the PR body.
   */
  it('sums only the rolled-up model, so the fixture\u2019s choice of model is not the source of truth', async () => {
    const source = new DemoFleetDataSource();
    const fleet = await source.fleetForecasts(24);
    const firstHour = fleet.kind === 'ok' ? fleet.value[0] : undefined;

    const perSite = await Promise.all(
      seedFleet.map(async (site) => {
        const own = await source.siteForecasts(site.id, 24);
        return own.kind === 'ok'
          ? own.value
              .filter(
                (forecast) =>
                  forecast.model === FLEET_ROLLUP_FORECAST_KIND.model &&
                  forecast.validTime === firstHour?.validTime,
              )
              .reduce((total, forecast) => total + forecast.acPowerKw, 0)
          : 0;
      }),
    );

    expect(firstHour).toBeDefined();
    // Close, not exact: the two sums add the same terms in different orders, and IEEE-754 addition
    // is not associative (ADR 0009 bounds the same effect between its own two arms).
    expect(firstHour?.acPowerKw).toBeCloseTo(
      perSite.reduce((total, siteKw) => total + siteKw, 0),
      9,
    );
  });

  /**
   * Pinned as a whole object rather than field by field: a source that grows a
   * third capability, or quietly drops one, fails here rather than silently
   * handing the views a default nobody chose.
   */
  it('claims both fleet-level capabilities, and the fleet reads above are what earns them', () => {
    const source = new DemoFleetDataSource();

    expect(source.capabilities).toEqual({ fleetLookback: true, fleetActuals: true });
  });
});
