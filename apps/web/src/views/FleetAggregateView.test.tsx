// @vitest-environment jsdom

import {
  utcIsoTimestampSchema,
  type Forecast,
  type GenerationReading,
  type Site,
  type UncertaintyBand,
  type UtcIsoTimestamp,
} from '@cumulo/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { DataResult, FleetDataProvider, RangeHours } from '../data/provider';
import { FleetAggregateView, joinFleetSeries } from './FleetAggregateView';

// Vitest runs without global test hooks, so Testing Library's automatic cleanup never registers
// itself — every render has to be torn down explicitly or later queries match two views.
afterEach(cleanup);

const LOADING_PATTERN = /Loading the fleet aggregate/u;
const MISSING = '—';

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

const SITES: readonly Site[] = [site(SITE_A_ID, 'Ashford Row'), site(SITE_B_ID, 'Brambling Way')];

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

/**
 * Two sites over two hours, with numbers chosen so every fleet total is unmistakable:
 * 06:00 sums to 6 kW (P10 4, P90 9) and 07:00 to 8 kW (P10 6, P90 11), measured only at 06:00.
 */
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

/** The canned answers to the three calls the fleet view makes. */
interface StubFleet {
  readonly sites: DataResult<readonly Site[]>;
  readonly forecasts: DataResult<readonly Forecast[]>;
  readonly actuals: DataResult<readonly GenerationReading[]>;
}

const ready = <T,>(data: T): DataResult<T> => ({ status: 'ready', data });

const FULL_FLEET: StubFleet = {
  sites: ready(SITES),
  forecasts: ready(FORECASTS),
  actuals: ready(ACTUALS),
};

/** 07:00 loses site B, so that hour aggregates one of the fleet's two sites and 06:00 keeps both. */
const PARTIAL_FLEET: StubFleet = {
  ...FULL_FLEET,
  forecasts: ready(
    FORECASTS.filter(
      (forecast) => !(forecast.siteId === SITE_B_ID && forecast.validTime === timestamp(7)),
    ),
  ),
};

const EMPTY_FLEET: StubFleet = { sites: ready([]), forecasts: ready([]), actuals: ready([]) };

const FORECASTLESS_FLEET: StubFleet = { ...FULL_FLEET, forecasts: ready([]) };

const FAILED_FLEET: StubFleet = {
  ...FULL_FLEET,
  forecasts: { status: 'failed', error: 'fleetForecasts range=24: upstream timed out' },
};

/**
 * A `FleetDataProvider` over canned results, recording the ranges it was asked for.
 *
 * A class rather than a `createStubProvider(canned)` closure factory (`structure.md` rule 2): the
 * members genuinely share the canned data and the recorded ranges, and `this.` is what makes that
 * sharing visible. The members are arrow properties because the interface's are — the view detaches
 * `provider.listSites` and passes it straight to a hook.
 */
class StubProvider implements FleetDataProvider {
  readonly forecastRanges: RangeHours[] = [];

  constructor(private readonly canned: StubFleet) {}

  readonly listSites = (): Promise<DataResult<readonly Site[]>> =>
    Promise.resolve(this.canned.sites);

  readonly fleetForecasts = (range: RangeHours): Promise<DataResult<readonly Forecast[]>> => {
    this.forecastRanges.push(range);
    return Promise.resolve(this.canned.forecasts);
  };

  readonly fleetActuals = (): Promise<DataResult<readonly GenerationReading[]>> =>
    Promise.resolve(this.canned.actuals);

  // Per-site data is not this view's surface; being called for it is a bug worth a loud crash
  // rather than a `failed` result the view would render as an ordinary upstream problem.
  readonly siteForecasts = (): Promise<DataResult<readonly Forecast[]>> => {
    throw new Error('StubProvider: the fleet view must not call siteForecasts');
  };

  readonly siteActuals = (): Promise<DataResult<readonly GenerationReading[]>> => {
    throw new Error('StubProvider: the fleet view must not call siteActuals');
  };
}

const renderSettled = async (provider: FleetDataProvider): Promise<HTMLElement> => {
  const { container } = render(<FleetAggregateView provider={provider} />);
  await waitFor(() => {
    expect(screen.queryByText(LOADING_PATTERN)).toBeNull();
  });
  return container;
};

const tableRowValues = (container: HTMLElement): readonly (readonly (string | null)[])[] =>
  [...container.querySelectorAll('.forecast-chart-table tbody tr')].map((row) =>
    [...row.querySelectorAll('td')].map((cell) => cell.textContent),
  );

const attributionHref = (): string | null =>
  screen.getByRole('link', { name: 'Open-Meteo.com' }).getAttribute('href');

