// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { THEME_STORAGE_KEY } from '../theme';
import { TokensHarness } from './TokensHarness';

/*
 * What is worth asserting here is the harness's own wiring, not the gallery's
 * contents: `TokensPreview.test.tsx` already walks the token set and proves
 * every token is on screen. So one test checks that the harness actually mounts
 * that gallery, and the rest cover the toggle — the reason this page has a
 * shell at all, since a token set is two palettes and the toggle is how a
 * reviewer sees the second one.
 */

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
// otherwise, so each test states the system preference it is written against
// rather than inheriting jsdom's.
const stubSystemPrefersDark = (prefersDark: boolean): void => {
  vi.stubGlobal('matchMedia', (media: string) => mediaQueryList(media, prefersDark));
};

beforeEach(() => {
  stubSystemPrefersDark(false);
});

// Vitest runs without global test hooks, so Testing Library's automatic cleanup
// never registers itself. The theme attribute and the stored preference are
// document- and origin-level state this harness deliberately writes, so each
// has to be reset too — otherwise one test's dark mode is the next test's start.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe('TokensHarness', () => {
  it('mounts the token gallery inside its shell', () => {
    render(<TokensHarness />);

    expect(screen.getByRole('heading', { name: 'Cumulo design tokens' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Colour' })).toBeDefined();
  });

  it('themes the document and stores the choice when the toggle is pressed', () => {
    render(<TokensHarness />);
    const toggle = screen.getByRole('button', { name: 'Dark theme' });

    expect(document.documentElement.dataset.theme).toBe('light');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(toggle);

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('starts in the theme the reviewer last chose', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');

    render(<TokensHarness />);

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(screen.getByRole('button', { name: 'Dark theme' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });
});
