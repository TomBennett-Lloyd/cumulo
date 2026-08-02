// @vitest-environment jsdom

import type { CreateSiteInput, Forecast, Site } from '@cumulo/shared';
import { canonicalFleetSeed, generateFleet } from '@cumulo/shared';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CREATION_WINDOW_MS } from '../add-site/creation-throttle';
import { DemoFleetDataSource } from '../data/demo-fleet-data-source';
import type { FleetSourceResult, FleetDataSource } from '../data/fleet-data-source';
import {
  advanceBy,
  fleetPanel,
  renderDashboard,
  scrolledIntoView,
  settle,
  visit,
} from './dashboard-test-fixture';

/*
 * The dashboard's composition, proven without WebGL.
 *
 * The mount, the map stand-in and the clock helpers are
 * `dashboard-test-fixture.tsx`'s — read its header for why a stand-in map is not
 * a mock. What this file asserts is what the *dashboard* does with the two
 * callbacks that stand-in reaches.
 */

/**
 * What `AddSiteForm` names a site dropped at the fixture's `CLICK_POSITION`.
 *
 * Restated here rather than derived, because it is the *form's* naming rule
 * being relied on: a test that computed the name the same way the form does
 * would still pass if both were wrong together.
 */
const CREATED_SITE_NAME = 'Site at 53.5000, -5.5000';

/** The demo pipeline's own first-forecast latency, which this suite does not override. */
const DEMO_FIRST_FORECAST_DELAY_MS = 45_000;

/** The ticket's promise: a site added is a site with a visible forecast inside a minute. */
const CREATION_TO_FORECAST_BUDGET_MS = 60_000;

/** The hook's deadline, after which a first forecast stops being worth waiting for. */
const FIRST_FORECAST_DEADLINE_MS = 90_000;

/** Fine enough to date the forecast's arrival to the second it became visible. */
const CLOCK_STEP_MS = 1_000;

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

  readonly listSites = (): Promise<FleetSourceResult<readonly Site[]>> => {
    this.listAttempts += 1;

    return this.listAttempts === 1
      ? Promise.resolve({
          kind: 'error',
          error: { code: 'network', message: 'Fleet API unreachable' },
        })
      : this.fleet.listSites();
  };

  readonly createSite = (input: CreateSiteInput): Promise<FleetSourceResult<Site>> =>
    this.fleet.createSite(input);

  readonly getSiteForecast = (
    siteId: Site['id'],
  ): Promise<FleetSourceResult<readonly Forecast[]>> => this.fleet.getSiteForecast(siteId);

  // The window-scoped reads belong to the chart views; the dashboard never makes
  // them, so they pass straight through to the demo fleet rather than growing a
  // second set of canned answers here.
  readonly siteForecasts = this.fleet.siteForecasts;
  readonly siteActuals = this.fleet.siteActuals;
  readonly fleetForecasts = this.fleet.fleetForecasts;
  readonly fleetActuals = this.fleet.fleetActuals;

  // Delegated for the same reason as the reads above: those reads *are* the demo fleet's, so the
  // capabilities describing them have to be the demo fleet's too rather than a second claim here.
  readonly capabilities = this.fleet.capabilities;
}

/** A site the demo fleet is guaranteed to contain — same seed, same first entry. */
const firstSeededSite = (): Site => {
  const [site] = generateFleet(canonicalFleetSeed);

  if (site === undefined) {
    throw new Error('The canonical demo fleet is empty; every test here depends on it.');
  }

  return site;
};

const fleetList = (): HTMLElement => screen.getByRole('list', { name: 'Fleet sites' });

/**
 * The site panel's chart, once one is drawn — the panel's own ready state.
 *
 * Queried by the chart's table twin rather than by its SVG because the rows are
 * what the assertions below count, and because the caption names the site: the
 * fleet panel draws a chart too, and a query that matched any chart would go
 * green on the wrong one the day the fleet panel stopped being hidden.
 */
const siteChartTable = (siteName: string): HTMLElement | null =>
  screen.queryByRole('table', { name: `Table view — ${siteName}, kW` });

