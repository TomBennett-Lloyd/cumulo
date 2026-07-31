// @vitest-environment jsdom

import {
  utcIsoTimestampSchema,
  type Forecast,
  type GenerationReading,
  type Site,
} from '@cumulo/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { FleetDataSource, FleetSourceResult, RangeHours } from '../data/fleet-data-source';
import { joinSiteSeries, SiteDetailView } from './SiteDetailView';

// Vitest runs without global test hooks, so Testing Library's automatic cleanup
// never registers itself.
afterEach(cleanup);

const at = (hour: number) =>
  utcIsoTimestampSchema.parse(`2026-07-30T${hour.toString().padStart(2, '0')}:00:00Z`);

const site = (id: string, name: string): Site => ({
  id,
  name,
  latitude: 51.5,
  longitude: -0.13,
  tiltDegrees: 35,
  azimuthDegrees: 180,
  capacityKw: 8,
});

const pointEstimate = (siteId: string, hour: number, medianKw: number): Forecast => ({
  siteId,
  model: 'physics',
  validTime: at(hour),
  issuedAt: at(0),
  weatherSource: 'open-meteo',
  poaIrradianceWm2: medianKw * 100,
  acPowerKw: medianKw,
});

const banded = (siteId: string, hour: number, medianKw: number): Forecast => ({
  ...pointEstimate(siteId, hour, medianKw),
  uncertainty: { p10AcPowerKw: medianKw - 0.5, p90AcPowerKw: medianKw + 0.5 },
});

const reading = (siteId: string, hour: number, acPowerKw: number): GenerationReading => ({
  siteId,
  validTime: at(hour),
  acPowerKw,
});

const SUNNYSIDE = site('1f8f1f4e-8f4a-4a2f-9a7a-2f7c1f4e8f4a', 'Sunnyside Farm');
const HARBOUR = site('2a9c2b5d-7e3b-4b1c-8c6d-3e8d2a5c7b1e', 'Harbour View');

interface SiteSeriesFixture {
  readonly forecasts: readonly Forecast[];
  readonly actuals: readonly GenerationReading[];
}

/**
 * Disjoint value sets by construction: no number rendered for one site appears
 * for the other, so a single table cell identifies which site is on screen.
 */
const SUNNYSIDE_SERIES: SiteSeriesFixture = {
  forecasts: [banded(SUNNYSIDE.id, 6, 1), banded(SUNNYSIDE.id, 9, 4), banded(SUNNYSIDE.id, 12, 6)],
  actuals: [reading(SUNNYSIDE.id, 6, 0.9), reading(SUNNYSIDE.id, 9, 3.8)],
};

const HARBOUR_SERIES: SiteSeriesFixture = {
  forecasts: [banded(HARBOUR.id, 6, 2), banded(HARBOUR.id, 9, 5), banded(HARBOUR.id, 12, 7)],
  actuals: [reading(HARBOUR.id, 6, 1.9)],
};

interface SeriesRequest {
  readonly siteId: string;
  readonly range: RangeHours;
}

interface StubConfig {
  readonly sites: FleetSourceResult<readonly Site[]>;
  readonly series: ReadonlyMap<string, SiteSeriesFixture>;
  /** Non-null makes both per-site calls fail, the way an unreachable API would. */
  readonly seriesError: string | null;
}

/** The wire failure the stub returns when `seriesError` is set — one arm, one message. */
const seriesFailure = (message: string): FleetSourceResult<never> => ({
  kind: 'error',
  error: { code: 'network', message },
});

/**
 * A hand-rolled `FleetDataSource`. Our own interface, so there is nothing to
 * mock: the stub answers the same calls the demo source and the future HTTP
 * source answer, and the tests assert on what the view rendered, not on the
 * stub having been called — except where the *request* is the behaviour under
 * test (the range picker), which is why it records them (testing.md rule 3).
 *
 * A class rather than a factory closing over a recording array: `this.` is the
 * visible marker that the recorded requests and the answers share state
 * (structure.md rule 2).
 */
class StubFleetSource implements FleetDataSource {
  readonly forecastRequests: SeriesRequest[] = [];
  readonly actualRequests: SeriesRequest[] = [];
  private readonly config: StubConfig;

  constructor(config: StubConfig) {
    this.config = config;
  }

