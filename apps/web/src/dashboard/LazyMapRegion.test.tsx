// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LazyMapRegion, MapRegionFallback } from './LazyMapRegion';

/*
 * The two states of the map region that no browser and no source scan proves.
 *
 * `map-region-split-contract.test.ts` reads this component's *source* — it can
 * say the markup is written, never that it renders. The browser smoke test
 * exercises the happy path, where the chunk arrives. What is left is what a
 * visitor sees while it has not arrived, and what they see when it never will,
 * and both are assertable here because neither reaches maplibre: the placeholder
 * is plain DOM, and the failure path is reached by making the import itself
 * reject.
 *
 * The mock below is not a stand-in for maplibre — nothing here asserts that a
 * mock was called (`testing.md` rule 3). It is the only way to produce the real
 * production failure: a `<script>` fetch for a hashed chunk that 404s, which is
 * what an `index.html` cached from before a redeploy does to every visitor
 * holding it.
 */
vi.mock('./MapRegion', () => {
  throw new Error('Failed to fetch dynamically imported module');
});

const mapRegionProps = {
  theme: 'light',
  sites: [],
  selectedSiteId: null,
  onSelectSite: () => undefined,
  onMapClick: () => undefined,
} as const;

// Vitest runs without global test hooks, so Testing Library's automatic cleanup
// never registers itself — unmount explicitly or renders accumulate and the
// attribution queries below match more than one credit.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('MapRegionFallback', () => {
  it('keeps the Open-Meteo credit visible while the map chunk loads', () => {
    // The CC BY obligation is not suspended by a slow network: the credit has
    // to be on screen for the whole window in which the map is missing.
    render(<MapRegionFallback />);

    expect(screen.getByRole('link', { name: 'Open-Meteo.com' }).getAttribute('href')).toBe(
      'https://open-meteo.com/',
    );
  });

  it('says the map is loading as busy content, not as a live region', () => {
    // `react.md`'s async surface convention: a `role="status"` mounted with its
    // text already inside it has no change to report, so it announces nothing
    // and only looks accessible. The pending state is therefore an `aria-busy`
    // container with a visible label — and the second assertion is the negative
    // control, because the first one would pass just as happily with the old
    // live region still wrapped around it.
    render(<MapRegionFallback />);

    expect(screen.getByText('Loading map…').getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByRole('status')).toBe(null);
  });
});

describe('LazyMapRegion when the map chunk never arrives', () => {
  beforeEach(() => {
    // React reports every error a boundary catches to `console.error` as well,
    // so this keeps a deliberate failure from reading as a broken test run.
    // Spied rather than silenced wholesale: the boundary's own log is asserted.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('shows a failure where the map would be instead of unmounting the page', async () => {
    render(
      <div>
        <p>Fleet list</p>
        <LazyMapRegion {...mapRegionProps} />
      </div>,
    );

    const failure = await screen.findByRole('alert');

    expect(failure.textContent).toContain('The map could not be loaded');
    // The whole point of a local boundary: everything beside the map survives.
    expect(screen.getByText('Fleet list')).toBeDefined();
  });

  it('still credits Open-Meteo when the map has failed', async () => {
    render(<LazyMapRegion {...mapRegionProps} />);
    await screen.findByRole('alert');

    expect(screen.getByRole('link', { name: 'Open-Meteo.com' }).getAttribute('href')).toBe(
      'https://open-meteo.com/',
    );
  });

  it('logs the failure rather than swallowing it', async () => {
    render(<LazyMapRegion {...mapRegionProps} />);
    await screen.findByRole('alert');

    // `error-handling.md` rule 2c: the boundary is where the error stops, which
    // is only acceptable if it stops visibly.
    expect(
      vi
        .mocked(console.error)
        .mock.calls.some(([first]) => first === 'The map region failed to load'),
    ).toBe(true);
  });
});
