// @vitest-environment jsdom

import type { Site } from '@cumulo/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SiteList } from './SiteList';

afterEach(cleanup);

const DUBLIN_ID = '2a2b2f3c-0000-4000-8000-000000000001';
const CORK_ID = '2a2b2f3c-0000-4000-8000-000000000002';

const siteFixture = (overrides: Partial<Site>): Site => ({
  id: DUBLIN_ID,
  name: 'Rathmines rooftop',
  latitude: 53.3244,
  longitude: -6.2657,
  tiltDegrees: 35,
  azimuthDegrees: 180,
  capacityKw: 4.25,
  ...overrides,
});

const twoSites: readonly Site[] = [
  siteFixture({ id: DUBLIN_ID }),
  siteFixture({ id: CORK_ID, name: 'Douglas rooftop', capacityKw: 6 }),
];

/**
 * Activate an element the way a keyboard user does.
 *
 * jsdom dispatches key events but never performs the *activation behaviour* the
 * HTML spec attaches to Enter on a focused button, so a `keyDown` alone can
 * never reach an `onClick` however the component is built. This performs both
 * halves — and only performs the second when the target really is a `<button>`
 * whose keydown was not cancelled, so a row rebuilt as a clickable `<div>`
 * (which genuinely would be dead to the keyboard) fails here rather than
 * passing on a synthesized click.
 */
const pressEnter = (element: HTMLElement): void => {
  const notCancelled = fireEvent.keyDown(element, { key: 'Enter' });

  if (notCancelled && element instanceof HTMLButtonElement) {
    fireEvent.click(element);
  }
};

describe('SiteList', () => {
  it('renders one row per site, naming it and its capacity', () => {
    render(<SiteList sites={twoSites} selectedSiteId={null} onSelectSite={vi.fn()} />);

    const rows = screen.getAllByRole('button');

    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('Rathmines rooftop');
    expect(rows[0]?.textContent).toContain('4.3 kW');
    expect(rows[1]?.textContent).toContain('6.0 kW');
  });

  it("reports the clicked row's site id", () => {
    const onSelectSite = vi.fn<(siteId: string) => void>();
    render(<SiteList sites={twoSites} selectedSiteId={null} onSelectSite={onSelectSite} />);

    fireEvent.click(screen.getByRole('button', { name: /Douglas rooftop/ }));

    expect(onSelectSite).toHaveBeenCalledTimes(1);
    expect(onSelectSite).toHaveBeenCalledWith(CORK_ID);
  });

  it('selects a row from the keyboard, with no pointer involved', () => {
    const onSelectSite = vi.fn<(siteId: string) => void>();
    render(<SiteList sites={twoSites} selectedSiteId={null} onSelectSite={onSelectSite} />);

    pressEnter(screen.getByRole('button', { name: /Douglas rooftop/ }));

    expect(onSelectSite).toHaveBeenCalledWith(CORK_ID);
  });

  it('marks the selected row, and only that row', () => {
    render(<SiteList sites={twoSites} selectedSiteId={CORK_ID} onSelectSite={vi.fn()} />);

    const selected = screen.getByRole('button', { name: /Douglas rooftop/ });
    const other = screen.getByRole('button', { name: /Rathmines rooftop/ });

    expect(selected.classList.contains('site-row-selected')).toBe(true);
    expect(other.classList.contains('site-row-selected')).toBe(false);
  });

  // Colour never carries a state alone (map-treatment.md): the selected row is
  // announced as the current one, not only painted as it.
  it('announces the selected row to assistive technology', () => {
    render(<SiteList sites={twoSites} selectedSiteId={CORK_ID} onSelectSite={vi.fn()} />);

    const selected = screen.getByRole('button', { name: /Douglas rooftop/ });
    const other = screen.getByRole('button', { name: /Rathmines rooftop/ });

    expect(selected.getAttribute('aria-current')).toBe('true');
    expect(other.getAttribute('aria-current')).toBeNull();
  });
});
