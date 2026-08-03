// @vitest-environment jsdom

import {
  utcIsoTimestampSchema,
  type Forecast,
  type GenerationReading,
  type Site,
} from '@cumulo/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import type {
  FleetDataSource,
  FleetSourceCapabilities,
  FleetSourceResult,
  RangeHours,
} from '../data/fleet-data-source';
import type { ForecastViewState } from './forecast-view-state';
import { SitePanel } from './SitePanel';

// Vitest runs without global test hooks, so Testing Library's automatic cleanup
// never registers itself.
afterEach(cleanup);

const SITE: Site = {
  id: '2a2b2f3c-0000-4000-8000-000000000001',
  name: 'Rathmines rooftop',
  latitude: 53.3244,
  longitude: -6.2657,
  tiltDegrees: 35,
  azimuthDegrees: 180,
  capacityKw: 4.25,
};

const at = (hour: number) =>
  utcIsoTimestampSchema.parse(`2026-07-31T${hour.toString().padStart(2, '0')}:00:00Z`);

const forecastAt = (hour: number, acPowerKw: number): Forecast => ({
  siteId: SITE.id,
  model: 'physics',
  validTime: at(hour),
  issuedAt: at(9),
  weatherSource: 'open-meteo',
  poaIrradianceWm2: acPowerKw * 100,
  acPowerKw,
  uncertainty: { p10AcPowerKw: acPowerKw - 0.5, p90AcPowerKw: acPowerKw + 0.5 },
});

const readingAt = (hour: number, acPowerKw: number): GenerationReading => ({
  siteId: SITE.id,
  validTime: at(hour),
  acPowerKw,
});

const FORECASTS: readonly Forecast[] = [
  forecastAt(10, 1.5),
  forecastAt(11, 2.25),
  forecastAt(12, 3),
];
const ACTUALS: readonly GenerationReading[] = [readingAt(10, 1.4), readingAt(11, 2.1)];

interface StubConfig {
  readonly forecasts: readonly Forecast[];
  readonly actuals: readonly GenerationReading[];
  /** Non-null makes the forecast half fail, the way an unreachable API would. */
  readonly forecastError: string | null;
  /** Non-null fails *only* the measured half — the pair must still fail as a pair. */
  readonly actualsError: string | null;
}

const FULL_SERIES: StubConfig = {
  forecasts: FORECASTS,
  actuals: ACTUALS,
  forecastError: null,
  actualsError: null,
};

const sourceFailure = (message: string): FleetSourceResult<never> => ({
  kind: 'error',
  error: { code: 'network', message },
});

interface SeriesRequest {
  readonly siteId: string;
  readonly range: RangeHours;
}

/**
 * A hand-rolled `FleetDataSource` — our own interface, so there is nothing to
 * mock. The panel's rendering is what the assertions are about, except for the
 * range control, where the *request* is the behaviour under test (testing.md
 * rule 3), which is why the calls are recorded.
 *
 * A class rather than a factory closing over the recording arrays: `this.` is
 * the visible marker that the records and the answers share state
 * (structure.md rule 2).
 */
class StubFleetSource implements FleetDataSource {
  // Both false: this stub serves one site's series and nothing fleet-level, and
  // the site panel never reads the flags — it aggregates nothing.
  readonly capabilities: FleetSourceCapabilities = { fleetLookback: false, fleetActuals: false };

  readonly forecastRequests: SeriesRequest[] = [];
  readonly actualRequests: SeriesRequest[] = [];
  private readonly config: StubConfig;

  constructor(config: StubConfig) {
    this.config = config;
  }

  readonly siteForecasts = (
    siteId: string,
    range: RangeHours,
  ): Promise<FleetSourceResult<readonly Forecast[]>> => {
    this.forecastRequests.push({ siteId, range });
    return Promise.resolve<FleetSourceResult<readonly Forecast[]>>(
      this.config.forecastError === null
        ? { kind: 'ok', value: this.config.forecasts }
        : sourceFailure(this.config.forecastError),
    );
  };

