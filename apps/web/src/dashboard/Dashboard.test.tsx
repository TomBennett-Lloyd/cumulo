// @vitest-environment jsdom

import type { CreateSiteInput, Forecast, Site } from '@cumulo/shared';
import { canonicalFleetSeed, generateFleet } from '@cumulo/shared';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CREATION_WINDOW_MS } from '../add-site/creation-throttle';
import { DemoFleetDataSource } from '../data/demo-fleet-data-source';
import type { FleetSourceResult, FleetDataSource } from '../data/fleet-data-source';
import {
  addSite,
  advanceBy,
  armAddSite,
  clickBasemap,
  clickMap,
  CREATED_SITE_NAME,
  fleetChartTable,
  fleetRows,
  fleetTable,
  fleetPanel,
  renderDashboard,
  settle,
  sitePopover,
  submitDraft,
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

/**
 * The selected site's own line on the fleet chart, once one is drawn.
 *
 * There is one chart on this page now, and a selected site reaches it as a
 * second series rather than as a chart of its own (#265). The series is readable
 * as text in the chart's table twin, where it is a column headed with the site's
 * name — so this is both "the site's forecast is on screen" and "it is on screen
 * *as this site*", which a bare count of charts would not be.
 */
const siteOverlayColumn = (siteName: string): HTMLElement | null =>
  screen.queryByRole('columnheader', { name: siteName });

const attributionLinks = (): readonly HTMLElement[] =>
  screen.getAllByRole('link', { name: 'Open-Meteo.com' });

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
    // whose own zero-live-region property is `MapSurface.test.tsx`'s. Nothing
    // asserts the property on the shipping composition, real map shell
    // included. That is the browser lane's kind of work and the lane now exists
    // — `apps/web/e2e/` (`testing.md` rule 10) — but no spec in it queries
    // `[role="status"]`, `[role="alert"]` or `[aria-live]` today, so the two
    // halves above are the whole of the coverage this property has.
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

    expect(fleetRows()).toHaveLength(60);

    // The fan-out rule from ADR 0002's review of this ticket: the fleet is read
    // once. A dashboard that re-listed on a cadence would show up here as a
    // second call, and in production as three tabs saturating the table.
    await advanceBy(CREATION_TO_FORECAST_BUDGET_MS);

    expect(listSites).toHaveBeenCalledTimes(1);
  });

  it('answers a site selected on the map with its card, and marks its row', async () => {
    const site = firstSeededSite();
    const container = renderDashboard(new DemoFleetDataSource());
    await settle();

    expect(sitePopover(container)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: `Marker: ${site.name}` }));

    expect(sitePopover(container)).not.toBeNull();
    expect(screen.getByRole('heading', { name: site.name })).toBeDefined();
    // And the fleet keeps its place. A selection used to displace this panel;
    // nothing displaces it now, which is what lets the site be drawn *over* the
    // fleet rather than instead of it (#265).
    expect(fleetPanel(container)).not.toBeNull();
    expect(
      within(fleetTable())
        .getByRole('button', { name: (name) => name.startsWith(site.name) })
        .getAttribute('aria-current'),
    ).toBe('true');
  });

  it('marks the map marker for a site selected in the list', async () => {
    const site = firstSeededSite();
    renderDashboard(new DemoFleetDataSource());
    await settle();

    fireEvent.click(
      within(fleetTable()).getByRole('button', { name: (name) => name.startsWith(site.name) }),
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
    // card on the map says so rather than the chart drawing an empty line. The
    // wait is a plain `aria-busy` label, not a live region mounted with its text
    // already inside it (`react.md`, "Async surface convention") — so it is
    // found by its words.
    expect(screen.getByText(/Generating first forecast/u)).toBeDefined();
    expect(siteOverlayColumn(CREATED_SITE_NAME)).toBeNull();

    // Stops at the first second the forecast is on screen, so the elapsed time
    // below is when it *became* visible rather than when this test looked.
    while (
      siteOverlayColumn(CREATED_SITE_NAME) === null &&
      Date.now() - submittedAtMs < CREATION_TO_FORECAST_BUDGET_MS
    ) {
      await advanceBy(CLOCK_STEP_MS);
    }

    if (siteOverlayColumn(CREATED_SITE_NAME) === null) {
      throw new Error(
        `No forecast ${String(Date.now() - submittedAtMs)}ms after the site was created.`,
      );
    }

    // The timed check, as a number rather than as "it shows up eventually" —
    // and bounded below too, so a demo source that answered instantly could not
    // pass this by never exercising the generating state at all.
    expect(Date.now() - submittedAtMs).toBeLessThanOrEqual(CREATION_TO_FORECAST_BUDGET_MS);
    expect(Date.now() - submittedAtMs).toBeGreaterThanOrEqual(DEMO_FIRST_FORECAST_DELAY_MS);
    // Rows, not just a header: a column of nothing would satisfy the wait above
    // while showing the reader no forecast at all.
    expect(within(fleetChartTable()).getAllByRole('row').length).toBeGreaterThan(1);
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
    expect(fleetRows()).toHaveLength(61);
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
    expect(fleetRows()).toHaveLength(63);
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
    expect(fleetRows()).toHaveLength(64);
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
    expect(siteOverlayColumn(CREATED_SITE_NAME)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await settle();

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(/Generating first forecast/u)).toBeDefined();
  });

  it('says why the fleet is missing rather than showing an empty table', async () => {
    renderDashboard(new FlakyFleetSource());
    await settle();

    expect(screen.getByRole('alert').textContent).toContain('Fleet unavailable');
    expect(screen.queryByRole('table', { name: 'Fleet sites' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await settle();

    expect(screen.queryByRole('alert')).toBeNull();
    expect(fleetRows()).toHaveLength(60);
  });
});

/*
 * What a selection costs, and what it leaves alone.
 *
 * The reading under the map used to be a context region that a site could take
 * from the fleet, so this block was about *which* context was on screen. #265
 * moved the site's detail onto its own marker and left the reading as a plain
 * flow, so the questions worth asking here changed shape: what survives a
 * selection, and how many fan-outs the composition spends doing it.
 *
 * The fan-out counts are taken on the real demo source rather than through a
 * canned one, because what is under test is how many requests the *composition*
 * makes — so the calls have to be the ones the shipping panel actually makes.
 */
describe('Dashboard selection', () => {
  it('closes back to the fleet alone, without re-summing a fleet it never lost', async () => {
    const site = firstSeededSite();
    const dataSource = new DemoFleetDataSource();
    const fleetForecasts = vi.spyOn(dataSource, 'fleetForecasts');
    const container = renderDashboard(dataSource);
    await settle();

    expect(fleetForecasts).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: `Marker: ${site.name}` }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await settle();

    expect(sitePopover(container)).toBeNull();
    expect(screen.queryByRole('heading', { name: site.name })).toBeNull();
    expect(siteOverlayColumn(site.name)).toBeNull();
    // One sum across the whole select-and-close round trip. In live mode a
    // second one is a paced fan-out of one request per site, and a selection is
    // not a change to the fleet's sum — only a second line drawn over it.
    expect(fleetForecasts).toHaveBeenCalledTimes(1);
  });

  it('draws the selected site over the fleet without re-summing the fleet', async () => {
    const site = firstSeededSite();
    const dataSource = new DemoFleetDataSource();
    const fleetForecasts = vi.spyOn(dataSource, 'fleetForecasts');
    const siteForecasts = vi.spyOn(dataSource, 'siteForecasts');
    renderDashboard(dataSource);
    await settle();

    fireEvent.click(screen.getByRole('button', { name: `Marker: ${site.name}` }));
    await settle();

    // The site's own hours are one request for one site; the fleet's sum is the
    // fan-out, and it is not re-spent. That ratio is the whole argument for
    // overlaying rather than swapping.
    expect(siteForecasts).toHaveBeenCalledWith(site.id, 24);
    expect(fleetForecasts).toHaveBeenCalledTimes(1);
    expect(siteOverlayColumn(site.name)).not.toBeNull();
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
 * The gate between a click on the basemap and a draft.
 *
 * `StubMapRegion` reports every basemap click, exactly as the real map does, so
 * what these two prove is the *dashboard's* rule rather than the stand-in's. The
 * negative case is the one that bites: delete the gate from `onMapClick` and it
 * is the only assertion in the suite that changes.
 */
describe('Dashboard add-site mode', () => {
  it('ignores a map click while add-site mode is disarmed', async () => {
    renderDashboard(new DemoFleetDataSource());
    await settle();

    clickBasemap();

    expect(screen.queryByRole('button', { name: 'Add site' })).toBeNull();
  });

  it('opens one draft per arming, and spends the arming on it', async () => {
    renderDashboard(new DemoFleetDataSource());
    await settle();

    armAddSite();
    clickBasemap();

    expect(screen.getByRole('button', { name: 'Add site' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    clickBasemap();

    // Single-shot: the arming was spent on the first click, so the second is an
    // ordinary basemap click again and opens nothing. This used to assert the
    // fleet panel's `hidden` attribute alongside — "the region is back on the
    // fleet" — which stopped meaning anything when the panel stopped being
    // hideable (#265); an attribute that is never set reads `false` whatever the
    // page does.
    expect(screen.queryByRole('button', { name: 'Add site' })).toBeNull();
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

    expect(fleetRows()).toHaveLength(60);
    expect(attributionLinks()).toHaveLength(1);
  });
});
