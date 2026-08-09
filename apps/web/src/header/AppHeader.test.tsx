// @vitest-environment jsdom

import type { Site } from '@cumulo/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppHeader } from './AppHeader';

/*
 * The bar's own behaviour, which is what it does with the search when the width
 * runs out: an icon in place of the field, and a bar under the row that opens
 * with the caret already in it.
 *
 * What is asserted here is everything about that arrangement which does not
 * depend on a width. jsdom applies no stylesheet, so both the field and the
 * toggle are always in this document and the breakpoint deciding which of them a
 * reader sees is out of reach by construction (`testing.md` rule 10) — that half
 * is `e2e/header.spec.ts`'s, at a real 390px viewport with real computed styles.
 *
 * The half that *is* reachable here is the one most likely to break silently:
 * where the focus lands. `document.activeElement` after the press is exactly the
 * assertion that fails if `AppHeader`'s `flushSync` goes — React 19 would batch
 * the state change past the end of the handler and the `focus()` would run
 * against an input that is not in the document yet. That is measured rather than
 * trusted: removing the wrapper turns the case below red.
 *
 * What is not here is the combobox itself. `SiteSearch.test.tsx` owns the
 * pattern, and this file only ever asks whether the copy inside the bar is the
 * same working control — once, through one selection.
 */

/** Two names sharing a substring, which is all any case here needs of a fleet. */
const site = (name: string): Site => ({
  id: `id-${name.toLowerCase().replace(/\s/g, '-')}`,
  name,
  latitude: 53.35,
  longitude: -6.26,
  tiltDegrees: 35,
  azimuthDegrees: 180,
  capacityKw: 4.2,
});

const FLEET: readonly Site[] = [site('Dublin rooftop 1'), site('Cork rooftop 1')];

const renderHeader = (onSelectSite: (siteId: Site['id']) => void = () => undefined): void => {
  render(
    <AppHeader
      theme="light"
      onToggleTheme={() => undefined}
      sites={FLEET}
      onSelectSite={onSelectSite}
    />,
  );
};

const searchToggle = (): HTMLElement => screen.getByRole('button', { name: 'Search sites' });

/**
 * The bar under the header row, or `null` while it is closed.
 *
 * By class rather than by role: the bar is a container, not a control — the
 * things with roles are inside it, and this is the query that can tell "closed"
 * from "open and empty".
 */
const searchBar = (): HTMLElement | null => document.querySelector('.header-search-bar');

/**
 * The field inside the bar, which is deliberately not the same element as the
 * one on the row.
 *
 * Scoped to the bar rather than fetched by role from the document, because while
 * the bar is open there really are two comboboxes in this tree — one per width,
 * with the stylesheet showing exactly one of them — and a query that could
 * return either would let a case about the bar pass on the row's field.
 */
const barInput = (): HTMLElement => {
  const bar = searchBar();

  if (bar === null) {
    throw new Error('The search bar is closed, so it has no field to reach into.');
  }

  return within(bar).getByRole('combobox', { name: 'Search sites by name' });
};

afterEach(cleanup);

describe('AppHeader search toggle', () => {
  it('carries its name in an attribute over an icon that says nothing twice', () => {
    renderHeader();

    // The bar's second icon-only control (`HeaderMenu`'s burger was the first),
    // so the same pair of assertions: the accessible name is there, and no text
    // node is — a mark that also announced itself would be announced twice.
    expect(searchToggle().textContent).toBe('');
    expect(searchToggle().getAttribute('aria-expanded')).toBe('false');
  });

  it('opens nothing until it is pressed', () => {
    renderHeader();

    // At rest the bar is not merely hidden but absent, which is what keeps the
    // wide bar to one combobox in the accessibility tree at any width.
    expect(searchBar()).toBe(null);
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
  });

  it('puts the caret in the bar within the press that opened it', () => {
    renderHeader();

    fireEvent.click(searchToggle());

    expect(searchBar()).not.toBe(null);
    expect(searchToggle().getAttribute('aria-expanded')).toBe('true');
    /*
     * The focus, and the field it landed on. This is the whole of the
     * `flushSync` claim: without it React 19 commits the new bar after this
     * handler returns, `focus()` runs against a ref that is still `null`, and a
     * mobile browser never raises its keyboard because nothing was focused
     * while the gesture was live.
     */
    expect(document.activeElement).toBe(barInput());
  });

  it('closes on Escape and puts the reader back on the icon', () => {
    renderHeader();
    fireEvent.click(searchToggle());

    fireEvent.keyDown(barInput(), { key: 'Escape' });

    // Both halves, because a bar that closes while leaving focus on `body` has
    // lost a keyboard reader — `HeaderMenu`'s rule, and the same one.
    expect(searchBar()).toBe(null);
    expect(document.activeElement).toBe(searchToggle());
  });

  it('closes when focus leaves the field', () => {
    renderHeader();
    fireEvent.click(searchToggle());

    fireEvent.focusOut(barInput());

    // A search bar standing over the map after the reader has gone elsewhere is
    // chrome nobody asked to keep.
    expect(searchBar()).toBe(null);
  });

  it('selects a site through the field inside the bar', () => {
    const onSelectSite = vi.fn();
    renderHeader(onSelectSite);
    fireEvent.click(searchToggle());

    fireEvent.change(barInput(), { target: { value: 'Cork' } });
    fireEvent.keyDown(barInput(), { key: 'Enter' });

    // The copy in the bar is the same control and reaches the same handler, not
    // a decorative field that only looks like the one on the wide bar.
    expect(onSelectSite.mock.calls).toEqual([['id-cork-rooftop-1']]);
  });
});
