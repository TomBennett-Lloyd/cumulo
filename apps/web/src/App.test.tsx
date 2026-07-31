// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { THEME_STORAGE_KEY } from './theme';

/*
 * These tests render the shell on its token-preview surface rather than its
 * default dashboard surface, and that is a limitation worth stating plainly:
 * the dashboard mounts maplibre, which needs WebGL, which jsdom does not
 * implement. Standing up a fake maplibre to get past it would leave the suite
 * asserting that a mock was called (testing.md rule 3) — so the map adapter is
 * covered in a real browser or not at all, and `MapView` is kept thin for
 * exactly that reason. Everything asserted below is the shell's own behaviour
 * and is identical on both surfaces.
 */
const TOKENS_HASH = '#tokens';

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
  window.location.hash = TOKENS_HASH;
});

// Vitest runs without global test hooks, so Testing Library's automatic cleanup
// never registers itself. The theme attribute, the stored preference and the
// hash are all document- or origin-level state this app deliberately writes, so
// each has to be reset too — otherwise one test's dark mode is the next test's
// starting point.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.location.hash = '';
  delete document.documentElement.dataset.theme;
});

describe('App', () => {
  it('themes the document light when nothing is stored and the system prefers light', () => {
    stubSystemPrefersDark(false);

    render(<App />);

    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('starts in the theme the visitor last chose', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    stubSystemPrefersDark(false);

    render(<App />);

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(screen.getByRole('button', { name: 'Dark theme' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('follows the system preference when the visitor has never chosen', () => {
    stubSystemPrefersDark(true);

    render(<App />);

    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('lets a stored light choice overrule a dark system preference', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
    stubSystemPrefersDark(true);

    render(<App />);

    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('flips the document theme each time the toggle is pressed', () => {
    stubSystemPrefersDark(false);
    render(<App />);
    const toggle = screen.getByRole('button', { name: 'Dark theme' });

    fireEvent.click(toggle);

    expect(document.documentElement.dataset.theme).toBe('dark');

    fireEvent.click(toggle);

    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('reports the current theme through the toggle it lives on', () => {
    stubSystemPrefersDark(false);
    render(<App />);
    const toggle = screen.getByRole('button', { name: 'Dark theme' });

    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-pressed')).toBe('true');
  });

  it('remembers a theme the visitor picked, and only one they picked', () => {
    stubSystemPrefersDark(true);
    render(<App />);

    // Rendering dark because the system asked for it is not a choice, so
    // nothing is stored yet — otherwise the visitor's OS switching to light
    // later would be overruled by a preference they never expressed.
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Dark theme' }));

    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('keeps the token preview reachable while the app has no router', () => {
    stubSystemPrefersDark(false);

    render(<App />);

    expect(screen.getByRole('heading', { name: 'Map markers' })).toBeDefined();
  });
});
