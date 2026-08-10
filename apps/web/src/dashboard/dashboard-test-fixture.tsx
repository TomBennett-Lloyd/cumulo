import type { Site } from '@cumulo/shared';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { vi } from 'vitest';

import type { FleetDataSource } from '../data/fleet-data-source';
import { SitePopoverCard } from '../map/SitePopoverCard';
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
 * {@link StubMapRegion} is a plain second way to reach the callbacks the real
 * map calls: selecting a site, clicking the basemap, and arming add-site mode.
 * Every assertion in the suites is about what the *dashboard* then does; that
 * the real map fires those callbacks at all is browser behaviour
 * (`testing.md` rule 10), and is checked in `e2e/map-regressions.spec.ts` — an
 * *armed* basemap click opening the draft dialog, an unarmed one opening
 * nothing, and a marker press opening the site's card.
 *
 * The selected site's card is the *real* `SitePopoverCard`, not a stand-in for
 * it. What jsdom cannot host is the maplibre marker the app portals that card
 * into, and `SitePopover.tsx` is exactly and only that anchoring — so the seam
 * falls between the two, and the half with the decisions in it (the facts, the
 * forecast arms, Escape, and where focus goes) is the half these suites drive.
 * A stand-in card here would have left the dashboard's focus assertions
 * asserting the stand-in's own focus behaviour.
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
  addSiteArmed,
  onToggleAddSite,
  selectedSite,
  selectionOrigin,
  firstForecast,
  onRetryFirstForecast,
  onDeselectSite,
}: MapRegionProps): ReactElement => (
  <div>
    {/*
     * Named and classed exactly as `MapControls` names and classes it. The name
     * is how the suites press it; the class is how the *dashboard* finds it,
     * since a closing draft returns focus by querying `.map-control-add` inside
     * the map's box. A stand-in that dropped either would let the real control
     * be renamed or reclassed without a single test noticing.
     */}
    <button
      type="button"
      className="map-control-add"
      aria-pressed={addSiteArmed}
      onClick={onToggleAddSite}
    >
      Add a site
    </button>

    {/*
     * Fires the click unconditionally, exactly as the real map does. Whether an
     * unarmed click means anything is the dashboard's decision, and a stand-in
     * that filtered would be asserting its own copy of the gate under test.
     */}
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

    {/*
     * The selected site's card, real and keyed exactly as `MapRegion` keys it.
     * The key is load-bearing rather than tidy: the card captures whatever held
     * focus when it opened, so moving from one site to another has to remount
     * it, and a stand-in that dropped the key would let the dashboard's focus
     * suites pass over a card still holding the previous site's opener.
     *
     * `selectionOrigin` is forwarded for the same reason: it is what decides
     * whether the card captures an opener at all, so a stub that swallowed it
     * would leave `Dashboard.focus.test.tsx`'s deep-link cases asserting the
     * stub's own default rather than the dashboard's answer.
     */}
    {selectedSite !== null && (
      <SitePopoverCard
        key={selectedSite.id}
        site={selectedSite}
        selectionOrigin={selectionOrigin}
        firstForecast={firstForecast}
        onRetryFirstForecast={onRetryFirstForecast}
        onClose={onDeselectSite}
      />
    )}
  </div>
);

/*
 * There is no `scrollIntoView` stand-in here any more, and nothing needs one.
 * jsdom implements no layout and so has no `scrollIntoView` at all — the method
 * is simply absent from its elements — which is why the dashboard's old
 * context-scroll effect needed one to keep from throwing. That effect went with
 * the context region (#265): a selection is answered on the map now, so the page
 * has nothing to scroll to and the dashboard asks nobody to move.
 */

/**
 * Mounts the dashboard the way the shell does, minus WebGL.
 *
 * `onToggleTheme` is a no-op rather than a spy: the dashboard forwards it to the
 * header's menu and never calls it, so what a press *means* is the shell's wiring
 * (`App.test.tsx`) and the menu's own (`header/HeaderMenu.test.tsx`). A spy here
 * would only be a spy nobody asserts.
 */
export const renderDashboard = (dataSource: FleetDataSource): HTMLElement => {
  const { container } = render(
    <Dashboard
      theme="light"
      onToggleTheme={() => undefined}
      dataSource={dataSource}
      mapRegion={StubMapRegion}
    />,
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

/** The fleet's panel, which is on screen in every state of the page since #265. */
export const fleetPanel = (root: HTMLElement): Element | null => root.querySelector('.fleet-panel');

/** The selected site's card, as the map draws it — `null` when nothing is selected. */
export const sitePopover = (root: HTMLElement): Element | null =>
  root.querySelector('.site-popover');

/**
 * The fleet chart's table twin, which is where the overlay is readable as text.
 *
 * The chart carries the selected site as a second series, and the SVG says so in
 * coordinates nobody can assert on without re-deriving the geometry. The table
 * says it in a column headed with the site's name.
 */
export const fleetChartTable = (): HTMLElement =>
  screen.getByRole('table', { name: /^Table view — fleet forecast/u });

/** The fleet as rows — the map's table view, and where a closing card returns focus. */
export const fleetTable = (): HTMLElement => screen.getByRole('table', { name: 'Fleet sites' });

/**
 * One selection button per listed site, in site order.
 *
 * The rows are counted through their buttons rather than through `role="row"`,
 * which would also count the header row and leave every fleet-size assertion in
 * the suites one out from the fleet it is about. A button per site is also the
 * claim worth making: a row a reader cannot press is not a table view of
 * anything (`map-treatment.md`).
 *
 * The disclosure is deliberately not opened first: jsdom omits the `<details>`
 * shadow-tree styles, so its contents are queryable whether it is open or shut,
 * and what a reader can *see* through a closed one is the browser lane's
 * (`testing.md` rule 10).
 */
export const fleetRows = (): readonly HTMLElement[] => within(fleetTable()).getAllByRole('button');

/** Presses the map's add-site toggle, the control that decides what a click means. */
export const armAddSite = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'Add a site' }));
};

/**
 * Clicks the basemap at {@link CLICK_POSITION} without touching the toggle.
 *
 * The raw event, for the suites that are about the gate itself. Everything else
 * wants {@link clickMap}, which is the whole gesture.
 */
export const clickBasemap = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'Click the map' }));
};

/**
 * Drops a draft at {@link CLICK_POSITION}, the way a reader does it on the real
 * map: arm add-site mode, then click.
 *
 * Two presses rather than one because that is now the gesture — a bare click is
 * ignored (#265). Kept as one helper so the suites that are about what happens
 * *after* a draft opens say "click the map" once, rather than restating the
 * arming rule in a dozen places that would all have to change together.
 */
export const clickMap = (): void => {
  armAddSite();
  clickBasemap();
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