  readonly siteActuals = (
    siteId: string,
    range: RangeHours,
  ): Promise<FleetSourceResult<readonly GenerationReading[]>> => {
    this.actualRequests.push({ siteId, range });
    return Promise.resolve<FleetSourceResult<readonly GenerationReading[]>>(
      this.config.actualsError === null
        ? { kind: 'ok', value: this.config.actuals }
        : sourceFailure(this.config.actualsError),
    );
  };

  readonly listSites = (): Promise<FleetSourceResult<readonly Site[]>> => {
    throw new Error('StubFleetSource: the site panel is handed its site, it never lists the fleet');
  };

  readonly getSiteForecast = (): Promise<FleetSourceResult<readonly Forecast[]>> => {
    throw new Error('StubFleetSource: the first-forecast poll belongs to the dashboard');
  };

  readonly createSite = (): Promise<FleetSourceResult<Site>> => {
    throw new Error('StubFleetSource: the site panel never writes to the fleet');
  };

  readonly fleetForecasts = (): Promise<FleetSourceResult<readonly Forecast[]>> => {
    throw new Error('StubFleetSource: the site panel never aggregates');
  };

  readonly fleetActuals = (): Promise<FleetSourceResult<readonly GenerationReading[]>> => {
    throw new Error('StubFleetSource: the site panel never aggregates');
  };
}

/**
 * The panel's `ready` arm carries the poll's own snapshot, which this panel
 * deliberately does not draw: it asks for a windowed series of its own instead,
 * so what the arm holds only has to be a truthful "there is a forecast now".
 */
const READY: ForecastViewState = { status: 'ready', forecasts: FORECASTS };

interface PanelHarness {
  readonly dataSource: StubFleetSource;
  readonly onClose: Mock<() => void>;
  readonly onRetryFirstForecast: Mock<() => void>;
}

const renderPanel = (
  firstForecast: ForecastViewState,
  config: StubConfig = FULL_SERIES,
): PanelHarness => {
  const harness: PanelHarness = {
    dataSource: new StubFleetSource(config),
    onClose: vi.fn<() => void>(),
    onRetryFirstForecast: vi.fn<() => void>(),
  };
  render(
    <SitePanel
      dataSource={harness.dataSource}
      site={SITE}
      firstForecast={firstForecast}
      onRetryFirstForecast={harness.onRetryFirstForecast}
      onClose={harness.onClose}
    />,
  );
  return harness;
};

const chart = (): Promise<HTMLElement> =>
  screen.findByRole('img', { name: 'Rathmines rooftop: forecast and measured generation' });

