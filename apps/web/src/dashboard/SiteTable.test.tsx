// @vitest-environment jsdom

import type { Site } from '@cumulo/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SiteTable } from './SiteTable';

afterEach(cleanup);

const DUBLIN_ID = '2a2b2f3c-0000-4000-8000-000000000001';
const CORK_ID = '2a2b2f3c-0000-4000-8000-000000000002';
const GALWAY_ID = '2a2b2f3c-0000-4000-8000-000000000003';

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
  siteFixture({ id: CORK_ID, name: 'Douglas rooftop', capacityKw: 6, latitude: 51.7924 }),
];

/**
 * Activate an element the way a keyboard user does.
 *
 * jsdom dispatches key events but never performs the *activation behaviour* the
 * HTML spec attaches to Enter on a focused button, so a `keyDown` alone can
 * never reach an `onClick` however the component is built. This performs both
 * halves — and only performs the second when the target really is a `<button>`
 * whose keydown was not cancelled, so a row rebuilt as a clickable cell (which
 * genuinely would be dead to the keyboard) fails here rather than passing on a
 * synthesized click.
 */
const pressEnter = (element: HTMLElement): void => {
  const notCancelled = fireEvent.keyDown(element, { key: 'Enter' });

  if (notCancelled && element instanceof HTMLButtonElement) {
    fireEvent.click(element);
  }
};

/**
 * The disclosure itself, whose `open` is the state these cases are about.
 *
 * Read off the DOM rather than through a role query because what is being
 * asserted is the element's own property, not what a reader can see: jsdom
 * omits the `<details>` shadow-tree styles, so a closed disclosure hides
 * nothing here and a visibility assertion would be measuring nothing. That
 * half — a reader reaching the rows only after opening it — is the browser
 * lane's, and `e2e/keyboard-focus.spec.ts` is where it is asserted
 * (`testing.md` rule 10).
 */
const disclosure = (container: HTMLElement): HTMLDetailsElement => {
  const element = container.querySelector('details');

  if (element === null) {
    throw new Error('The site table rendered no disclosure to open.');
  }

  return element;
};

const summaryText = (container: HTMLElement): string | undefined =>
  container.querySelector('.site-table-summary')?.textContent ?? undefined;

describe('SiteTable', () => {
  it('renders one row per site, naming it with its capacity and coordinates', () => {
    render(<SiteTable sites={twoSites} selectedSiteId={null} onSelectSite={vi.fn()} />);

    const rows = screen.getAllByRole('row').slice(1);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('Rathmines rooftop');
    expect(rows[0]?.textContent).toContain('4.3 kW');
    expect(rows[0]?.textContent).toContain('53.3244, -6.2657');
    expect(rows[1]?.textContent).toContain('6.0 kW');
  });

  it("reports the clicked row's site id", () => {
    const onSelectSite = vi.fn<(siteId: string) => void>();
    render(<SiteTable sites={twoSites} selectedSiteId={null} onSelectSite={onSelectSite} />);

    fireEvent.click(screen.getByRole('button', { name: 'Douglas rooftop' }));

    expect(onSelectSite).toHaveBeenCalledTimes(1);
    expect(onSelectSite).toHaveBeenCalledWith(CORK_ID);
  });

  it('selects a row from the keyboard, with no pointer involved', () => {
    const onSelectSite = vi.fn<(siteId: string) => void>();
    render(<SiteTable sites={twoSites} selectedSiteId={null} onSelectSite={onSelectSite} />);

    pressEnter(screen.getByRole('button', { name: 'Douglas rooftop' }));

    expect(onSelectSite).toHaveBeenCalledWith(CORK_ID);
  });

  it('marks the selected row, and only that row', () => {
    render(<SiteTable sites={twoSites} selectedSiteId={CORK_ID} onSelectSite={vi.fn()} />);

    const selected = screen.getByRole('button', { name: 'Douglas rooftop' });
    const other = screen.getByRole('button', { name: 'Rathmines rooftop' });

    expect(selected.classList.contains('site-table-select-selected')).toBe(true);
    expect(other.classList.contains('site-table-select-selected')).toBe(false);
  });

  // Colour never carries a state alone (map-treatment.md): the selected row is
  // announced as the current one, not only painted as it.
  it('announces the selected row to assistive technology', () => {
    render(<SiteTable sites={twoSites} selectedSiteId={CORK_ID} onSelectSite={vi.fn()} />);

    const selected = screen.getByRole('button', { name: 'Douglas rooftop' });
    const other = screen.getByRole('button', { name: 'Rathmines rooftop' });

    expect(selected.getAttribute('aria-current')).toBe('true');
    expect(other.getAttribute('aria-current')).toBeNull();
  });

  // The whole reason the list became a disclosure (#265): sixty rows open under
  // the chart pushed the rest of the reading off the page, and the header's
  // search is the lookup path now. A table that shipped open would put it back.
  it('stays folded away until a reader opens it', () => {
    const { container } = render(
      <SiteTable sites={twoSites} selectedSiteId={null} onSelectSite={vi.fn()} />,
    );

    expect(disclosure(container).open).toBe(false);
  });

  it('counts the fleet it was handed rather than a fixed size', () => {
    const { container, rerender } = render(
      <SiteTable sites={twoSites} selectedSiteId={null} onSelectSite={vi.fn()} />,
    );

    expect(summaryText(container)).toBe('Sites (2)');

    // A site added this session is in the fleet the moment it exists, so the
    // count moves with it. Fleet size is a restated-value family (#249): the
    // second render is what separates reading `sites.length` from spelling the
    // seed's own sixty, or this fixture's two.
    rerender(
      <SiteTable
        sites={[...twoSites, siteFixture({ id: GALWAY_ID, name: 'Salthill rooftop' })]}
        selectedSiteId={null}
        onSelectSite={vi.fn()}
      />,
    );

    expect(summaryText(container)).toBe('Sites (3)');
  });
});
