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
export const SITE_B = site(SITE_B_ID, 'Brambling Way');

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

/** The canned answers to the calls the panel makes. */
export interface StubFleet {
  readonly forecasts: FleetSourceResult<readonly Forecast[]>;
  readonly actuals: FleetSourceResult<readonly GenerationReading[]>;
  /**
   * Non-null fails the *overlay* read only.
   *
   * A message rather than a whole result, because the site's own hours are always filtered from
   * {@link FORECASTS} when they succeed — what varies is only whether the read failed, and a
   * second copy of the success value would be a second thing to keep in step.
   */
  readonly siteForecastError: string | null;
}

const ready = <T,>(value: T): FleetSourceResult<T> => ({ kind: 'ok', value });

export const FULL_FLEET: StubFleet = {
  forecasts: ready(FORECASTS),
  actuals: ready(ACTUALS),
  siteForecastError: null,
};

/** The fleet sums fine; the selected site's own hours do not arrive. */
export const OVERLAYLESS_FLEET: StubFleet = {
  ...FULL_FLEET,
  siteForecastError: 'siteForecasts: network refused',
};

/** 07:00 loses site B, so that hour aggregates one of the fleet's two sites and 06:00 keeps both. */
export const PARTIAL_FLEET: StubFleet = {
  ...FULL_FLEET,
  forecasts: ready(
    FORECASTS.filter(
      (forecast) => !(forecast.siteId === SITE_B_ID && forecast.validTime === timestamp(7)),
    ),
  ),
};

/**
 * Neither read has an hour in it — the only state in which the panel has genuinely nothing to plot.
 *
 * The actuals are emptied as well as the forecasts, and that is the whole point of this fixture
 * since #290: "no forecast" and "nothing to show" stopped being the same question when the chart's
 * x-domain became the union of both series. {@link ACTUALS_ONLY_FLEET} is the other half of that
 * split, and the two are only distinguishable because this one is empty on both sides.
 */
export const FORECASTLESS_FLEET: StubFleet = {
  ...FULL_FLEET,
  forecasts: ready([]),
  actuals: ready([]),
};

export const FAILED_FLEET: StubFleet = {
  ...FULL_FLEET,
  forecasts: {
    kind: 'error',
    error: { code: 'network', message: 'fleetForecasts range=24: upstream timed out' },
  },
};

/**
 * The forecast read answers; the actuals request beside it does not.
 *
 * The half of the panel's failure surface that had no fixture until #264's review, which is a
 * large part of why the panel answered it by withdrawing the whole chart under the forecast's
 * name. The two reads are two requests over two windows, so this is an ordinary state and not a
 * contrived one.
 */
export const ACTUALS_FAILED_FLEET: StubFleet = {
  ...FULL_FLEET,
  actuals: {
    kind: 'error',
    error: { code: 'network', message: 'fleetActuals range=24: upstream timed out' },
  },
};

/**
 * Forecasts strictly after the actuals, sharing no hour with them — the shape the deployed source
 * produces and the demo source never has.
 *
 * Live, `fleetForecasts` fans out over `/v1/sites/{id}/forecast`, which serves hours *ahead* of the
 * clock, while `fleetActuals` reads `[now−24h, now)`. The two windows are disjoint for every value
 * of the clock, so a fixture whose forecasts and actuals share hours — {@link FULL_FLEET}, and
 * every fixture here before this one — cannot tell a chart that keeps the actuals from one that
 * silently drops every last one of them (#264).
 *
 * The two halves are deliberately different sizes of number as well as different hours, so a row
 * from one window cannot be mistaken for a row from the other in an assertion.
 */
