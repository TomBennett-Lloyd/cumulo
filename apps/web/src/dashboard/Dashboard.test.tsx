// @vitest-environment jsdom

import type { CreateSiteInput, Forecast, Site } from '@cumulo/shared';
import { canonicalFleetSeed, generateFleet } from '@cumulo/shared';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CREATION_WINDOW_MS } from '../add-site/creation-throttle';
import { DemoFleetDataSource } from '../data/demo-fleet-data-source';
import type { DataResult, FleetDataSource } from '../data/fleet-data-source';
import { Dashboard } from './Dashboard';
import type { MapRegionProps } from './MapRegion';

/*
 * The dashboard, proven without WebGL.
 *
 * jsdom implements no WebGL, so the real `MapRegion` cannot mount here — which
 * is why `Dashboard` takes the map region as a prop and this file passes a plain
 * stand-in (see `MapRegion.tsx` for the seam's reasoning). The stand-in is not a
 * mock of maplibre and nothing below asserts that it was called: it is a second
 * way to reach the same two callbacks the real map calls, and every assertion is
 * about what the *dashboard* then does. That the real map fires those callbacks
 * at all is browser behaviour, and is checked in a browser.
 */

/** Where the stand-in's simulated click lands: the Irish Sea, inside the fleet's framing. */
const CLICK_POSITION = { latitude: 53.5, longitude: -5.5 };

/** The demo pipeline's own first-forecast latency, which this suite does not override. */
const DEMO_FIRST_FORECAST_DELAY_MS = 45_000;

/** The ticket's promise: a site added is a site with a visible forecast inside a minute. */
const CREATION_TO_FORECAST_BUDGET_MS = 60_000;

/** The hook's deadline, after which a first forecast stops being worth waiting for. */
const FIRST_FORECAST_DEADLINE_MS = 90_000;

/** Fine enough to date the forecast's arrival to the second it became visible. */
const CLOCK_STEP_MS = 1_000;

const StubMapRegion = ({
  sites,
  selectedSiteId,
  onSelectSite,
  onMapClick,
}: MapRegionProps): ReactElement => (
  <div>
    <button
      type="button"
      onClick={() => {
        onMapClick(CLICK_POSITION);
      }}
    >
      Click the map
    </button>

    {sites.map((site) => (
      <button
        key={site.id}
        type="button"
        aria-current={site.id === selectedSiteId ? true : undefined}
        onClick={() => {
          onSelectSite(site.id);
        }}
      >
        Marker: {site.name}
      </button>
    ))}
  </div>
);

/**
 * A fleet that cannot be listed the first time and can thereafter.
 *
 * The listing is the only behaviour it owns; everything else is the demo fleet,
 * because the failure being tested is "the list did not arrive", not "the fleet
 * is broken". A class rather than a factory over captured counters
 * (`structure.md` rule 2): the attempt count and the underlying fleet are state
 * the three methods share.
 */
class FlakyFleetSource implements FleetDataSource {
  private listAttempts = 0;
  private readonly fleet = new DemoFleetDataSource();

  listSites(): Promise<DataResult<readonly Site[]>> {
    this.listAttempts += 1;

    return this.listAttempts === 1
      ? Promise.resolve({
          kind: 'error',
          error: { code: 'network', message: 'Fleet API unreachable' },
        })
      : this.fleet.listSites();
  }

  createSite(input: CreateSiteInput): Promise<DataResult<Site>> {
    return this.fleet.createSite(input);
  }

  getSiteForecast(siteId: Site['id']): Promise<DataResult<readonly Forecast[]>> {
    return this.fleet.getSiteForecast(siteId);
  }
}

/** A site the demo fleet is guaranteed to contain — same seed, same first entry. */
const firstSeededSite = (): Site => {
  const [site] = generateFleet(canonicalFleetSeed);

  if (site === undefined) {
    throw new Error('The canonical demo fleet is empty; every test here depends on it.');
  }

  return site;
};

/** Moves the fake clock and lets React commit whatever that produced, as one step. */
const advanceBy = async (ms: number): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

