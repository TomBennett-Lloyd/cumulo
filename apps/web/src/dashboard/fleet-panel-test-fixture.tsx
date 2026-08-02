import {
  utcIsoTimestampSchema,
  type Forecast,
  type GenerationReading,
  type Site,
  type UncertaintyBand,
  type UtcIsoTimestamp,
} from '@cumulo/shared';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { expect } from 'vitest';

import type {
  FleetDataSource,
  FleetSourceCapabilities,
  FleetSourceResult,
  RangeHours,
} from '../data/fleet-data-source';
import { FleetPanel } from './FleetPanel';
import { LOADING_FLEET_FORECAST_LABEL } from './state-copy';

/**
 * The shared way of feeding and mounting a `FleetPanel` in jsdom.
 *
 * Extracted when `FleetPanel.test.tsx` reached the 300-line ceiling
 * (`structure.md` rule 4) with the hide/reveal cases still to write. The fixtures
 * moved rather than the tests because they are the part with no opinions in it:
 * a canned two-site fleet, the four answers a source can give about it, and the
 * two lines every test writes to get a panel on screen. The suites keep their
 * own subjects. This mirrors `dashboard-test-fixture.tsx`, which the dashboard's
 * two suites share for the same reason.
 *
 * Helpers only one suite needs stay in that suite — the table-row reader and the
 * demo fleet's listing are in `FleetPanel.test.tsx`, not here.
 */

const SITE_A_ID = '11111111-1111-4111-8111-111111111111';
const SITE_B_ID = '22222222-2222-4222-8222-222222222222';

const timestamp = (hour: number): UtcIsoTimestamp =>
  utcIsoTimestampSchema.parse(`2026-07-30T${hour.toString().padStart(2, '0')}:00:00Z`);

const ISSUED_AT = timestamp(5);

const site = (id: string, name: string): Site => ({
  id,
  name,
  latitude: 51.5,
  longitude: -0.13,
  tiltDegrees: 35,
  azimuthDegrees: 180,
  capacityKw: 4,
});

export const SITE_A = site(SITE_A_ID, 'Ashford Row');
const SITE_B = site(SITE_B_ID, 'Brambling Way');

export const SITES: readonly Site[] = [SITE_A, SITE_B];

const band = (p10AcPowerKw: number, p90AcPowerKw: number): UncertaintyBand => ({
  p10AcPowerKw,
  p90AcPowerKw,
});

/**
 * One site-hour forecast. `uncertainty` is passed as `null` rather than omitted so the builder can
 * add the key conditionally: under `exactOptionalPropertyTypes` a present-but-undefined band and an
 * absent one are different values, and the absent one is what a point estimate means.
 */
const forecastAt = (
  siteId: string,
  hour: number,
  acPowerKw: number,
  uncertainty: UncertaintyBand | null,
): Forecast => {
  const point: Omit<Forecast, 'uncertainty'> = {
    siteId,
    model: 'physics',
    validTime: timestamp(hour),
    issuedAt: ISSUED_AT,
    weatherSource: 'open-meteo',
    poaIrradianceWm2: 400,
    acPowerKw,
  };
  return uncertainty === null ? point : { ...point, uncertainty };
};

const readingAt = (siteId: string, hour: number, acPowerKw: number): GenerationReading => ({
  siteId,
  validTime: timestamp(hour),
  acPowerKw,
});

const FORECASTS: readonly Forecast[] = [
  forecastAt(SITE_A_ID, 6, 2, band(1, 3)),
  forecastAt(SITE_B_ID, 6, 4, band(3, 6)),
  forecastAt(SITE_A_ID, 7, 3, band(2, 4)),
  forecastAt(SITE_B_ID, 7, 5, band(4, 7)),
];

const ACTUALS: readonly GenerationReading[] = [
  readingAt(SITE_A_ID, 6, 1.5),
  readingAt(SITE_B_ID, 6, 3.5),
];

/** The canned answers to the two fleet-level calls the panel makes. */
export interface StubFleet {
  readonly forecasts: FleetSourceResult<readonly Forecast[]>;
  readonly actuals: FleetSourceResult<readonly GenerationReading[]>;
}

const ready = <T,>(value: T): FleetSourceResult<T> => ({ kind: 'ok', value });

export const FULL_FLEET: StubFleet = { forecasts: ready(FORECASTS), actuals: ready(ACTUALS) };

/** 07:00 loses site B, so that hour aggregates one of the fleet's two sites and 06:00 keeps both. */
export const PARTIAL_FLEET: StubFleet = {
  ...FULL_FLEET,
  forecasts: ready(
    FORECASTS.filter(
      (forecast) => !(forecast.siteId === SITE_B_ID && forecast.validTime === timestamp(7)),
    ),
  ),
};

