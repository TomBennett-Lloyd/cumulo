// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { THEME_STORAGE_KEY } from './theme';

/*
 * Every test here opens the shell on a view other than its default, and that is
 * a stated limitation rather than a convenience.
 *
 * The app opens on the fleet map, and the map is now fetched on demand
 * (`dashboard/LazyMapRegion.tsx`), so a `render(<App />)` with no `initialView`
 * no longer throws on the spot — it returns the shell with a "Loading map…"
 * placeholder in it, and only reaches maplibre a tick later when that chunk
 * resolves. What it reaches then is unchanged: maplibre needs WebGL, which
 * jsdom does not implement, so the default view still cannot be rendered
 * through here. Standing up a fake maplibre to get past that would leave the
 * suite asserting that a mock was called (`testing.md` rule 3). So the shipping
 * default is covered in a browser or not at all (#107), and what is asserted
 * below — theming, the switcher, the attribution obligation — is identical on
 * every view.
 *
 * The chart views are tested against the real fixture provider, not a stub:
 * what these tests are for is the wiring — that the switcher mounts the view it
 * names and that the view finds a data source at all. A stub here would pass
 * with the provider unplugged, which is the one failure that part exists to
 * rule out. Each such test therefore awaits the rendered chart, which is also
 * what settles the provider's promises before the test ends.
 */
const FLEET_CHART_LABEL = /Fleet aggregate forecast and measured output/;
const SITE_CHART_LABEL = /forecast and measured generation/;

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
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe('App theming', () => {
  it('themes the document light when nothing is stored and the system prefers light', () => {
    render(<App initialView="tokens" />);

    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('starts in the theme the visitor last chose', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');

    render(<App initialView="tokens" />);

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(screen.getByRole('button', { name: 'Dark theme' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('follows the system preference when the visitor has never chosen', () => {
    stubSystemPrefersDark(true);

    render(<App initialView="tokens" />);

    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('lets a stored light choice overrule a dark system preference', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
    stubSystemPrefersDark(true);

    render(<App initialView="tokens" />);

    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('flips the document theme each time the toggle is pressed', () => {
    render(<App initialView="tokens" />);
    const toggle = screen.getByRole('button', { name: 'Dark theme' });

    fireEvent.click(toggle);

    expect(document.documentElement.dataset.theme).toBe('dark');

    fireEvent.click(toggle);

    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('reports the current theme through the toggle it lives on', () => {
    render(<App initialView="tokens" />);
    const toggle = screen.getByRole('button', { name: 'Dark theme' });

    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-pressed')).toBe('true');
  });

  it('remembers a theme the visitor picked, and only one they picked', () => {
    stubSystemPrefersDark(true);
    render(<App initialView="tokens" />);

    // Rendering dark because the system asked for it is not a choice, so
    // nothing is stored yet — otherwise the visitor's OS switching to light
    // later would be overruled by a preference they never expressed.
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Dark theme' }));

    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });
});

describe('App view switcher', () => {
  it('offers the map first, then the chart views and the token preview', () => {
    render(<App initialView="tokens" />);

    expect(
      screen
        .getAllByRole('button', { name: /Fleet map|Fleet aggregate|Site forecast|Design tokens/ })
        .map((button) => button.textContent),
    ).toEqual(['Fleet map', 'Fleet aggregate', 'Site forecast', 'Design tokens']);
  });

  it('draws the fleet aggregate from the fixture fleet', async () => {
    render(<App initialView="fleet" />);

    expect(screen.getByRole('heading', { name: 'Fleet aggregate' })).toBeDefined();
    expect(await screen.findByRole('img', { name: FLEET_CHART_LABEL })).toBeDefined();
  });

  it('replaces the fleet view with one site when the site tab is pressed', async () => {
    render(<App initialView="fleet" />);
    await screen.findByRole('img', { name: FLEET_CHART_LABEL });

    fireEvent.click(screen.getByRole('button', { name: 'Site forecast' }));

    expect(await screen.findByRole('img', { name: SITE_CHART_LABEL })).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Fleet aggregate' })).toBeNull();
    expect(screen.queryByRole('img', { name: FLEET_CHART_LABEL })).toBeNull();
  });

  it('shows the token preview on its tab, and no chart view with it', async () => {
    render(<App initialView="fleet" />);
    await screen.findByRole('img', { name: FLEET_CHART_LABEL });

    fireEvent.click(screen.getByRole('button', { name: 'Design tokens' }));

    expect(screen.getByRole('heading', { name: 'Colour' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Fleet aggregate' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Site forecast' })).toBeNull();
  });

  it('returns to the fleet view from another tab', async () => {
    render(<App initialView="fleet" />);
    await screen.findByRole('img', { name: FLEET_CHART_LABEL });
    fireEvent.click(screen.getByRole('button', { name: 'Design tokens' }));

    fireEvent.click(screen.getByRole('button', { name: 'Fleet aggregate' }));

    expect(await screen.findByRole('img', { name: FLEET_CHART_LABEL })).toBeDefined();
  });

  it('reports which view is showing through the nav buttons', async () => {
    render(<App initialView="fleet" />);
    await screen.findByRole('img', { name: FLEET_CHART_LABEL });
    const pressedStates = (): readonly (string | null)[] =>
      screen
        .getAllByRole('button', { name: /Fleet map|Fleet aggregate|Site forecast|Design tokens/ })
        .map((button) => button.getAttribute('aria-pressed'));

    expect(pressedStates()).toEqual(['false', 'true', 'false', 'false']);

    fireEvent.click(screen.getByRole('button', { name: 'Site forecast' }));
    await screen.findByRole('img', { name: SITE_CHART_LABEL });

    expect(pressedStates()).toEqual(['false', 'false', 'true', 'false']);
  });
});

describe('App attribution', () => {
  it('credits Open-Meteo exactly once on the fleet view', async () => {
    render(<App initialView="fleet" />);
    await screen.findByRole('img', { name: FLEET_CHART_LABEL });

    expect(screen.getAllByRole('link', { name: 'Open-Meteo.com' })).toHaveLength(1);
  });

  it('credits Open-Meteo exactly once on the site view', async () => {
    render(<App initialView="site" />);
    await screen.findByRole('img', { name: SITE_CHART_LABEL });

    expect(screen.getAllByRole('link', { name: 'Open-Meteo.com' })).toHaveLength(1);
  });
});
