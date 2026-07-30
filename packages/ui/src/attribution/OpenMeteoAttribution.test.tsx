// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenMeteoAttribution } from './OpenMeteoAttribution';

// Vitest runs without global test hooks, so Testing Library's automatic
// cleanup never registers itself — unmount explicitly or renders accumulate in
// the document and later queries match more than one credit.
afterEach(cleanup);

describe('OpenMeteoAttribution', () => {
  it('credits Open-Meteo with the exact wording the CC BY licence requires', () => {
    render(<OpenMeteoAttribution />);

    expect(screen.getByText(/Weather data by/).textContent).toBe('Weather data by Open-Meteo.com');
  });

  it('names the link "Open-Meteo.com" for assistive technology', () => {
    render(<OpenMeteoAttribution />);

    expect(screen.getByRole('link', { name: 'Open-Meteo.com' })).toBeDefined();
  });

  it('points the link at the Open-Meteo home page', () => {
    render(<OpenMeteoAttribution />);

    const link = screen.getByRole('link', { name: 'Open-Meteo.com' });

    expect(link.getAttribute('href')).toBe('https://open-meteo.com/');
  });

  it('withholds the referrer when the credit opens in a new tab', () => {
    render(<OpenMeteoAttribution />);

    const link = screen.getByRole('link', { name: 'Open-Meteo.com' });

    expect(link.getAttribute('rel')?.split(/\s+/)).toContain('noreferrer');
  });
});
