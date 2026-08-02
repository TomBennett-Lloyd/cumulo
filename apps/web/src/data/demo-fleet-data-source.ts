import {
  canonicalFleetSeed,
  createSiteInputSchema,
  forecastSchema,
  generateFleet,
  type CreateSiteInput,
  type Forecast,
  type GenerationReading,
  type Site,
} from '@cumulo/shared';

import { fixtureActuals, fixtureForecasts } from './fixture-series';
import type {
  FleetSourceResult,
  FleetDataError,
  FleetDataSource,
  FleetSourceCapabilities,
  RangeHours,
} from './fleet-data-source';

const MS_PER_HOUR = 3_600_000;

/**
 * How long a freshly created site waits for its first forecast here.
 *
 * 45 seconds is a deliberate near-miss of the ticket's 60-second promise: it
 * leaves one 5-second poll of headroom, so a test that passes at this default
 * would still pass if the real pipeline were a poll slower — and would fail if
 * the UI added a wait of its own.
 */
const DEFAULT_FIRST_FORECAST_DELAY_MS = 45_000;

/** Hours of forecast the demo returns — enough to fill the detail panel's table. */
const FORECAST_HORIZON_HOURS = 12;

/** Clear-sky plane-of-array peak, W/m². Plausible for these latitudes in summer. */
const PEAK_POA_IRRADIANCE_WM2 = 900;

/**
 * Fraction of nameplate a plausible array reaches at solar noon: inverter
 * losses, temperature derate and the fact that nameplate is a DC rating.
 */
const PEAK_CAPACITY_FRACTION = 0.8;

const SUNRISE_HOUR_UTC = 6;
const DAYLIGHT_HOURS = 12;

const round = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

/**
 * An instant as the fixed-width UTC form `utcIsoTimestampSchema` accepts —
 * `toISOString` always emits milliseconds, which that schema rejects.
 */
const utcSecondIso = (epochMs: number): string =>
  `${new Date(epochMs).toISOString().slice(0, 19)}Z`;

/**
 * A half-sine day: zero before sunrise and after sunset, peaking at solar noon.
 *
 * Not physics — the physics chain is `@cumulo/forecast` (#12), and reaching for
 * it here would make the demo source's output depend on a real solar position
 * for a fabricated instant. This is a shape, and it is only ever seen in the
 * demo and in tests.
 */
const daylightFraction = (hourOfDayUtc: number): number => {
  const dayProgress = (hourOfDayUtc - SUNRISE_HOUR_UTC) / DAYLIGHT_HOURS;
  return dayProgress <= 0 || dayProgress >= 1 ? 0 : Math.sin(dayProgress * Math.PI);
};

/**
 * `FORECAST_HORIZON_HOURS` of synthetic hourly output for one site, issued at
 * the hour containing `nowMs`.
 *
 * Each entry goes through `forecastSchema.parse`, so what this returns is
 * exactly what the panel would receive from the real API — including branded
 * timestamps. A parse failure here would be a bug in this function rather than
 * an expected failure, which is why it throws rather than returning a result.
 *
 * Clock-relative on purpose, and therefore not the same generator as
 * `fixture-series.ts`: the demo's headline minute is a site that has *no*
 * forecast and then has one, which only a moving clock can express. The chart
 * views need the opposite property and get the pinned one.
 */
const syntheticForecasts = (site: Site, nowMs: number): readonly Forecast[] => {
  const issuedAtMs = Math.floor(nowMs / MS_PER_HOUR) * MS_PER_HOUR;

  return Array.from({ length: FORECAST_HORIZON_HOURS }, (_unused, index) => {
    const validTimeMs = issuedAtMs + (index + 1) * MS_PER_HOUR;
    const fraction = daylightFraction(new Date(validTimeMs).getUTCHours());

    return forecastSchema.parse({
      siteId: site.id,
      model: 'physics',
      validTime: utcSecondIso(validTimeMs),
      issuedAt: utcSecondIso(issuedAtMs),
      weatherSource: 'open-meteo',
      poaIrradianceWm2: round(PEAK_POA_IRRADIANCE_WM2 * fraction, 1),
      acPowerKw: round(site.capacityKw * PEAK_CAPACITY_FRACTION * fraction, 3),
    });
  });
};

/**
 * The error arm of `FleetSourceResult` says nothing about the success type, so one
 * `FleetSourceResult<never>` is assignable wherever any `FleetSourceResult<T>` is expected.
 */
const failure = (error: FleetDataError): FleetSourceResult<never> => ({ kind: 'error', error });

const siteNotFound = (siteId: string): FleetSourceResult<never> =>
  failure({ code: 'not-found', message: `No forecast for site ${siteId} yet` });

/** A site together with its position in the fleet, which is what keys its weather. */
interface FleetPosition {
  readonly site: Site;
  readonly siteIndex: number;
}

/**
 * Resolve a site id against the fleet.
 *
 * An unknown id is an expected failure, not a bug: the caller may hold a stale
 * id. It comes back as an error naming the operation and the id
 * (`error-handling.md` rules 1 and 4) rather than as an empty series, which
 * would read as "this site generates nothing".
 */
const locateSite = (
  sites: readonly Site[],
  operation: string,
  siteId: string,
): FleetSourceResult<FleetPosition> => {
  const siteIndex = sites.findIndex((candidate) => candidate.id === siteId);
  const site = sites[siteIndex];
  return site === undefined
    ? failure({
        code: 'not-found',
        message: `${operation}: no site in the fleet with id ${siteId}`,
      })
    : { kind: 'ok', value: { site, siteIndex } };
};