export const FORECASTLESS_FLEET: StubFleet = { ...FULL_FLEET, forecasts: ready([]) };

export const FAILED_FLEET: StubFleet = {
  ...FULL_FLEET,
  forecasts: {
    kind: 'error',
    error: { code: 'network', message: 'fleetForecasts range=24: upstream timed out' },
  },
};

const FULL_CAPABILITIES: FleetSourceCapabilities = { fleetLookback: true, fleetActuals: true };

/** What the deployed HTTP source can answer: a forward horizon, and no measurements at all. */
export const HORIZON_ONLY_CAPABILITIES: FleetSourceCapabilities = {
  fleetLookback: false,
  fleetActuals: false,
};

/**
 * A `FleetDataSource` over canned results that counts what it was asked.
 *
 * A class rather than a `createStubSource(canned)` closure factory (`structure.md` rule 2): the
 * members genuinely share the canned data and the call log, and `this.` is what makes that sharing
 * visible. The members are arrow properties because the interface's are.
 *
 * The counting is the point of several tests: "does toggling `hidden` refetch" and "does a new
 * `refreshToken` refetch" are questions about calls, not about pixels, and only a stub that
 * remembers can answer them.
 */
export class CountingFleetSource implements FleetDataSource {
  readonly forecastRanges: RangeHours[] = [];

  /** Counted separately from the forecasts: "neither call was spent" is two facts, not one. */
  private actualsCalls = 0;

  constructor(
    private readonly canned: StubFleet,
    readonly capabilities: FleetSourceCapabilities = FULL_CAPABILITIES,
  ) {}

  get forecastCallCount(): number {
    return this.forecastRanges.length;
  }

  get actualsCallCount(): number {
    return this.actualsCalls;
  }

  readonly fleetForecasts = (
    range: RangeHours,
  ): Promise<FleetSourceResult<readonly Forecast[]>> => {
    this.forecastRanges.push(range);
    return Promise.resolve(this.canned.forecasts);
  };

  readonly fleetActuals = (): Promise<FleetSourceResult<readonly GenerationReading[]>> => {
    this.actualsCalls += 1;
    return Promise.resolve(this.canned.actuals);
  };

  // The panel is fleet-level only; being asked for per-site data or for a write is a bug worth a
  // loud crash rather than an error result the panel would render as an ordinary upstream problem.
  readonly listSites = (): Promise<FleetSourceResult<readonly Site[]>> => {
    throw new Error('CountingFleetSource: the fleet panel takes its sites as a prop');
  };

  readonly siteForecasts = (): Promise<FleetSourceResult<readonly Forecast[]>> => {
    throw new Error('CountingFleetSource: the fleet panel must not call siteForecasts');
  };

  readonly siteActuals = (): Promise<FleetSourceResult<readonly GenerationReading[]>> => {
    throw new Error('CountingFleetSource: the fleet panel must not call siteActuals');
  };

  readonly getSiteForecast = (): Promise<FleetSourceResult<readonly Forecast[]>> => {
    throw new Error('CountingFleetSource: the fleet panel must not call getSiteForecast');
  };

  readonly createSite = (): Promise<FleetSourceResult<Site>> => {
    throw new Error('CountingFleetSource: the fleet panel never writes to the fleet');
  };
}

/** Waits for both fleet reads to have answered, whatever they answered. */
export const settle = async (): Promise<void> => {
  await waitFor(() => {
    expect(screen.queryByText(LOADING_FLEET_FORECAST_LABEL)).toBeNull();
  });
};

/**
 * The panel as the column mounts it, over the shared two-site fleet.
 *
 * A returned element rather than a render call, because the hide/reveal tests mount it once and
 * then `rerender` it with one prop moved — and a prop added to {@link FleetPanel} would otherwise
 * leave a dozen copies wrong at once (`structure.md` rule 7). The fleet is a parameter of
 * {@link renderSettled}, which is what the tests that vary it use.
 */
export const panel = (
  dataSource: FleetDataSource,
  hidden: boolean,
  refreshToken = 0,
): ReactElement => (
  <FleetPanel dataSource={dataSource} sites={SITES} hidden={hidden} refreshToken={refreshToken} />
);

/** A visible panel over the given fleet, once its reads have answered. */
export const renderSettled = async (
  dataSource: FleetDataSource,
  sites: readonly Site[] = SITES,
): Promise<HTMLElement> => {
  const { container } = render(
    <FleetPanel dataSource={dataSource} sites={sites} hidden={false} refreshToken={0} />,
  );
  await settle();
  return container;
};