  readonly listSites = (): Promise<FleetSourceResult<readonly Site[]>> =>
    Promise.resolve(this.config.sites);

  readonly siteForecasts = (
    siteId: string,
    range: RangeHours,
  ): Promise<FleetSourceResult<readonly Forecast[]>> => {
    this.forecastRequests.push({ siteId, range });
    return Promise.resolve<FleetSourceResult<readonly Forecast[]>>(
      this.config.seriesError === null
        ? { kind: 'ok', value: this.config.series.get(siteId)?.forecasts ?? [] }
        : seriesFailure(this.config.seriesError),
    );
  };

  readonly siteActuals = (
    siteId: string,
    range: RangeHours,
  ): Promise<FleetSourceResult<readonly GenerationReading[]>> => {
    this.actualRequests.push({ siteId, range });
    return Promise.resolve<FleetSourceResult<readonly GenerationReading[]>>(
      this.config.seriesError === null
        ? { kind: 'ok', value: this.config.series.get(siteId)?.actuals ?? [] }
        : seriesFailure(this.config.seriesError),
    );
  };

  readonly fleetForecasts = (range: RangeHours): Promise<FleetSourceResult<readonly Forecast[]>> =>
    Promise.resolve(
      seriesFailure(`fleetForecasts range=${String(range)}: the site view never aggregates`),
    );

  readonly fleetActuals = (
    range: RangeHours,
  ): Promise<FleetSourceResult<readonly GenerationReading[]>> =>
    Promise.resolve(
      seriesFailure(`fleetActuals range=${String(range)}: the site view never aggregates`),
    );

  // The site view reads; it never writes, and it never asks the poll's question.
  readonly getSiteForecast = (): Promise<FleetSourceResult<readonly Forecast[]>> => {
    throw new Error('StubFleetSource: the site view must not call getSiteForecast');
  };

  readonly createSite = (): Promise<FleetSourceResult<Site>> => {
    throw new Error('StubFleetSource: the site view never writes to the fleet');
  };
}

const configWith = (fixtures: ReadonlyMap<string, SiteSeriesFixture>): StubConfig => ({
  sites: { kind: 'ok', value: [SUNNYSIDE, HARBOUR] },
  series: fixtures,
  seriesError: null,
});

const BOTH_SITES = configWith(
  new Map([
    [SUNNYSIDE.id, SUNNYSIDE_SERIES],
    [HARBOUR.id, HARBOUR_SERIES],
  ]),
);

const renderView = (config: StubConfig): StubFleetSource => {
  const dataSource = new StubFleetSource(config);
  render(<SiteDetailView dataSource={dataSource} />);
  return dataSource;
};

const attributionHref = async (): Promise<string | null> =>
  (await screen.findByRole('link', { name: 'Open-Meteo.com' })).getAttribute('href');

describe('joinSiteSeries', () => {
  it('joins each forecast to the measurement recorded for the same instant', () => {
    const points = joinSiteSeries([banded(SUNNYSIDE.id, 9, 4)], [reading(SUNNYSIDE.id, 9, 3.8)]);

    expect(points).toEqual([
      {
        validTimeIso: '2026-07-30T09:00:00Z',
        medianKw: 4,
        band: { p10Kw: 3.5, p90Kw: 4.5 },
        actualKw: 3.8,
      },
    ]);
  });

  it('leaves an unmeasured hour null rather than carrying the previous value forward', () => {
    const points = joinSiteSeries(
      [banded(SUNNYSIDE.id, 9, 4), banded(SUNNYSIDE.id, 12, 6)],
      [reading(SUNNYSIDE.id, 9, 3.8)],
    );

    expect(points.map((point) => point.actualKw)).toEqual([3.8, null]);
  });

  it('omits the band key entirely for a point-estimate forecast', () => {
    const points = joinSiteSeries([pointEstimate(SUNNYSIDE.id, 9, 4)], []);

    expect(points[0]).not.toHaveProperty('band');
  });

  it('drops a measurement whose hour was never forecast, and sorts by time', () => {
    const points = joinSiteSeries(
      [banded(SUNNYSIDE.id, 12, 6), banded(SUNNYSIDE.id, 9, 4)],
      [reading(SUNNYSIDE.id, 3, 0.1), reading(SUNNYSIDE.id, 12, 5.9)],
    );

    expect(points.map((point) => point.validTimeIso)).toEqual([
      '2026-07-30T09:00:00Z',
      '2026-07-30T12:00:00Z',
    ]);
    expect(points.map((point) => point.actualKw)).toEqual([null, 5.9]);
  });
});