const attributionLinks = (): readonly HTMLElement[] =>
  screen.getAllByRole('link', { name: 'Open-Meteo.com' });

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
  // Selecting a site writes `?site=` into this environment's address bar, and
  // the dashboard reads that at mount — so a test that left one there would
  // hand the next test a selection it never made.
  visit('/');
});

describe('Dashboard', () => {
  it('first paint mounts zero live regions', async () => {
    // `react.md`'s async surface convention as a property of the whole
    // composition rather than of one panel: a wait is `aria-busy`, and an alert
    // reaches a reader only by arriving as a change to a tree already on screen.
    // Asserted *before* `settle()`, because first paint is the one moment at
    // which nothing has resolved and every panel is still waiting.
    //
    // The known limit: the stub map region stands in for the real placeholder,
    // whose own zero-live-region property is `MapSurface.test.tsx`'s. The
    // shipping composition — real map shell included — is #107's browser harness.
    const container = renderDashboard(new DemoFleetDataSource());

    expect(container.querySelectorAll('[role="status"], [role="alert"], [aria-live]')).toHaveLength(
      0,
    );

    // Settled here so the listing this mount started resolves inside the test.
    await settle();
  });

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

  it('swaps the fleet panel for the panel of a site selected on the map, and marks its row', async () => {
    const site = firstSeededSite();
    const container = renderDashboard(new DemoFleetDataSource());
    await settle();

    expect(fleetPanel(container)?.hasAttribute('hidden')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: `Marker: ${site.name}` }));

    expect(fleetPanel(container)?.hasAttribute('hidden')).toBe(true);
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
    // panel says so rather than showing an empty chart. The wait is a plain
    // `aria-busy` label, not a live region mounted with its text already inside
    // it (`react.md`, "Async surface convention") — so it is found by its words.
    expect(screen.getByText(/Generating first forecast/u)).toBeDefined();
    expect(siteChartTable(CREATED_SITE_NAME)).toBeNull();

    // Stops at the first second the forecast is on screen, so the elapsed time
    // below is when it *became* visible rather than when this test looked.
    while (
      siteChartTable(CREATED_SITE_NAME) === null &&
      Date.now() - submittedAtMs < CREATION_TO_FORECAST_BUDGET_MS
    ) {
      await advanceBy(CLOCK_STEP_MS);
    }

    const table = siteChartTable(CREATED_SITE_NAME);

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
    expect(created.name).toBe(CREATED_SITE_NAME);
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

    // The column's own sentence, not the poll's diagnostic one: nothing went
    // wrong, the pipeline is behind, and what the reader can do about it is
    // wait longer.
    expect(failure.textContent).toContain('No forecast arrived within 90 seconds');
    expect(siteChartTable(CREATED_SITE_NAME)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await settle();

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(/Generating first forecast/u)).toBeDefined();
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

/*
 * The context swap: one region of the column, three things that can occupy it.
 *
 * These are assertions about *which* context is on screen and about what that
 * costs, which is why several of them read the `hidden` attribute directly. The
 * distinction the design turns on — hidden versus unmounted — is invisible to a
 * role query, because a `hidden` subtree is out of the accessibility tree
 * either way. Only the DOM can say whether the panel is still there behind it,
 * and "still there" is the whole point.
 */
describe('Dashboard context region', () => {
  it('gives the region back on close, without re-summing a fleet it never lost', async () => {
    const site = firstSeededSite();
    const dataSource = new DemoFleetDataSource();
    // Counted on the real source rather than through a canned one: what is
    // under test is how many fan-outs the *composition* spends, so the calls
    // have to be the ones the shipping panel actually makes.
    const fleetForecasts = vi.spyOn(dataSource, 'fleetForecasts');
    const container = renderDashboard(dataSource);
    await settle();

    expect(fleetForecasts).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: `Marker: ${site.name}` }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await settle();

    expect(fleetPanel(container)?.hasAttribute('hidden')).toBe(false);
    expect(screen.queryByRole('heading', { name: site.name })).toBeNull();
    // One sum across the whole select-and-close round trip. In live mode a
    // second one is a paced fan-out of one request per site — which is what
    // keeping the panel mounted buys, and what an unmount on every deselection
    // would spend.
    expect(fleetForecasts).toHaveBeenCalledTimes(1);
  });

  it('lets a draft take the region without losing the site the reader had open', async () => {
    const site = firstSeededSite();
    const container = renderDashboard(new DemoFleetDataSource());
    await settle();

    fireEvent.click(screen.getByRole('button', { name: `Marker: ${site.name}` }));

    expect(screen.getByRole('heading', { name: site.name })).toBeDefined();

    clickMap();

    // The draft outranks both the site and the fleet, and neither is unmounted
    // *because* it was outranked — the selection survives underneath it.
    expect(screen.queryByRole('heading', { name: site.name })).toBeNull();
    expect(fleetPanel(container)?.hasAttribute('hidden')).toBe(true);
    expect(screen.getByRole('button', { name: 'Add site' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    // Cancelling hands the reader back the site they were reading, not the
    // fleet they had left. A dashboard that cleared the selection when a draft
    // opened would land on the fleet panel here.
    expect(screen.getByRole('heading', { name: site.name })).toBeDefined();
    expect(fleetPanel(container)?.hasAttribute('hidden')).toBe(true);
  });

  it('scrolls the column to the region a context takes, and leaves it alone on close', async () => {
    const site = firstSeededSite();
    const container = renderDashboard(new DemoFleetDataSource());
    await settle();

    const contextRegion = container.querySelector('.dashboard-context');

    /*
     * What this pins is the dashboard's half of the mechanism: that a context arriving is what
     * triggers the scroll, that the element scrolled is the context region rather than the column
     * or the list, and that closing triggers nothing. jsdom has no layout, so the scroll itself is
     * a stand-in (`dashboard-test-fixture.tsx`) and the pixels are a browser criterion — a reader
     * who has scrolled the column down to the site list and clicks a marker can see the site panel
     * without scrolling back up.
     *
     * The fleet at rest is not a swap: the region is already showing it, so nothing moves.
     */
    expect(scrolledIntoView()).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: `Marker: ${site.name}` }));

    expect(scrolledIntoView()).toEqual([contextRegion]);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    // Closing hands the same region back to the fleet. A column that jumped on the way out would
    // move ground the reader did not ask to move, so the count stands still here.
    expect(scrolledIntoView()).toEqual([contextRegion]);

    clickMap();

    // A draft is the other way into the region, and it arrives the same way for the reader.
    expect(scrolledIntoView()).toEqual([contextRegion, contextRegion]);
  });

  it('re-sums the fleet when a site is added to it', async () => {
    const dataSource = new DemoFleetDataSource();
    const fleetForecasts = vi.spyOn(dataSource, 'fleetForecasts');
    renderDashboard(dataSource);
    await settle();

    expect(fleetForecasts).toHaveBeenCalledTimes(1);

    await addSite();

    // Creation is the one event that changes the sum, so it is the one event
    // that re-spends the fan-out.
    expect(fleetForecasts).toHaveBeenCalledTimes(2);
  });
});

/*
 * The column's credit, in every state the column can be in.
 *
 * The map's own strip is absent here — `StubMapRegion` renders no attribution —
 * so a count of one is a count of the column's footer alone, and these tests
 * would fail if the credit had been left inside a panel that comes and goes.
 */
describe('Dashboard attribution', () => {
  it('keeps exactly one credit at the foot of the column in every fleet state', async () => {
    // One render walked through all three states rather than three renders of
    // one state each: the credit's whole job is to *survive*, and a footer that
    // renders correctly from a fresh mount can still be lost on a transition.
    // `FlakyFleetSource` is what makes the walk possible — loading, then a
    // failed listing, then a retried one that succeeds.
    renderDashboard(new FlakyFleetSource());

    expect(attributionLinks()).toHaveLength(1);

    await settle();

    expect(screen.getByRole('alert').textContent).toContain('Fleet unavailable');
    expect(attributionLinks()).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await settle();

    expect(within(fleetList()).getAllByRole('listitem')).toHaveLength(60);
    expect(attributionLinks()).toHaveLength(1);
  });
});