describe('FleetAggregateView', () => {
  it('says it is loading, with the credit already in place, before the provider answers', async () => {
    const provider = new StubProvider(FULL_FLEET);
    render(<FleetAggregateView provider={provider} />);

    expect(screen.getByText(LOADING_PATTERN).textContent).toBe('Loading the fleet aggregate…');
    expect(attributionHref()).toBe('https://open-meteo.com/');

    await waitFor(() => {
      expect(screen.queryByText(LOADING_PATTERN)).toBeNull();
    });
  });

  it('shows the shared aggregation totals — summed median and summed P10/P90 — in the table twin', async () => {
    const container = await renderSettled(new StubProvider(FULL_FLEET));

    // 2 + 4 and 3 + 5 kW medians; bands 1–3 with 3–6, and 2–4 with 4–7. Nothing in the component
    // computes these: they are the shared aggregation's output, rendered.
    expect(tableRowValues(container)).toEqual([
      ['4.0', '6.0', '9.0', '5.0'],
      ['6.0', '8.0', '11.0', MISSING],
    ]);
  });

  it('states the fleet size when every displayed hour has the whole fleet in it', async () => {
    await renderSettled(new StubProvider(FULL_FLEET));

    expect(screen.getByText(/Aggregated from/u).textContent).toBe('Aggregated from 2 sites');
    expect(screen.queryByText(/Partial aggregate/u)).toBeNull();
  });

  it('labels the aggregate partial, with both counts, when an hour is missing a site', async () => {
    await renderSettled(new StubProvider(PARTIAL_FLEET));

    expect(screen.getByText(/Partial aggregate/u).textContent).toBe(
      'Partial aggregate: some hours include only 1 of 2 sites.',
    );
    expect(screen.queryByText(/Aggregated from/u)).toBeNull();
  });

  it('still draws the chart when the aggregate is partial, rather than withholding it', async () => {
    const container = await renderSettled(new StubProvider(PARTIAL_FLEET));

    // Both hours are still plotted; 07:00 simply carries site A alone.
    expect(tableRowValues(container)).toEqual([
      ['4.0', '6.0', '9.0', '5.0'],
      ['2.0', '3.0', '4.0', MISSING],
    ]);
  });

  it('explains an empty fleet instead of drawing a chart of nothing', async () => {
    const container = await renderSettled(new StubProvider(EMPTY_FLEET));

    expect(screen.getByText('No active sites yet')).toBeDefined();
    expect(container.querySelector('svg')).toBeNull();
    expect(attributionHref()).toBe('https://open-meteo.com/');
  });

  it('explains a fleet with sites but no forecast hours', async () => {
    const container = await renderSettled(new StubProvider(FORECASTLESS_FLEET));

    expect(screen.getByText('No fleet forecast available for this range yet')).toBeDefined();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('shows the provider failure verbatim, framed by the surface that failed', async () => {
    await renderSettled(new StubProvider(FAILED_FLEET));

    expect(screen.getByText(/Could not load the fleet aggregate/u).textContent).toBe(
      'Could not load the fleet aggregate: fleetForecasts range=24: upstream timed out',
    );
  });

  it('asks the provider for 168 hours when the 7 d control is pressed', async () => {
    const provider = new StubProvider(FULL_FLEET);
    await renderSettled(provider);

    expect(provider.forecastRanges).toEqual([24]);

    fireEvent.click(screen.getByRole('button', { name: '7 d' }));

    await waitFor(() => {
      expect(provider.forecastRanges).toEqual([24, 168]);
    });
    expect(screen.getByRole('button', { name: '7 d' }).getAttribute('aria-pressed')).toBe('true');
  });

  it.each<[string, StubFleet]>([
    ['a full aggregate', FULL_FLEET],
    ['a partial aggregate', PARTIAL_FLEET],
    ['an empty fleet', EMPTY_FLEET],
    ['a provider failure', FAILED_FLEET],
  ])('credits Open-Meteo when showing %s', async (_label, canned) => {
    await renderSettled(new StubProvider(canned));

    expect(attributionHref()).toBe('https://open-meteo.com/');
  });
});

describe('joinFleetSeries', () => {
  it('carries the fleet band onto the chart point', () => {
    const joined = joinFleetSeries(
      [
        {
          validTime: timestamp(6),
          acPowerKw: 6,
          uncertainty: band(4, 9),
          contributingSiteCount: 2,
        },
      ],
      [],
    );

    expect(joined).toEqual([
      {
        validTimeIso: '2026-07-30T06:00:00Z',
        medianKw: 6,
        band: { p10Kw: 4, p90Kw: 9 },
        actualKw: null,
      },
    ]);
  });

  it('joins a measurement to its own hour and leaves an unmeasured hour null', () => {
    const joined = joinFleetSeries(
      [
        { validTime: timestamp(6), acPowerKw: 6, contributingSiteCount: 2 },
        { validTime: timestamp(7), acPowerKw: 8, contributingSiteCount: 2 },
      ],
      [{ validTime: timestamp(6), acPowerKw: 5, contributingSiteCount: 2 }],
    );

    expect(joined.map((point) => point.actualKw)).toEqual([5, null]);
  });

  it('omits the band key entirely for an hour with no uncertainty', () => {
    const joined = joinFleetSeries(
      [{ validTime: timestamp(6), acPowerKw: 6, contributingSiteCount: 2 }],
      [],
    );

    expect(joined.filter((point) => 'band' in point)).toEqual([]);
  });

  it('drops a measurement whose hour has no forecast point, keeping the forecast x-domain', () => {
    const joined = joinFleetSeries(
      [{ validTime: timestamp(6), acPowerKw: 6, contributingSiteCount: 2 }],
      [
        { validTime: timestamp(6), acPowerKw: 5, contributingSiteCount: 2 },
        { validTime: timestamp(5), acPowerKw: 1, contributingSiteCount: 1 },
      ],
    );

    expect(joined.map((point) => point.validTimeIso)).toEqual(['2026-07-30T06:00:00Z']);
  });
});