describe('SiteDetailView', () => {
  it('says it is loading before the source has answered', () => {
    renderView(BOTH_SITES);

    expect(screen.getByText('Loading the site list…')).toBeDefined();
    expect(screen.getByRole('link', { name: 'Open-Meteo.com' })).toBeDefined();
  });

  it('shows why the site list could not be loaded', async () => {
    renderView({ ...BOTH_SITES, sites: seriesFailure('listSites: network refused') });

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Could not load the site list: listSites: network refused',
    );
  });

  it('offers every site in the fleet, by name', async () => {
    renderView(BOTH_SITES);

    const select = await screen.findByLabelText('Site');
    const names = within(select)
      .getAllByRole('option')
      .map((option) => option.textContent);

    expect(names).toEqual(['Sunnyside Farm', 'Harbour View']);
  });

  it('redraws with the chosen site’s own series when the selection changes', async () => {
    renderView(BOTH_SITES);
    expect(await screen.findByText('6.0')).toBeDefined();

    fireEvent.change(await screen.findByLabelText('Site'), { target: { value: HARBOUR.id } });

    expect(await screen.findByText('7.0')).toBeDefined();
    expect(screen.getByRole('img', { name: /Harbour View/ })).toBeDefined();
    expect(screen.queryByText('6.0')).toBeNull();
  });

  it('asks the source for 168 hours when the 7 d range is picked', async () => {
    const dataSource = renderView(BOTH_SITES);
    await screen.findByText('6.0');

    fireEvent.click(screen.getByRole('button', { name: '7 d' }));

    expect(await screen.findByText('6.0')).toBeDefined();
    expect(dataSource.forecastRequests).toEqual([
      { siteId: SUNNYSIDE.id, range: 24 },
      { siteId: SUNNYSIDE.id, range: 168 },
    ]);
    expect(dataSource.actualRequests).toEqual(dataSource.forecastRequests);
    expect(screen.getByRole('button', { name: '7 d' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('says so, and draws nothing, when the site has no forecast', async () => {
    renderView(configWith(new Map([[SUNNYSIDE.id, { forecasts: [], actuals: [] }]])));

    expect(await screen.findByText('No forecast available for this site yet')).toBeDefined();
    expect(screen.queryByRole('img')).toBeNull();
    expect(document.querySelector('svg')).toBeNull();
  });

  it('draws the forecast but flags that nothing was measured in the range', async () => {
    renderView(
      configWith(new Map([[SUNNYSIDE.id, { forecasts: SUNNYSIDE_SERIES.forecasts, actuals: [] }]])),
    );

    expect(await screen.findByText('No measurements recorded in this range')).toBeDefined();
    expect(screen.getByRole('img', { name: /Sunnyside Farm/ })).toBeDefined();
  });

  it('does not flag missing measurements when the range is measured', async () => {
    renderView(BOTH_SITES);

    expect(await screen.findByText('6.0')).toBeDefined();
    expect(screen.queryByText('No measurements recorded in this range')).toBeNull();
  });
});

/** The credit is owed for weather-derived data, not for a successful request. */
describe('SiteDetailView Open-Meteo attribution', () => {
  const states: readonly { readonly name: string; readonly config: StubConfig }[] = [
    {
      name: 'the site list failed',
      config: { ...BOTH_SITES, sites: seriesFailure('listSites: boom') },
    },
    { name: 'the fleet is empty', config: { ...BOTH_SITES, sites: { kind: 'ok', value: [] } } },
    { name: 'the series failed', config: { ...BOTH_SITES, seriesError: 'siteForecasts: boom' } },
    { name: 'the site has no forecast', config: configWith(new Map()) },
    { name: 'the chart is drawn', config: BOTH_SITES },
  ];

  it.each(states)('credits Open-Meteo when $name', async ({ config }) => {
    renderView(config);

    expect(await attributionHref()).toBe('https://open-meteo.com/');
  });
});
