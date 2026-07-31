// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MapAttributionStrip } from './MapAttributionStrip';

// Vitest runs without global test hooks, so Testing Library's automatic cleanup
// never registers itself — unmount explicitly or renders accumulate and later
// queries match more than one credit.
afterEach(cleanup);

describe('MapAttributionStrip', () => {
  it('credits OpenStreetMap contributors as the tile data source', () => {
    render(<MapAttributionStrip />);

    const credit = screen.getByRole('link', { name: '© OpenStreetMap contributors' });

    expect(credit.getAttribute('href')).toBe('https://www.openstreetmap.org/copyright');
  });

  it('credits OpenFreeMap as the style and tile host', () => {
    render(<MapAttributionStrip />);

    const credit = screen.getByRole('link', { name: 'OpenFreeMap' });

    expect(credit.getAttribute('href')).toBe('https://openfreemap.org/');
  });

  it('carries the Open-Meteo credit the CC BY licence requires', () => {
    render(<MapAttributionStrip />);

    const credit = screen.getByRole('link', { name: 'Open-Meteo.com' });

    expect(credit.getAttribute('href')).toBe('https://open-meteo.com/');
  });

  it('shows both credits with no interaction at all', () => {
    // The licence conditions are met by what is on screen, not by what a
    // reader could reveal: this test deliberately clicks, hovers and expands
    // nothing between rendering and asserting. A strip that hid either credit
    // behind a control would still pass the two tests above.
    render(<MapAttributionStrip />);

    const links = screen.getAllByRole('link').map((link) => link.textContent);

    expect(links).toContain('© OpenStreetMap contributors');
    expect(links).toContain('Open-Meteo.com');
  });

  it('reads the tile credit before the weather credit', () => {
    // Reading order matches what the reader is looking at: the map, then the
    // data drawn on it.
    render(<MapAttributionStrip />);

    const [first] = screen.getAllByRole('link');

    expect(first?.textContent).toBe('© OpenStreetMap contributors');
  });
});
