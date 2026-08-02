// @vitest-environment jsdom

import {
  utcIsoTimestampSchema,
  type Forecast,
  type GenerationReading,
  type Site,
  type UncertaintyBand,
  type UtcIsoTimestamp,
} from '@cumulo/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { DemoFleetDataSource } from '../data/demo-fleet-data-source';
import type {
  FleetDataSource,
  FleetSourceCapabilities,
  FleetSourceResult,
  RangeHours,
} from '../data/fleet-data-source';
import { FleetPanel } from './FleetPanel';
import { EMPTY_FLEET_MESSAGE, LOADING_FLEET_FORECAST_LABEL } from './state-copy';

// Vitest runs without global test hooks, so Testing Library's automatic cleanup never registers
// itself — every render has to be torn down explicitly or later queries match two panels.
afterEach(cleanup);

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

const SITE_A = site(SITE_A_ID, 'Ashford Row');
const SITE_B = site(SITE_B_ID, 'Brambling Way');

const SITES: readonly Site[] = [SITE_A, SITE_B];

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
interface StubFleet {
  readonly forecasts: FleetSourceResult<readonly Forecast[]>;
  readonly actuals: FleetSourceResult<readonly GenerationReading[]>;
}

const ready = <T,>(value: T): FleetSourceResult<T> => ({ kind: 'ok', value });

const FULL_FLEET: StubFleet = { forecasts: ready(FORECASTS), actuals: ready(ACTUALS) };

/** 07:00 loses site B, so that hour aggregates one of the fleet's two sites and 06:00 keeps both. */
const PARTIAL_FLEET: StubFleet = {
  ...FULL_FLEET,
  forecasts: ready(
    FORECASTS.filter(
      (forecast) => !(forecast.siteId === SITE_B_ID && forecast.validTime === timestamp(7)),
    ),
  ),
};

const FORECASTLESS_FLEET: StubFleet = { ...FULL_FLEET, forecasts: ready([]) };

const FAILED_FLEET: StubFleet = {
  ...FULL_FLEET,
  forecasts: {
    kind: 'error',
    error: { code: 'network', message: 'fleetForecasts range=24: upstream timed out' },
  },
};

const FULL_CAPABILITIES: FleetSourceCapabilities = { fleetLookback: true, fleetActuals: true };