export const DISJOINT_WINDOW_FLEET: StubFleet = {
  forecasts: ready([
    forecastAt(SITE_A_ID, 12, 2, band(1, 3)),
    forecastAt(SITE_B_ID, 12, 4, band(3, 6)),
    forecastAt(SITE_A_ID, 13, 3, band(2, 4)),
    forecastAt(SITE_B_ID, 13, 5, band(4, 7)),
  ]),
  actuals: ready([
    readingAt(SITE_A_ID, 10, 1.5),
    readingAt(SITE_B_ID, 10, 3.5),
    readingAt(SITE_A_ID, 11, 2),
    readingAt(SITE_B_ID, 11, 4),
  ]),
  siteForecastError: null,
};

/**
 * The forecast read summed to nothing; the actuals arrived — #290's second finding.
 *
 * A real state rather than a contrived one: the two reads are two requests over two windows, and a
 * forecast pipeline that has not produced yet leaves the measured hours untouched. The panel used
 * to answer it by returning "no fleet forecast" in place of the chart, throwing away hours it had
 * been handed. {@link DISJOINT_WINDOW_FLEET}'s actuals are borrowed because they span *two* hours,
 * so the measured series is a run a chart can stroke rather than a lone marker.
 */
export const ACTUALS_ONLY_FLEET: StubFleet = {
  ...DISJOINT_WINDOW_FLEET,
  forecasts: ready([]),
};

const FULL_CAPABILITIES: FleetSourceCapabilities = { fleetLookback: true, fleetActuals: true };

/** Neither fleet-level capability: a forward horizon only, and no actuals at all. */
export const HORIZON_ONLY_CAPABILITIES: FleetSourceCapabilities = {
  fleetLookback: false,
  fleetActuals: false,
};

/**
 * The combination #264 made real and the deployed source is in: simulated actuals over a forecast
 * read that still reaches forward only.
 *
 * Here rather than in one suite because both of them need it now — the window copy is
 * `FleetPanel.test.tsx`'s subject and the panel's furniture is `FleetPanel.structure.test.tsx`'s,
 * and a second copy of the flags would be a second thing to keep in step with the live source.
 */
export const SIMULATED_ACTUALS_CAPABILITIES: FleetSourceCapabilities = {
  fleetLookback: false,
  fleetActuals: true,
};

/**
 * A `FleetDataSource` over canned results that counts what it was asked.
 *
 * A class rather than a `createStubSource(canned)` closure factory (`structure.md` rule 2): the
 * members genuinely share the canned data and the call log, and `this.` is what makes that sharing
 * visible. The members are arrow properties because the interface's are.
 *
 * The counting is the point of several tests, and what it counts is what this panel is frugal
 * about. "Does a new `refreshToken` re-sum the fleet", "does an empty fleet ask anything at all",
 * "does moving the selection ask about the new site rather than relabel the old one's answer" and
 * "does the overlay's retry spend a per-site request without re-spending the fleet read" are all
 * questions about calls rather than about pixels, and only a stub that remembers can answer them.
 * (It also counted reveals until #265, when the panel stopped being hideable.)
 */
export class CountingFleetSource implements FleetDataSource {
  readonly forecastRanges: RangeHours[] = [];

  /**
   * Every per-site forecast request, as `<siteId>@<range>`.
   *
   * Recorded rather than merely counted because the overlay's whole contract is *which* site was
   * asked about over *which* window: an overlay drawn from the previous selection's answer, or
   * from a window the chart is not showing, would be a chart quietly lying about one of its two
   * series.
   */
  readonly siteForecastRequests: string[] = [];

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

  /**
   * One site's own hours — the overlay's source, served out of the same canned fleet.
   *
   * Filtered from {@link FORECASTS} rather than answered from a second set of numbers, because
   * that is what makes the overlay assertions mean something: the site's line really is a
   * component of the sum drawn under it, so a table row showing the site above the fleet's own
   * median would be a defect these tests can see.
   */
  readonly siteForecasts = (
    siteId: string,
    range: RangeHours,
  ): Promise<FleetSourceResult<readonly Forecast[]>> => {
    this.siteForecastRequests.push(`${siteId}@${String(range)}`);
    return Promise.resolve(
      this.canned.siteForecastError === null
        ? { kind: 'ok', value: FORECASTS.filter((forecast) => forecast.siteId === siteId) }
        : { kind: 'error', error: { code: 'network', message: this.canned.siteForecastError } },
    );
  };