/** Lets already-resolved promises (the listing, a creation) settle without moving the clock. */
const settle = (): Promise<void> => advanceBy(0);

const renderDashboard = (dataSource: FleetDataSource): void => {
  render(<Dashboard theme="light" dataSource={dataSource} mapRegion={StubMapRegion} />);
};

const fleetList = (): HTMLElement => screen.getByRole('list', { name: 'Fleet sites' });

const forecastTable = (): HTMLElement | null =>
  screen.queryByRole('table', { name: 'Forecast AC output by hour' });

const clickMap = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'Click the map' }));
};

const submitDraft = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'Add site' }));
};

/** Clicks the map, submits the pre-filled draft, and lets the creation settle. */
const addSite = async (): Promise<void> => {
  clickMap();
  submitDraft();
  await settle();
};

beforeEach(() => {
  // Every wait in this suite — the pipeline's 45 seconds, the poll cadence, the
  // 90-second deadline, the throttle's minute — is simulated. Nothing sleeps.
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Dashboard', () => {
  it('lists the whole fleet on mount and never lists it again', async () => {
    const dataSource = new DemoFleetDataSource();
    const listSites = vi.spyOn(dataSource, 'listSites');
    renderDashboard(dataSource);

    await settle();

    expect(within(fleetList()).getAllByRole('listitem')).toHaveLength(60);

    // The fan-out rule from ADR 0002's review of this ticket: the fleet is read
    // once. A dashboard that re-listed on a cadence would show up here as a
    // second call, and in production as three tabs saturating the table.
    await advanceBy(CREATION_TO_FORECAST_BUDGET_MS);

    expect(listSites).toHaveBeenCalledTimes(1);
  });

  it('opens the detail panel for a site selected on the map, and marks its row', async () => {
    const site = firstSeededSite();
    renderDashboard(new DemoFleetDataSource());
    await settle();

    fireEvent.click(screen.getByRole('button', { name: `Marker: ${site.name}` }));

    expect(screen.getByRole('heading', { name: site.name })).toBeDefined();
    expect(
      within(fleetList())
        .getByRole('button', { name: (name) => name.startsWith(site.name) })
        .getAttribute('aria-current'),
    ).toBe('true');
  });

  it('marks the map marker for a site selected in the list', async () => {
    const site = firstSeededSite();
    renderDashboard(new DemoFleetDataSource());
    await settle();

    fireEvent.click(
      within(fleetList()).getByRole('button', { name: (name) => name.startsWith(site.name) }),
    );

    expect(
      screen.getByRole('button', { name: `Marker: ${site.name}` }).getAttribute('aria-current'),
    ).toBe('true');
  });

  it('shows an added site its own forecast within a minute of creating it', async () => {
    renderDashboard(new DemoFleetDataSource());
    await settle();

    clickMap();
    const submittedAtMs = Date.now();
    submitDraft();
    await settle();

    // The site exists and is selected; its forecast does not exist yet, and the
    // panel says so rather than showing an empty table.
    expect(screen.getByRole('status').textContent).toContain('Generating first forecast');
    expect(forecastTable()).toBeNull();

    // Stops at the first second the forecast is on screen, so the elapsed time
    // below is when it *became* visible rather than when this test looked.
    while (
      forecastTable() === null &&
      Date.now() - submittedAtMs < CREATION_TO_FORECAST_BUDGET_MS
    ) {
      await advanceBy(CLOCK_STEP_MS);
    }

    const table = forecastTable();

    if (table === null) {
      throw new Error(
        `No forecast ${String(Date.now() - submittedAtMs)}ms after the site was created.`,
      );
    }

    // The timed check, as a number rather than as "it shows up eventually" —
    // and bounded below too, so a demo source that answered instantly could not
    // pass this by never exercising the pending state at all.
    expect(Date.now() - submittedAtMs).toBeLessThanOrEqual(CREATION_TO_FORECAST_BUDGET_MS);
    expect(Date.now() - submittedAtMs).toBeGreaterThanOrEqual(DEMO_FIRST_FORECAST_DELAY_MS);
    expect(within(table).getAllByRole('row').length).toBeGreaterThan(1);
  });

  it('watches the site id the fleet assigned, never one of its own making', async () => {
    const dataSource = new DemoFleetDataSource();
    const getSiteForecast = vi.spyOn(dataSource, 'getSiteForecast');
    renderDashboard(dataSource);
    await settle();

    await addSite();

    const listed = await dataSource.listSites();

    if (listed.kind !== 'ok') {
      throw new Error('The demo fleet refused to list its own sites.');
    }

    const created = listed.value.at(-1);

    if (created === undefined) {
      throw new Error('The demo fleet is empty after a site was created.');
    }

    // The id polled for is the one the source minted and returned. A dashboard
    // that predicted an id locally would be polling a site that does not exist,
    // and would wait out the whole deadline on it.
    expect(created.name).toBe('Site at 53.5000, -5.5000');
    expect(getSiteForecast).toHaveBeenCalledWith(created.id);
    expect(within(fleetList()).getAllByRole('listitem')).toHaveLength(61);
  });

  it('refuses a fourth site inside the minute and does not send it', async () => {
    const dataSource = new DemoFleetDataSource();
    const createSite = vi.spyOn(dataSource, 'createSite');
    renderDashboard(dataSource);
    await settle();

    // The throttle runs at its shipped limits here — no injected clock, no
    // lowered limit (`testing.md` rule 7). The fake clock never advances during
    // these four attempts, so all four fall inside one window.
    await addSite();
    await addSite();
    await addSite();

    clickMap();
    submitDraft();
    await settle();

    // Refused, not sent — and the button stays live, because the wait it states
    // can only be re-counted by pressing it again (see the recovery test below).
    expect(screen.getByText(/wait \d+s before adding another site/)).toBeDefined();
    expect(createSite).toHaveBeenCalledTimes(3);
    expect(within(fleetList()).getAllByRole('listitem')).toHaveLength(63);
  });

  it('lets a refused visitor through once the window has slid, from the same open form', async () => {
    const dataSource = new DemoFleetDataSource();
    const createSite = vi.spyOn(dataSource, 'createSite');
    renderDashboard(dataSource);
    await settle();

    await addSite();
    await addSite();
    await addSite();

    clickMap();
    submitDraft();
    await settle();

    expect(screen.getByText(/wait \d+s before adding another site/)).toBeDefined();
    expect(createSite).toHaveBeenCalledTimes(3);

    // Nothing re-renders this form on a timer, so if the refusal disabled the
    // button the visitor would sit under a frozen wait forever. Pressing again
    // after the window has slid is the whole recovery path.
    await advanceBy(DEFAULT_CREATION_WINDOW_MS);
    submitDraft();
    await settle();

    expect(createSite).toHaveBeenCalledTimes(4);
    expect(within(fleetList()).getAllByRole('listitem')).toHaveLength(64);
  });

  it('gives up on a first forecast that never arrives, and can be asked again', async () => {
    // A pipeline slower than the deadline — the one knob this test turns, so
    // that the deadline is reachable at all. The shipped delay is what the
    // timed check above runs against.
    renderDashboard(new DemoFleetDataSource({ firstForecastDelayMs: 10 * 60_000 }));
    await settle();

    await addSite();
    await advanceBy(FIRST_FORECAST_DEADLINE_MS);

    const failure = screen.getByRole('alert');

    expect(failure.textContent).toContain('Forecast unavailable');
    expect(forecastTable()).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await settle();

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Generating first forecast');
  });

  it('says why the fleet is missing rather than showing an empty list', async () => {
    renderDashboard(new FlakyFleetSource());
    await settle();

    expect(screen.getByRole('alert').textContent).toContain('Fleet unavailable');
    expect(screen.queryByRole('list', { name: 'Fleet sites' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await settle();

    expect(screen.queryByRole('alert')).toBeNull();
    expect(within(fleetList()).getAllByRole('listitem')).toHaveLength(60);
  });
});