describe('SitePanel', () => {
  it('names the site and states its physical configuration', () => {
    renderPanel(READY);

    expect(screen.getByRole('heading', { name: 'Rathmines rooftop' })).not.toBeNull();
    expect(screen.getByText('53.3244, -6.2657')).not.toBeNull();
    expect(screen.getByText('35°')).not.toBeNull();
    expect(screen.getByText('180°')).not.toBeNull();
    expect(screen.getByText('4.3 kW')).not.toBeNull();
  });

  it('closes on request', () => {
    const { onClose } = renderPanel(READY);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

/** The wait the dashboard's poll owns — before any series is worth asking for. */
describe('SitePanel first forecast', () => {
  it('shows a plain loading label, not the first-forecast count, while checking', () => {
    const { dataSource } = renderPanel({ status: 'checking' });

    const waiting = screen.getByText('Loading the forecast for Rathmines rooftop…');

    expect(waiting.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByText(/Generating first forecast/u)).toBeNull();
    expect(dataSource.forecastRequests).toEqual([]);
  });

  it('counts the wait out loud, and asks the source for nothing yet', () => {
    const { dataSource } = renderPanel({ status: 'generating', elapsedSeconds: 18 });

    const waiting = screen.getByText('Generating first forecast… 18s');

    expect(waiting.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByRole('img')).toBeNull();
    expect(dataSource.forecastRequests).toEqual([]);
  });

  it('says a timeout in the column’s words, not the poll’s diagnostic ones', () => {
    renderPanel({
      status: 'failed',
      reason: 'timeout',
      message: `No forecast for site ${SITE.id} after 90 seconds`,
    });

    expect(screen.getByRole('alert').textContent).toContain(
      'No forecast arrived within 90 seconds',
    );
    expect(screen.queryByText(new RegExp(SITE.id))).toBeNull();
  });

  /*
   * The distinction the reason exists for: this run never heard back, so the
   * sentence beside it — "the pipeline may still be working" — would be an
   * assertion about a pipeline nobody asked successfully. The negative on
   * `pipeline` is what pins that; its positive control is the timeout test
   * directly above, whose copy contains the word.
   */
  it('an unanswered deadline claims nothing about the pipeline, and still offers a retry', () => {
    renderPanel({
      status: 'failed',
      reason: 'unanswered',
      message: `No answer for site ${SITE.id} within 90 seconds`,
    });

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('No answer from the fleet within 90 seconds');
    expect(alert.textContent).not.toContain('pipeline');
    expect(screen.getByRole('button', { name: 'Try again' })).not.toBeNull();
  });

  it('repeats the source’s own account when the fleet answered with a fault', () => {
    renderPanel({ status: 'failed', reason: 'error', message: 'Forecast service unreachable' });

    expect(screen.getByRole('alert').textContent).toContain('Forecast service unreachable');
  });

  it('offers a retry that restarts the wait', () => {
    const { onRetryFirstForecast } = renderPanel({
      status: 'failed',
      reason: 'timeout',
      message: 'timed out',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(onRetryFirstForecast).toHaveBeenCalledTimes(1);
  });

  it('a halted watch explains itself and offers no Try again', () => {
    const message = 'refused by the API — set CUMULO_WEB_ORIGINS; retrying cannot help.';
    renderPanel({ status: 'halted', message });

    expect(screen.getByRole('alert').textContent).toContain(message);
    // The paired positive control for this negative: `offers a retry that
    // restarts the wait`, directly above, finds the button with the same query
    // on the `failed` arm — so a null here is an absent button, not a query
    // that never matches anything.
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});

/** The panel's own wait: one site's series over a window the reader chooses. */
describe('SitePanel series', () => {
  it('draws the forecast for the default window once one exists', async () => {
    const { dataSource } = renderPanel(READY);

    expect(await chart()).not.toBeNull();
    expect(screen.getByRole('group', { name: 'Forecast range' })).not.toBeNull();
    expect(dataSource.forecastRequests).toEqual([{ siteId: SITE.id, range: 24 }]);
  });

  it('asks the source for 168 hours when the 7 d range is picked', async () => {
    const { dataSource } = renderPanel(READY);
    await chart();

    fireEvent.click(screen.getByRole('button', { name: '7 d' }));

    expect(await chart()).not.toBeNull();
    expect(dataSource.forecastRequests).toEqual([
      { siteId: SITE.id, range: 24 },
      { siteId: SITE.id, range: 168 },
    ]);
    expect(dataSource.actualRequests).toEqual(dataSource.forecastRequests);
  });

  it('states a series failure and offers no retry, because the range control is the retry', async () => {
    renderPanel(READY, { ...FULL_SERIES, forecastError: 'siteForecasts: network refused' });

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Could not load the forecast for Rathmines rooftop: siteForecasts: network refused',
    );
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('fails as a pair when only the measured half fails, rather than drawing half a chart', async () => {
    renderPanel(READY, { ...FULL_SERIES, actualsError: 'siteActuals: network refused' });

    expect((await screen.findByRole('alert')).textContent).toContain(
      'siteActuals: network refused',
    );
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('says so, and draws nothing, when the window holds no forecast', async () => {
    renderPanel(READY, { ...FULL_SERIES, forecasts: [], actuals: [] });

    expect(await screen.findByText('No forecast available for this site yet')).not.toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('draws the forecast but flags that nothing was measured in the range', async () => {
    renderPanel(READY, { ...FULL_SERIES, actuals: [] });

    expect(await screen.findByText('No measurements recorded in this range')).not.toBeNull();
    expect(await chart()).not.toBeNull();
  });

  it('does not flag missing measurements when the range is measured', async () => {
    renderPanel(READY);

    expect(await chart()).not.toBeNull();
    expect(screen.queryByText('No measurements recorded in this range')).toBeNull();
  });
});