  // The overlay is the site's median and nothing else, so the site's actuals are never asked for.
  // A throw rather than an empty answer: it is a bug worth a loud crash, not a state to render.
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

/**
 * What the dashboard tells the panel about the selection, as one value.
 *
 * The two props travel together in every case that matters — a site with no answer about it yet
 * draws no overlay, and an answer with no site is nothing — so the fixture passes them as a pair
 * rather than letting a test set one and forget the other.
 */
export interface FleetPanelSelection {
  readonly selectedSite: Site | null;
  readonly selectionReady: boolean;
}

/** The resting state: nothing selected, so no overlay and no per-site request. */
export const NO_SELECTION: FleetPanelSelection = { selectedSite: null, selectionReady: false };

/** Site A selected, with its first forecast already in — the state that draws an overlay. */
export const SITE_A_SELECTED: FleetPanelSelection = {
  selectedSite: SITE_A,
  selectionReady: true,
};

/**
 * The same, for the fleet's other site — the second half of a reader moving from
 * one selection to the next.
 *
 * The two sites carry deliberately different hours in {@link FORECASTS}, which is
 * what lets a test tell "the chart is drawing site B" from "the chart relabelled
 * site A's numbers".
 */
export const SITE_B_SELECTED: FleetPanelSelection = {
  selectedSite: SITE_B,
  selectionReady: true,
};

/** Site A selected while its first forecast is still being generated. */
export const SITE_A_PENDING: FleetPanelSelection = {
  selectedSite: SITE_A,
  selectionReady: false,
};

/**
 * One rendered table row, in column order — the row header and its cells together.
 *
 * `th, td` rather than the `cell` role, because the time column is a `rowheader` and a row read as
 * four values would drop the hour each of them belongs to.
 *
 * Here rather than in one suite because both of them read the chart's table twin: it is where the
 * plotted numbers are readable as text, so it is where the fleet's sum and the selected site's
 * line are both pinned.
 */
export const rowCells = (row: HTMLElement): readonly string[] =>
  Array.from(row.querySelectorAll('th, td'), (cell) => cell.textContent);

/** Waits for both fleet reads to have answered, whatever they answered. */
export const settle = async (): Promise<void> => {
  await waitFor(() => {
    expect(screen.queryByText(LOADING_FLEET_FORECAST_LABEL)).toBeNull();
  });
};

/**
 * The panel as the page mounts it, over the shared two-site fleet.
 *
 * A returned element rather than a render call, because the refresh and overlay tests mount it
 * once and then `rerender` it with one prop moved — and a prop added to {@link FleetPanel} would
 * otherwise leave a dozen copies wrong at once (`structure.md` rule 7). The fleet is a parameter
 * of {@link renderSettled}, which is what the tests that vary it use.
 *
 * The selection is the one thing this varies, because it is the one thing the page varies about
 * this panel now: it is never hidden and never unmounted (#265), so `hidden` stopped being a
 * parameter at the same time it stopped being a prop.
 */
export const panel = (
  dataSource: FleetDataSource,
  selection: FleetPanelSelection = NO_SELECTION,
  refreshToken = 0,
): ReactElement => (
  <FleetPanel
    dataSource={dataSource}
    sites={SITES}
    selectedSite={selection.selectedSite}
    selectionReady={selection.selectionReady}
    refreshToken={refreshToken}
  />
);

/** A settled panel over the given fleet, with nothing selected. */
export const renderSettled = async (
  dataSource: FleetDataSource,
  sites: readonly Site[] = SITES,
): Promise<HTMLElement> => {
  const { container } = render(
    <FleetPanel
      dataSource={dataSource}
      sites={sites}
      selectedSite={null}
      selectionReady={false}
      refreshToken={0}
    />,
  );
  await settle();
  return container;
};
