// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { MapRegionComponent } from './dashboard/MapRegion';
import { PRODUCT_TAGLINE } from './header/header-copy';
import { MapSurface } from './map/MapSurface';
import { THEME_STORAGE_KEY } from './theme';

/*
 * The shell, rendered the only way jsdom can render it: with something other
 * than maplibre in the map's place.
 *
 * There is one surface now — no nav, no `initialView` — so every test here
 * renders the whole app and reaches the dashboard through it. The map is the
 * one part that cannot come along: maplibre needs WebGL, which jsdom does not
 * implement. `mapRegion` is the seam for exactly that (see `AppProps`), and
 * standing up a fake maplibre instead would leave the suite asserting that a
 * mock was called (`testing.md` rule 3).
 *
 * What that leaves uncovered here is the shipping default — the real
 * `LazyMapRegion` in the real shell — which is the browser lane's (`testing.md`
 * rule 10): `e2e/composition.spec.ts` mounts it against the built app and waits
 * for a laid-out WebGL canvas. Its two off-happy-path states are covered
 * directly in `dashboard/LazyMapRegion.test.tsx`.
 *
 * The dashboard runs against the real fixture source rather than a stub,
 * because what these tests are for is the wiring: that the shell mounts the
 * dashboard and that the dashboard finds a data source at all. A stub here
 * would pass with the source unplugged, which is the one failure this file
 * exists to rule out.
 */

/**
 * The map's stand-in: no WebGL, and the one obligation the real region carries.
 *
 * It is the real `MapSurface` with a placeholder in the canvas slot rather than
 * a hand-written shell, so it credits Open-Meteo for the same reason the shipping
 * map does instead of by a copy that happens to agree. The credit is a licence
 * obligation wherever weather-derived data is displayed, and a stand-in without
 * it would let the attribution assertions below pass against a page that never
 * had to show one — theatre. Nothing else about it is interactive: selection and
 * click-to-add are the dashboard's tests to run
 * (`dashboard/Dashboard.test.tsx`), not the shell's.
 */
const StandInMapRegion: MapRegionComponent = (): ReactElement => (
  <MapSurface canvas={{ kind: 'placeholder', label: 'Map stand-in' }} />
);

/**
 * A map region that throws where the real one would render.
 *
 * This is the whole-app failure the boundary exists for, produced at the only
 * seam a test can reach into the tree through. What it stands in for is not a
 * broken map specifically — `LazyMapRegion` contains that case itself — but any
 * component below the shell throwing during render, which React answers by
 * unmounting the root unless something catches it.
 */
const ThrowingMapRegion: MapRegionComponent = (): ReactElement => {
  throw new Error('The map region threw while rendering');
};

/** A `matchMedia` result, shaped like the real one so nothing is asserted away. */
const mediaQueryList = (media: string, matches: boolean): MediaQueryList => ({
  media,
  matches,
  onchange: null,
  addListener: () => undefined,
  removeListener: () => undefined,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => true,
});

// jsdom's own `matchMedia` answers `false` to every query and has no way to say
// otherwise, so the system-preference cases need this. Each test states the
// preference it is written against rather than inheriting jsdom's.
const stubSystemPrefersDark = (prefersDark: boolean): void => {
  vi.stubGlobal('matchMedia', (media: string) => mediaQueryList(media, prefersDark));
};

/**
 * Render the app and wait until its one surface is on screen.
 *
 * The panel column's "Sites" heading is the marker: it is the first thing the
 * dashboard renders that belongs to the dashboard rather than the shell, so
 * finding it proves the shell mounted the surface — and awaiting it settles the
 * fleet listing the dashboard kicks off, so nothing resolves after the test.
 */
const renderApp = async (mapRegion: MapRegionComponent): Promise<void> => {
  render(<App mapRegion={mapRegion} />);
  await screen.findByRole('heading', { name: 'Sites' });
};

/**
 * Open the header menu, the way a visitor reaches anything in it.
 *
 * The theme toggle is no longer bare in the header bar — it lives behind this
 * disclosure (`header/HeaderMenu.tsx`), so every theming case below has to open
 * the menu before it can press anything. Going through the button rather than
 * rendering the popover directly is the point: what these cases prove is that
 * the shell's wiring survives, and reaching past the disclosure would prove it
 * for a header nobody ships.
 */
const openHeaderMenu = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
};

/** The theme toggle, reached where a visitor reaches it. */
const themeToggle = (): HTMLElement => screen.getByRole('button', { name: 'Dark theme' });

beforeEach(() => {
  stubSystemPrefersDark(false);
});

