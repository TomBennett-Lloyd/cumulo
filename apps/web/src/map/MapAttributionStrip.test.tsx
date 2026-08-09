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

  it('wraps the droppable tile prefix in the compact-form class', () => {
    // `map.css` hides exactly this element below the width at which the band's
    // row stops fitting on one line. The last assertion is what keeps that safe:
    // the OSM tile credit is a licence condition like the weather one, so a
    // wrapper that had swallowed either anchor would drop a credit at narrow
    // widths rather than shortening a sentence.
    render(<MapAttributionStrip />);

    const prefix = screen.getByText('basemap tiles by');

    expect(prefix.tagName).toBe('SPAN');
    expect(prefix.className).toBe('map-attribution-prefix');
    expect(prefix.querySelector('a')).toBeNull();
  });

  it('reads as one sentence with the prefix in place, separator and spacing intact', () => {
    // The compact form is computed visibility and nothing else, so this text is
    // what the DOM says at every width — what a reader with stylesheets off, or
    // anything honouring the licence by parsing rather than painting, receives.
    // Pinning it makes "only the painting changes" a checked claim instead of a
    // comment, and it is what catches the prefix span landing with the spaces
    // around it in the wrong place.
    const { container } = render(<MapAttributionStrip />);

    expect(container.querySelector('.map-attribution-tiles')?.textContent).toBe(
      '© OpenStreetMap contributors · basemap tiles by OpenFreeMap',
    );
  });

  it('reads the tile credit before the weather credit', () => {
    // Reading order matches what the reader is looking at: the map, then the
    // data drawn on it.
    render(<MapAttributionStrip />);

    const [first] = screen.getAllByRole('link');

    expect(first?.textContent).toBe('© OpenStreetMap contributors');
  });
});
