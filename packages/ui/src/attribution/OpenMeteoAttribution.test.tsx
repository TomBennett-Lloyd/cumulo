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

    /*
     * Reached through the link rather than by text, with the assertion below
     * left exactly as it was. Testing Library matches text against an element's
     * *direct* text children (`getNodeText`), so once the droppable prefix moved
     * into its own span, `getByText(/Weather data by/)` stopped resolving to the
     * credit and started resolving to the span — reading back "Weather data by "
     * and nothing more. Anchoring on the link and widening to the credit pins
     * the whole phrase again, and pins strictly more than the old query did: the
     * text that happened to sit directly under `<small>` was a fragment of the
     * credit, this is all of it.
     */
    const credit = screen
      .getByRole('link', { name: 'Open-Meteo.com' })
      .closest('.cumulo-attribution');

    expect(credit?.textContent).toBe('Weather data by Open-Meteo.com');
  });

  it('wraps the droppable prefix in the compact-form class', () => {
    /*
     * The class is a contract, not decoration: a surface whose row as composed
     * cannot hold its credits' full forms hides exactly this element to reach
     * the compact form CLAUDE.md sanctions, and `apps/web/src/map/map.css` is
     * the only one that does — its band is the one row in the app carrying a
     * second credit beside this one. Which rows meet that condition is
     * `docs/design/map-treatment.md`'s Attribution section to say (#356); a row
     * this credit has to itself is composed of this phrase alone and holds its
     * full form at every width, so it never meets it. The last assertion is the
     * one with teeth — a wrapper that had swallowed the anchor would take the
     * non-negotiable half of the credit down with the prose, and would still
     * satisfy the two above it.
     */
    render(<OpenMeteoAttribution />);

    const prefix = screen.getByText('Weather data by');

    expect(prefix.tagName).toBe('SPAN');
    expect(prefix.className).toBe('cumulo-attribution-prefix');
    expect(prefix.querySelector('a')).toBeNull();
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