export interface DemoFleetDataSourceOptions {
  /** Injected clock. Tests drive the first-forecast delay through this. */
  readonly now?: () => number;
  /** Simulated pipeline latency from `createSite` to the first forecast. */
  readonly firstForecastDelayMs?: number;
}

/**
 * The whole fleet in memory: the canonical demo fleet plus whatever this
 * session has added, with a first forecast that arrives on a delay.
 *
 * A class rather than a factory over captured variables (`structure.md` rule 2)
 * because the members genuinely share mutable state — the site list, the
 * creation times, the clock — and `this.` is what makes that visible to a
 * reader holding only one of them.
 *
 * Members are arrow properties rather than prototype methods because
 * `FleetDataSource` declares them as properties: the chart views hand
 * `source.listSites` straight to a hook, and a detached prototype method would
 * arrive there with no `this` and no site list.
 *
 * The delay is the point. A site whose forecast appeared instantly would let
 * the dashboard ship without ever rendering its pending state, and the pending
 * state is most of what the visitor sees during the demo's headline minute.
 */
export class DemoFleetDataSource implements FleetDataSource {
  private readonly now: () => number;
  private readonly firstForecastDelayMs: number;
  private readonly sites: Site[];
  /** Site id → when `createSite` accepted it. Seeded sites are absent: they always have forecasts. */
  private readonly createdAtMsById = new Map<string, number>();

  constructor(options: DemoFleetDataSourceOptions = {}) {
    // Wrapped rather than passed as `Date.now`: a detached method is a lint
    // error here (`structure.md` rule 3) and a `this`-binding hazard generally.
    this.now = options.now ?? (() => Date.now());
    this.firstForecastDelayMs = options.firstForecastDelayMs ?? DEFAULT_FIRST_FORECAST_DELAY_MS;
    this.sites = [...generateFleet(canonicalFleetSeed)];
  }

  /**
   * Both true, and both earned below: `fleetForecasts` and `fleetActuals` build
   * fixture series that span the requested window backwards, so the demo fleet
   * genuinely has history and genuinely has measured output.
   */
  readonly capabilities: FleetSourceCapabilities = {
    fleetLookback: true,
    fleetActuals: true,
  };

  readonly listSites = (): Promise<FleetSourceResult<readonly Site[]>> =>
    Promise.resolve({ kind: 'ok', value: [...this.sites] });

  readonly createSite = (input: CreateSiteInput): Promise<FleetSourceResult<Site>> => {
    // The static type says this cannot fail; the schema says whether the
    // *values* are in range, which no type in this codebase encodes. This is
    // the boundary the Fleet API will enforce for real, so the demo enforces it
    // too — otherwise the dashboard would be proven against a laxer server than
    // the one it ships with.
    const parsed = createSiteInputSchema.safeParse(input);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ');
      return Promise.resolve(
        failure({ code: 'invalid-request', message: `Invalid site: ${detail}` }),
      );
    }

    const site: Site = { id: crypto.randomUUID(), ...parsed.data };
    this.sites.push(site);
    this.createdAtMsById.set(site.id, this.now());

    return Promise.resolve({ kind: 'ok', value: site });
  };

  readonly getSiteForecast = (
    siteId: Site['id'],
  ): Promise<FleetSourceResult<readonly Forecast[]>> => {
    const site = this.sites.find((candidate) => candidate.id === siteId);
    if (site === undefined) {
      return Promise.resolve(siteNotFound(siteId));
    }

    const nowMs = this.now();
    const createdAtMs = this.createdAtMsById.get(siteId);
    if (createdAtMs !== undefined && nowMs - createdAtMs < this.firstForecastDelayMs) {
      return Promise.resolve(siteNotFound(siteId));
    }

    return Promise.resolve({ kind: 'ok', value: syntheticForecasts(site, nowMs) });
  };

  readonly siteForecasts = (
    siteId: Site['id'],
    range: RangeHours,
  ): Promise<FleetSourceResult<readonly Forecast[]>> => {
    const found = locateSite(this.sites, 'siteForecasts', siteId);
    return Promise.resolve(
      found.kind === 'error'
        ? found
        : { kind: 'ok', value: fixtureForecasts(found.value.site, found.value.siteIndex, range) },
    );
  };

  readonly siteActuals = (
    siteId: Site['id'],
    range: RangeHours,
  ): Promise<FleetSourceResult<readonly GenerationReading[]>> => {
    const found = locateSite(this.sites, 'siteActuals', siteId);
    return Promise.resolve(
      found.kind === 'error'
        ? found
        : { kind: 'ok', value: fixtureActuals(found.value.site, found.value.siteIndex, range) },
    );
  };

  readonly fleetForecasts = (range: RangeHours): Promise<FleetSourceResult<readonly Forecast[]>> =>
    Promise.resolve({
      kind: 'ok',
      value: this.sites.flatMap((site, siteIndex) => fixtureForecasts(site, siteIndex, range)),
    });

  readonly fleetActuals = (
    range: RangeHours,
  ): Promise<FleetSourceResult<readonly GenerationReading[]>> =>
    Promise.resolve({
      kind: 'ok',
      value: this.sites.flatMap((site, siteIndex) => fixtureActuals(site, siteIndex, range)),
    });
}
