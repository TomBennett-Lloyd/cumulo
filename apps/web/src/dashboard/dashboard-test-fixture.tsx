import type { Site } from '@cumulo/shared';
import { act, render } from '@testing-library/react';
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
 * `Dashboard.deep-link.test.tsx` (`structure.md` rule 4) — but they mount the
 * same dashboard through the same seams. Those seams live here rather than in
 * two copies that would have to change together to keep meaning the same thing
 * (`structure.md` rule 7). Helpers only one suite needs stay in that suite.
 *
 * Nothing here is a mock of maplibre. jsdom implements no WebGL, so the real
 * `MapRegion` cannot mount — which is why `Dashboard` takes the map region as a
 * prop (see `MapRegion.tsx` for the seam's reasoning) and why
 * {@link StubMapRegion} is a plain second way to reach the two callbacks the
 * real map calls. Every assertion in the suites is about what the *dashboard*
 * then does; that the real map fires those callbacks at all is browser
 * behaviour, and is checked in a browser.
 */

/** Where the stand-in's simulated click lands: the Irish Sea, inside the fleet's framing. */
export const CLICK_POSITION = { latitude: 53.5, longitude: -5.5 };

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

export const renderDashboard = (dataSource: FleetDataSource): HTMLElement => {
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