/** What the deployed HTTP source can answer: a forward horizon, and no measurements at all. */
const HORIZON_ONLY_CAPABILITIES: FleetSourceCapabilities = {
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
 * The counting is the point of several tests below: "does toggling `hidden` refetch" and "does a
 * new `refreshToken` refetch" are questions about calls, not about pixels, and only a stub that
 * remembers can answer them.
 */
class CountingFleetSource implements FleetDataSource {
  readonly forecastRanges: RangeHours[] = [];

  constructor(
    private readonly canned: StubFleet,
    readonly capabilities: FleetSourceCapabilities = FULL_CAPABILITIES,
  ) {}

  get forecastCallCount(): number {
    return this.forecastRanges.length;
  }

  readonly fleetForecasts = (
    range: RangeHours,
  ): Promise<FleetSourceResult<readonly Forecast[]>> => {
    this.forecastRanges.push(range);
    return Promise.resolve(this.canned.forecasts);
  };

  readonly fleetActuals = (): Promise<FleetSourceResult<readonly GenerationReading[]>> =>
    Promise.resolve(this.canned.actuals);

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

const settle = async (): Promise<void> => {
  await waitFor(() => {
    expect(screen.queryByText(LOADING_FLEET_FORECAST_LABEL)).toBeNull();
  });
};

const renderSettled = async (
  dataSource: FleetDataSource,
  sites: readonly Site[] = SITES,
): Promise<HTMLElement> => {
  const { container } = render(
    <FleetPanel dataSource={dataSource} sites={sites} hidden={false} refreshToken={0} />,
  );
  await settle();
  return container;
};

/**
 * One rendered table row, in column order — the row header and its cells together.
 *
 * `th, td` rather than the `cell` role, because the time column is a `rowheader` and a row read as
 * four values would drop the hour each of them belongs to.
 */
const rowCells = (row: HTMLElement): readonly string[] =>
  Array.from(row.querySelectorAll('th, td'), (cell) => cell.textContent);

const demoFleet = async (dataSource: DemoFleetDataSource): Promise<readonly Site[]> => {
  const listed = await dataSource.listSites();
  if (listed.kind === 'error') {
    throw new Error(`the demo source refused to list its fleet: ${listed.error.message}`);
  }
  return listed.value;
};

describe('FleetPanel against a source with the full fleet-level capabilities', () => {
  it('offers the aggregation range and promises measured output, against the demo source', async () => {
    const dataSource = new DemoFleetDataSource();
    const sites = await demoFleet(dataSource);
    const container = await renderSettled(dataSource, sites);

    expect(screen.getByRole('group', { name: 'Aggregation range' })).toBeDefined();
    expect(screen.getByText(/summed hour by hour/u).textContent).toContain('measured output');
    // The canonical demo fleet is 60 sites; the kW figure is asserted by shape rather than by
    // value, because restating the sum here would only prove that two copies of it agree.
    expect(container.querySelector('.fleet-panel-stats')?.textContent).toMatch(
      /^60 sites · \d+(\.\d)? kW installed$/u,
    );
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('says "site" once and "sites" otherwise', async () => {
    const oneSite = await renderSettled(new CountingFleetSource(FULL_FLEET), [SITE_A]);

    expect(oneSite.querySelector('.fleet-panel-stats')?.textContent).toBe(
      '1 site · 4.0 kW installed',
    );

    cleanup();
    const twoSites = await renderSettled(new CountingFleetSource(FULL_FLEET));

    expect(twoSites.querySelector('.fleet-panel-stats')?.textContent).toBe(
      '2 sites · 8.0 kW installed',
    );
  });

  it('asks the source for 168 hours when the 7 d control is pressed', async () => {
    const dataSource = new CountingFleetSource(FULL_FLEET);
    await renderSettled(dataSource);

    expect(dataSource.forecastRanges).toEqual([24]);

    fireEvent.click(screen.getByRole('button', { name: '7 d' }));

    await waitFor(() => {
      expect(dataSource.forecastRanges).toEqual([24, 168]);
    });
  });

  it('labels the aggregate partial, with both counts, when an hour is missing a site', async () => {
    const container = await renderSettled(new CountingFleetSource(PARTIAL_FLEET));

    expect(container.querySelector('.panel-notice')?.textContent).toBe(
      'Partial aggregate: some hours include only 1 of 2 sites.',
    );
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('sums the fleet into the chart, hour by hour: median, band bounds and measurement', async () => {
    await renderSettled(new CountingFleetSource(FULL_FLEET));

    const table = screen.getByRole('table', {
      name: 'Table view — fleet forecast and measured output, 24 h range, kW',
    });

    /*
     * The table twin is where the plotted numbers are readable as text, so it is where the
     * aggregate can be pinned; the SVG carries the same values as coordinates nobody can assert
     * on without re-deriving the geometry.
     *
     * Every figure below is the fixture's own arithmetic, stated rather than computed: at 06:00
     * the two sites forecast 2 and 4 kW (median 6), their bands are 1–3 and 3–6 (P10 4, P90 9 —
     * comonotonic addition, `@cumulo/shared`'s rule, not this panel's), and they measured 1.5 and
     * 3.5 (5). 07:00 has no readings at all, so its measurement cell is the em dash a gap reads
     * as — which is what stops a suite from passing on an actuals series that silently went
     * missing.
     */
    expect(within(table).getAllByRole('row').map(rowCells)).toEqual([
      ['Time', 'P10', 'Median', 'P90', 'Actual'],
      ['06:00', '4.0', '6.0', '9.0', '5.0'],
      ['07:00', '6.0', '8.0', '11.0', '—'],
    ]);
  });

  it('states the fleet size when every displayed hour has the whole fleet in it', async () => {
    const container = await renderSettled(new CountingFleetSource(FULL_FLEET));

    expect(container.querySelector('.panel-caption')?.textContent).toBe('Aggregated from 2 sites');
    expect(container.querySelector('.panel-notice')).toBeNull();
  });
});

describe('FleetPanel against a source that can only see the horizon', () => {
  const horizonSource = (canned: StubFleet = FULL_FLEET): CountingFleetSource =>
    new CountingFleetSource(canned, HORIZON_ONLY_CAPABILITIES);

  it('withholds the range control and names the horizon instead', async () => {
    const container = await renderSettled(horizonSource());

    expect(screen.queryByRole('group', { name: 'Aggregation range' })).toBeNull();
    expect(container.querySelector('.panel-caption')?.textContent).toBe(
      'Forecast horizon: next 24 hours',
    );
  });

  it('never says the word "measured" — not in prose, not in the chart\'s accessible name', async () => {
    const container = await renderSettled(horizonSource());

    // innerHTML rather than textContent on purpose: an aria-label is copy too, and it is the copy
    // most easily left promising data the source cannot produce.
    expect(container.innerHTML.toLowerCase()).not.toContain('measured');
    expect(screen.getByRole('img', { name: /Fleet forecast/u }).getAttribute('aria-label')).toBe(
      'Fleet forecast, next 24 h',
    );
  });

  it('only ever asks for the 24 hour window it advertises', async () => {
    const dataSource = horizonSource();
    await renderSettled(dataSource);

    expect(dataSource.forecastRanges).toEqual([24]);
  });
});

describe('FleetPanel with nothing to show', () => {
  it('makes an empty fleet the invitation, with no chart and no range control', async () => {
    const container = await renderSettled(new CountingFleetSource(FULL_FLEET), []);

    expect(screen.getByText(EMPTY_FLEET_MESSAGE)).toBeDefined();
    expect(container.querySelector('svg')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Aggregation range' })).toBeNull();
    expect(container.querySelector('.fleet-panel-hint')).toBeNull();
  });

  it('explains a fleet with sites but no forecast hours', async () => {
    const container = await renderSettled(new CountingFleetSource(FORECASTLESS_FLEET));

    expect(screen.getByText('No fleet forecast available yet')).toBeDefined();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('frames the source failure with the surface that failed, and retries on request', async () => {
    const dataSource = new CountingFleetSource(FAILED_FLEET);
    await renderSettled(dataSource);

    expect(screen.getByRole('alert').textContent).toContain(
      'Could not load the fleet forecast: fleetForecasts range=24: upstream timed out',
    );
    expect(dataSource.forecastCallCount).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => {
      expect(dataSource.forecastCallCount).toBe(2);
    });
  });
});

describe('FleetPanel as the column keeps it mounted', () => {
  it('re-sums the fleet when the dashboard bumps the refresh token', async () => {
    const dataSource = new CountingFleetSource(FULL_FLEET);
    const { rerender } = render(
      <FleetPanel dataSource={dataSource} sites={SITES} hidden={false} refreshToken={0} />,
    );
    await settle();

    expect(dataSource.forecastCallCount).toBe(1);

    rerender(<FleetPanel dataSource={dataSource} sites={SITES} hidden={false} refreshToken={1} />);

    await waitFor(() => {
      expect(dataSource.forecastCallCount).toBe(2);
    });
  });

  it('hides without refetching, keeping the aggregate it already has', async () => {
    const dataSource = new CountingFleetSource(FULL_FLEET);
    const { container, rerender } = render(
      <FleetPanel dataSource={dataSource} sites={SITES} hidden={false} refreshToken={0} />,
    );
    await settle();

    expect(dataSource.forecastCallCount).toBe(1);

    rerender(<FleetPanel dataSource={dataSource} sites={SITES} hidden refreshToken={0} />);

    const panel = container.querySelector('.fleet-panel');
    expect(panel?.hasAttribute('hidden')).toBe(true);
    // The chart is still in the tree behind the attribute: the panel kept its state, which is the
    // whole reason the column hides it instead of unmounting it.
    expect(container.querySelector('svg')).not.toBeNull();

    rerender(<FleetPanel dataSource={dataSource} sites={SITES} hidden={false} refreshToken={0} />);

    expect(container.querySelector('.fleet-panel')?.hasAttribute('hidden')).toBe(false);
    expect(dataSource.forecastCallCount).toBe(1);
  });

  it('credits Open-Meteo nowhere inside itself — the column footer owns that credit', async () => {
    await renderSettled(new CountingFleetSource(FULL_FLEET));

    expect(screen.queryByRole('link', { name: 'Open-Meteo.com' })).toBeNull();
  });
});
