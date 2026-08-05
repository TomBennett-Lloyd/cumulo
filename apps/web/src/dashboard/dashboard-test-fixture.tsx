import type { Site } from '@cumulo/shared';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { vi } from 'vitest';

import type { FleetDataSource } from '../data/fleet-data-source';
import { Dashboard } from './Dashboard';
import type { MapRegionProps } from './MapRegion';

/**
 * The shared way of mounting and driving a `Dashboard` in jsdom.
 *
 * The dashboard's suites are split by subject — the composition and its
 * contexts in `Dashboard.test.tsx`, the `?site=` deep link in
 * `Dashboard.deep-link.test.tsx`, managed focus in `Dashboard.focus.test.tsx`
 * (`structure.md` rule 4) — but they mount the same dashboard through the same
 * seams. Those seams live here rather than in copies that would have to change
 * together to keep meaning the same thing (`structure.md` rule 7). Helpers only
 * one suite needs stay in that suite; a helper a second suite reaches for moves
 * in here, which is how the shared helpers here arrived.
 *
 * Nothing here is a mock of maplibre. jsdom implements no WebGL, so the real
 * `MapRegion` cannot mount — which is why `Dashboard` takes the map region as a
 * prop (see `MapRegion.tsx` for the seam's reasoning) and why
 * {@link StubMapRegion} is a plain second way to reach the two callbacks the
 * real map calls. Every assertion in the suites is about what the *dashboard*
 * then does; that the real map fires those callbacks at all is browser
 * behaviour (`testing.md` rule 10), and is checked in
 * `e2e/map-regressions.spec.ts` — a basemap click opening the draft form, a
 * marker press opening the site panel.
 */

/** Where the stand-in's simulated click lands: the Irish Sea, inside the fleet's framing. */
export const CLICK_POSITION = { latitude: 53.5, longitude: -5.5 };

/**
 * What `AddSiteForm` names a site dropped at {@link CLICK_POSITION}.
 *
 * Restated rather than derived, because it is the *form's* naming rule being
 * relied on: a test that computed the name the same way the form does would
 * still pass if both were wrong together. It belongs beside the position it
 * describes — the two are one fact about where the stand-in's click lands.
 */
export const CREATED_SITE_NAME = 'Site at 53.5000, -5.5000';

export const StubMapRegion = ({
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
 * Stands in for the scroll the column performs when a context takes the region.
 *
 * jsdom implements no layout and therefore no `scrollIntoView` at all — the method is simply
 * absent from its elements, so the dashboard's context-scroll effect would throw here rather than
 * harmlessly doing nothing. Standing one in is what lets these suites mount a dashboard at all,
 * and it lets a test read back *which* element was asked, on *which* transition — the two halves
 * of the mechanism that are the dashboard's own doing.
 *
 * What it cannot show is the movement. Nothing in jsdom has a scroll position, so "the swapped-in
 * context is actually on screen in a column the reader had scrolled halfway down" is a browser
 * criterion, named in `docs/design/dashboard-composition.md`. The browser lane exists
 * (`apps/web/e2e/`, `testing.md` rule 10) but no spec in it asserts a scroll position today, so
 * that criterion has no automated owner at all. Nothing read back from here is evidence of it,
 * and `Dashboard.test.tsx` says so where it asserts.
 */
const scrollIntoViewStub = vi.fn<(options?: boolean | ScrollIntoViewOptions) => void>();

HTMLElement.prototype.scrollIntoView = scrollIntoViewStub;

/** The elements the dashboard has asked to bring into view since it was mounted, in call order. */
export const scrolledIntoView = (): readonly unknown[] => scrollIntoViewStub.mock.contexts;

export const renderDashboard = (dataSource: FleetDataSource): HTMLElement => {
  // The record belongs to this mount. The stub lives on a prototype shared by every test in the
  // file, so without this a suite would read the scrolls of whatever ran before it.
  scrollIntoViewStub.mockClear();

  const { container } = render(
    <Dashboard theme="light" dataSource={dataSource} mapRegion={StubMapRegion} />,
  );
  return container;
};

/** Moves the fake clock and lets React commit whatever that produced, as one step. */
export const advanceBy = async (ms: number): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

/** Lets already-resolved promises (the listing, a creation) settle without moving the clock. */
export const settle = (): Promise<void> => advanceBy(0);

/** Parks the window at a URL, the way a visitor arriving on a link would. */
export const visit = (url: string): void => {
  window.history.replaceState(null, '', url);
};

/** The panel column's resting state, whether or not it is the visible context. */
export const fleetPanel = (root: HTMLElement): Element | null => root.querySelector('.fleet-panel');

/** The fleet as rows — the map's table view, and where a closing panel returns focus. */
export const fleetList = (): HTMLElement => screen.getByRole('list', { name: 'Fleet sites' });

/** Drops a draft at {@link CLICK_POSITION}, the way a click on the real map would. */
export const clickMap = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'Click the map' }));
};

/** Presses the draft form's submit, which the throttle may still refuse. */
export const submitDraft = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'Add site' }));
};

/** Clicks the map, submits the pre-filled draft, and lets the creation settle. */
export const addSite = async (): Promise<void> => {
  clickMap();
  submitDraft();
  await settle();
};

/**
 * A site as the *source itself* lists it — the id a deep link would carry.
 *
 * Asked of the source rather than regenerated from the seed: a deep link's id
 * comes from a running fleet, and a test that derived the id the same way the
 * demo fleet does would still pass if both drifted together.
 */
export const firstListedSite = async (dataSource: FleetDataSource): Promise<Site> => {
  const listed = await dataSource.listSites();

  if (listed.kind !== 'ok') {
    throw new Error('The fleet under test refused to list its sites.');
  }

  const [site] = listed.value;

  if (site === undefined) {
    throw new Error('The fleet under test is empty; a deep link needs a site to name.');
  }

  return site;
};