// Vitest runs without global test hooks, so Testing Library's automatic cleanup
// never registers itself. The theme attribute and the stored preference are
// document- and origin-level state this app deliberately writes, so each has to
// be reset too — otherwise one test's dark mode is the next test's start.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe('App theming', () => {
  it('themes the document light when nothing is stored and the system prefers light', async () => {
    await renderApp(StandInMapRegion);

    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('starts in the theme the visitor last chose', async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');

    await renderApp(StandInMapRegion);
    openHeaderMenu();

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(themeToggle().getAttribute('aria-pressed')).toBe('true');
  });

  it('follows the system preference when the visitor has never chosen', async () => {
    stubSystemPrefersDark(true);

    await renderApp(StandInMapRegion);

    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('lets a stored light choice overrule a dark system preference', async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
    stubSystemPrefersDark(true);

    await renderApp(StandInMapRegion);

    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('flips the document theme each time the toggle is pressed', async () => {
    await renderApp(StandInMapRegion);
    openHeaderMenu();
    const toggle = themeToggle();

    fireEvent.click(toggle);

    expect(document.documentElement.dataset.theme).toBe('dark');

    fireEvent.click(toggle);

    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('reports the current theme through the toggle it lives on', async () => {
    await renderApp(StandInMapRegion);
    openHeaderMenu();
    const toggle = themeToggle();

    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-pressed')).toBe('true');
  });

  it('remembers a theme the visitor picked, and only one they picked', async () => {
    stubSystemPrefersDark(true);
    await renderApp(StandInMapRegion);

    // Rendering dark because the system asked for it is not a choice, so
    // nothing is stored yet — otherwise the visitor's OS switching to light
    // later would be overruled by a preference they never expressed.
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();

    openHeaderMenu();
    fireEvent.click(themeToggle());

    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });
});

describe('App shell', () => {
  it('offers no view nav, because there are no views to switch between', async () => {
    await renderApp(StandInMapRegion);

    // Named after the buttons that used to be here rather than asserted as a
    // count: what #148 removed is this specific choice-of-page, and a bare
    // "fewer buttons" assertion would go green for the wrong reason the first
    // time a panel gained a control.
    expect(screen.queryByRole('button', { name: /Fleet map|Fleet aggregate|Site forecast/ })).toBe(
      null,
    );
  });

  it('names the product and what it does, once', async () => {
    await renderApp(StandInMapRegion);

    expect(screen.getByRole('heading', { name: 'Cumulo', level: 1 })).toBeDefined();
    // The constant the header renders, not a fragment of it. Spelling any part
    // of the sentence out here would make this file a second place the tagline
    // is written down, which is the thing `header/header-copy.ts` exists to
    // prevent — and would leave this passing against the old words after an
    // edit in its one home (`architecture.md` rule 9).
    expect(screen.getByText(PRODUCT_TAGLINE)).toBeDefined();
  });

  it('leaves the header bar with one control on it, and the rest behind it', async () => {
    await renderApp(StandInMapRegion);

    // The bar is height the map does not get, so what sits on it is a design
    // decision rather than an accident of where a component was added. The
    // theme toggle used to be bare here; it is behind the disclosure now, and
    // this is the assertion that notices if something bare comes back.
    expect(screen.queryByRole('button', { name: 'Dark theme' })).toBe(null);

    openHeaderMenu();

    expect(screen.getByRole('button', { name: 'Dark theme' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'About Cumulo' })).toBeDefined();
  });
});

describe('App attribution', () => {
  it('credits Open-Meteo twice at rest — once for the map, once for the panel column', async () => {
    // Two, and exactly two, is the design rather than a tolerance. The surface
    // has two halves that each display weather-derived data and each survive
    // the other being empty: the map keeps its credit in its own strip, and the
    // column keeps one at its foot that outlasts every context swap. What the
    // count rules out is the failure the old views had — a credit per panel,
    // multiplying with the panels and disappearing with whichever one happened
    // to be unmounted (CC BY 4.0, CLAUDE.md hard constraints).
    //
    // "At rest" is the whole qualification: the About dialog owes a credit too
    // (below), and it is mounted-but-closed on this page. Were its content in
    // the document while closed, this count would read three — which is the
    // reason `AboutDialog` renders its body only while open.
    await renderApp(StandInMapRegion);

    expect(screen.getAllByRole('link', { name: 'Open-Meteo.com' })).toHaveLength(2);
  });

  it('adds a third credit when the About dialog names its data sources', async () => {
    // A surface that lists where the app's data comes from and omitted the
    // weather source would be the one place the omission is most visible. It is
    // a third obligation discharged, not the resting count drifting: the two
    // above are still on screen behind the dialog.
    await renderApp(StandInMapRegion);
    openHeaderMenu();

    fireEvent.click(screen.getByRole('button', { name: 'About Cumulo' }));

    expect(screen.getAllByRole('link', { name: 'Open-Meteo.com' })).toHaveLength(3);
  });
});

describe('App when the surface below the shell throws', () => {
  beforeEach(() => {
    // React reports every error a boundary catches to `console.error` as well,
    // so this keeps a deliberate failure from reading as a broken test run.
    // Spied rather than silenced wholesale: the boundary's own log is asserted.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('shows a failure in place of the surface instead of unmounting the page', () => {
    render(<App mapRegion={ThrowingMapRegion} />);

    const failure = screen.getByRole('alert');

    expect(failure.textContent).toContain('The dashboard hit an unexpected error');
    // The header lives above the boundary, so the page still says what it is.
    expect(screen.getByRole('heading', { name: 'Cumulo', level: 1 })).toBeDefined();
  });

  it('still credits Open-Meteo when the surface has crashed', () => {
    // The licence does not lapse because the render did, and the failure state
    // is where the credit is easiest to lose.
    render(<App mapRegion={ThrowingMapRegion} />);
    screen.getByRole('alert');

    expect(screen.getByRole('link', { name: 'Open-Meteo.com' }).getAttribute('href')).toBe(
      'https://open-meteo.com/',
    );
  });

  it('logs the failure rather than swallowing it', () => {
    render(<App mapRegion={ThrowingMapRegion} />);
    screen.getByRole('alert');

    // `error-handling.md` rule 2c: the boundary is where the error stops, which
    // is only acceptable if it stops visibly.
    expect(
      vi
        .mocked(console.error)
        .mock.calls.some(([first]) => first === 'The dashboard failed to render'),
    ).toBe(true);
  });
});
