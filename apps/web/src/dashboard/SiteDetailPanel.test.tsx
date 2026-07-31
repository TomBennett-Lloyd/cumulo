// @vitest-environment jsdom

import type { Forecast, Site } from '@cumulo/shared';
import { forecastSchema } from '@cumulo/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SiteDetailPanel } from './SiteDetailPanel';

afterEach(cleanup);

const SITE_ID = '2a2b2f3c-0000-4000-8000-000000000001';

const site: Site = {
  id: SITE_ID,
  name: 'Rathmines rooftop',
  latitude: 53.3244,
  longitude: -6.2657,
  tiltDegrees: 35,
  azimuthDegrees: 180,
  capacityKw: 4.25,
};

interface ForecastFixtureOptions {
  readonly hourUtc: number;
  readonly acPowerKw: number;
  readonly uncertainty?: { readonly p10AcPowerKw: number; readonly p90AcPowerKw: number };
}

/**
 * Built through `forecastSchema.parse` rather than as a cast: `validTime` and
 * `issuedAt` are branded, so a hand-written literal could not be a `Forecast`
 * without an assertion, and parsing means the fixture is exactly the shape the
 * real source hands the panel.
 */
const forecastFixture = ({ hourUtc, acPowerKw, uncertainty }: ForecastFixtureOptions): Forecast =>
  forecastSchema.parse({
    siteId: SITE_ID,
    model: 'physics',
    validTime: `2026-07-31T${String(hourUtc).padStart(2, '0')}:00:00Z`,
    issuedAt: '2026-07-31T09:00:00Z',
    weatherSource: 'open-meteo',
    poaIrradianceWm2: 420,
    acPowerKw,
    uncertainty,
  });

const pointEstimates: readonly Forecast[] = [
  forecastFixture({ hourUtc: 10, acPowerKw: 1.5 }),
  forecastFixture({ hourUtc: 11, acPowerKw: 2.25 }),
  forecastFixture({ hourUtc: 12, acPowerKw: 3 }),
];

const withUncertainty: readonly Forecast[] = [
  forecastFixture({
    hourUtc: 10,
    acPowerKw: 1.5,
    uncertainty: { p10AcPowerKw: 1, p90AcPowerKw: 2 },
  }),
  forecastFixture({
    hourUtc: 11,
    acPowerKw: 2.25,
    uncertainty: { p10AcPowerKw: 1.75, p90AcPowerKw: 3 },
  }),
];

describe('SiteDetailPanel', () => {
  it('names the site and states its physical configuration', () => {
    render(
      <SiteDetailPanel
        site={site}
        forecast={{ status: 'ready', forecasts: pointEstimates }}
        onClose={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Rathmines rooftop' })).not.toBeNull();
    expect(screen.getByText('53.3244, -6.2657')).not.toBeNull();
    expect(screen.getByText('35°')).not.toBeNull();
    expect(screen.getByText('180°')).not.toBeNull();
    expect(screen.getByText('4.3 kW')).not.toBeNull();
  });

  it('reports the wait, and shows no forecast numbers, while the first forecast is pending', () => {
    render(
      <SiteDetailPanel
        site={site}
        forecast={{ status: 'pending', elapsedSeconds: 18 }}
        onClose={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByRole('status').textContent).toBe('Generating first forecast… 18s');
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows why the forecast failed and offers a retry that calls back', () => {
    const onRetry = vi.fn<() => void>();
    render(
      <SiteDetailPanel
        site={site}
        forecast={{ status: 'failed', reason: 'timeout', message: 'Still no forecast after 90s' }}
        onClose={vi.fn()}
        onRetry={onRetry}
      />,
    );

    expect(screen.getByRole('alert').textContent).toContain('Still no forecast after 90s');

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders one table row per forecast hour', () => {
    render(
      <SiteDetailPanel
        site={site}
        forecast={{ status: 'ready', forecasts: pointEstimates }}
        onClose={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    // One header row plus one row per forecast hour.
    expect(screen.getAllByRole('row')).toHaveLength(4);
    expect(screen.getByText('10:00')).not.toBeNull();
    expect(screen.getByText('2.25')).not.toBeNull();
  });

  it('adds the p10–p90 column when the forecasts carry an uncertainty band', () => {
    render(
      <SiteDetailPanel
        site={site}
        forecast={{ status: 'ready', forecasts: withUncertainty }}
        onClose={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getAllByRole('columnheader')).toHaveLength(3);
    expect(screen.getByText('1.00–2.00')).not.toBeNull();
    expect(screen.getByText('1.75–3.00')).not.toBeNull();
  });

  // A column of em dashes would read as data that went missing, rather than as
  // a model that does not emit quantiles (physics v1, #12).
  it('omits the p10–p90 column entirely when no hour carries a band', () => {
    render(
      <SiteDetailPanel
        site={site}
        forecast={{ status: 'ready', forecasts: pointEstimates }}
        onClose={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    const headers = screen.getAllByRole('columnheader').map((header) => header.textContent);

    expect(headers).toEqual(['Hour (UTC)', 'Output (kW)']);
    expect(screen.queryByText('—')).toBeNull();
  });

  // CC BY 4.0 licence condition, not a courtesy (CLAUDE.md, hard constraints).
  // Asserted on the pending arm because that is the arm where a credit tied to
  // rendered numbers would go missing.
  it('carries the Open-Meteo credit even before any forecast exists', () => {
    render(
      <SiteDetailPanel
        site={site}
        forecast={{ status: 'pending', elapsedSeconds: 3 }}
        onClose={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    const credit = screen.getByRole('link', { name: 'Open-Meteo.com' });

    expect(credit.getAttribute('href')).toBe('https://open-meteo.com/');
  });

  it('closes on request', () => {
    const onClose = vi.fn<() => void>();
    render(
      <SiteDetailPanel
        site={site}
        forecast={{ status: 'ready', forecasts: pointEstimates }}
        onClose={onClose}
        onRetry={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
