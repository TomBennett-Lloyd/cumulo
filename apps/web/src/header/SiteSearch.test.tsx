// @vitest-environment jsdom

import type { Site } from '@cumulo/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SiteSearch } from './SiteSearch';

/*
 * The combobox's own behaviour: what it offers, how a keyboard moves through it,
 * and what pressing Enter hands back.
 *
 * This is the app's first ARIA combobox and the repo has no a11y linter
 * (`docs/tech-debt.md`), so the semantics are asserted here rather than assumed:
 * `aria-expanded` tracking the popup, `aria-activedescendant` naming the option
 * the highlight is on, and `aria-selected` marking that same option and no other.
 * Those three attributes *are* the pattern — a highlight a sighted reader can see
 * and a screen reader cannot is the exact failure the pattern exists to prevent —
 * so they are assertions rather than implementation detail.
 *
 * What is deliberately not here is the composition: that a selection made in this
 * control reaches the map and the chart is the dashboard's wiring, asserted in
 * `dashboard/Dashboard.focus.test.tsx`, and that a site the camera cannot see is
 * brought into view is the browser lane's (`e2e/header.spec.ts`, `testing.md`
 * rule 10).
 */

/** A fleet with two names that share a substring and one that does not. */
const site = (name: string, capacityKw: number): Site => ({
  id: `id-${name.toLowerCase().replace(/\s/g, '-')}`,
  name,
  latitude: 53.35,
  longitude: -6.26,
  tiltDegrees: 35,
  azimuthDegrees: 180,
  capacityKw,
});

const FLEET: readonly Site[] = [
  site('Dublin rooftop 1', 4.2),
  site('Dublin rooftop 2', 3.1),
  site('Cork rooftop 1', 5.5),
];

/** The fleet, plus whatever a caller wants to know about a selection. */
const renderSearch = (onSelectSite: (siteId: Site['id']) => void = () => undefined): void => {
  render(<SiteSearch sites={FLEET} onSelectSite={onSelectSite} />);
};

const searchInput = (): HTMLInputElement =>
  screen.getByRole('combobox', { name: 'Search sites by name' });

/** Types into the field the way a reader does — one value change, as React sees it. */
const typeQuery = (query: string): void => {
  fireEvent.change(searchInput(), { target: { value: query } });
};

/** The options currently offered, by their visible text. */
const optionNames = (): readonly string[] =>
  screen.queryAllByRole('option').map((option) => option.textContent);

/** The option `aria-activedescendant` points at, or `null` when it points at nothing. */
const activeOption = (): HTMLElement | null => {
  const id = searchInput().getAttribute('aria-activedescendant');

  return id === null ? null : document.getElementById(id);
};

afterEach(cleanup);

describe('SiteSearch before anything is typed', () => {
  it('offers no list, and says the popup is closed', () => {
    renderSearch();

    expect(searchInput().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('listbox')).toBe(null);
    /*
     * And points at nothing, which is the half that is easy to get wrong. An
     * empty query matches every site, so there *is* a highlighted match at first
     * paint — it simply has no list to sit in, and an
     * `aria-activedescendant` naming an element that is not in the document is
     * an invalid value rather than a leftover nobody reads. This is the state
     * the app is in on every page load, so it is pinned where the closed state
     * is described rather than in a case of its own.
     */
    expect(searchInput().getAttribute('aria-activedescendant')).toBe(null);
  });
});

describe('SiteSearch filtering', () => {
  it('offers the sites whose names contain what was typed, case-insensitively', () => {
    renderSearch();

    typeQuery('dublin');

    // Cork is absent rather than merely last: a filter that only reordered
    // would pass an assertion about the first match and still make the reader
    // read past every site in the fleet.
    expect(optionNames()).toEqual(['Dublin rooftop 14.2 kW', 'Dublin rooftop 23.1 kW']);
  });

  it('matches a substring from the middle of a name, not just its start', () => {
    renderSearch();

    typeQuery('rooftop 1');

    // The fleet's names are "<place> rooftop <n>", so a prefix-only match would
    // make the place the only searchable half of every name in the app.
    expect(optionNames()).toEqual(['Dublin rooftop 14.2 kW', 'Cork rooftop 15.5 kW']);
  });

  it('opens on the first character rather than waiting for a longer query', () => {
    renderSearch();

    typeQuery('c');

    expect(searchInput().getAttribute('aria-expanded')).toBe('true');
    expect(optionNames()).toEqual(['Cork rooftop 15.5 kW']);
  });

  it('says so when nothing matches, rather than offering an empty list', () => {
    renderSearch();

    typeQuery('Reykjavik');

    // Visible, and inside the popup: a control that answers a query with silence
    // leaves a reader unable to tell "no such site" from "the search is broken".
    expect(optionNames()).toEqual(['No matching sites']);
    expect(
      screen.getByRole('option', { name: 'No matching sites' }).getAttribute('aria-disabled'),
    ).toBe('true');
    // And it is never what Enter would act on, which is why it may sit in a
    // listbox at all.
    expect(activeOption()).toBe(null);
  });
});

describe('SiteSearch keyboard traversal', () => {
  it('starts on the first match, so typing a name and pressing Enter is the whole gesture', () => {
    renderSearch();

    typeQuery('Dublin');

    expect(activeOption()?.textContent).toBe('Dublin rooftop 14.2 kW');
    expect(activeOption()?.getAttribute('aria-selected')).toBe('true');
  });

  it('moves the active option down and back up again', () => {
    renderSearch();
    typeQuery('Dublin');

    fireEvent.keyDown(searchInput(), { key: 'ArrowDown' });

    expect(activeOption()?.textContent).toBe('Dublin rooftop 23.1 kW');

    fireEvent.keyDown(searchInput(), { key: 'ArrowUp' });

    expect(activeOption()?.textContent).toBe('Dublin rooftop 14.2 kW');
  });

  it('marks exactly one option as selected as the highlight moves', () => {
    renderSearch();
    typeQuery('Dublin');

    fireEvent.keyDown(searchInput(), { key: 'ArrowDown' });

    const selected = screen
      .getAllByRole('option')
      .filter((option) => option.getAttribute('aria-selected') === 'true');

    // Two highlighted options would leave a screen reader announcing one and a
    // sighted reader looking at the other.
    expect(selected).toHaveLength(1);
    expect(selected[0]).toBe(activeOption());
  });

  it('stops at the ends of the list instead of wrapping round', () => {
    renderSearch();
    typeQuery('Dublin');

    fireEvent.keyDown(searchInput(), { key: 'ArrowUp' });

    // Already on the first match. Wrapping here would put the reader on the last
    // one, which is indistinguishable from the list having scrolled.
    expect(activeOption()?.textContent).toBe('Dublin rooftop 14.2 kW');

    fireEvent.keyDown(searchInput(), { key: 'ArrowDown' });
    fireEvent.keyDown(searchInput(), { key: 'ArrowDown' });

    expect(activeOption()?.textContent).toBe('Dublin rooftop 23.1 kW');
  });
});

describe('SiteSearch selecting a match', () => {
  it('hands back the id of the option the highlight was on', () => {
    const onSelectSite = vi.fn();
    renderSearch(onSelectSite);
    typeQuery('Dublin');
    fireEvent.keyDown(searchInput(), { key: 'ArrowDown' });

    fireEvent.keyDown(searchInput(), { key: 'Enter' });

    // The second Dublin site, not the first: a control that always answered with
    // the top match would pass every assertion about *a* selection while making
    // the arrow keys decorative.
    expect(onSelectSite.mock.calls).toEqual([['id-dublin-rooftop-2']]);
  });

  it('clears the field and closes the list once a site is chosen', () => {
    renderSearch();
    typeQuery('Dublin');

    fireEvent.keyDown(searchInput(), { key: 'Enter' });

    // Left as it was, the popup would sit over the map describing a search the
    // reader has already finished, and the next search would start from the
    // last answer rather than from the fleet.
    expect(searchInput().value).toBe('');
    expect(searchInput().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('listbox')).toBe(null);
  });

  it('leaves the keys alone while an input method is composing a candidate', () => {
    const onSelectSite = vi.fn();
    renderSearch(onSelectSite);
    typeQuery('Dublin');

    fireEvent.keyDown(searchInput(), { key: 'ArrowDown', isComposing: true });
    fireEvent.keyDown(searchInput(), { key: 'Enter', isComposing: true });

    /*
     * The candidate window owns all three keys while it is up: Enter commits the
     * word being composed and the arrows walk the candidate list. A control that
     * also acted on them would answer one keystroke twice — selecting a site with
     * the press that finishes a Japanese or Chinese word — and would swallow the
     * navigation the candidate list needs.
     */
    expect(onSelectSite).not.toHaveBeenCalled();
    expect(activeOption()?.textContent).toBe('Dublin rooftop 14.2 kW');
  });

  it('does nothing on Enter when nothing matches', () => {
    const onSelectSite = vi.fn();
    renderSearch(onSelectSite);
    typeQuery('Reykjavik');

    fireEvent.keyDown(searchInput(), { key: 'Enter' });

    expect(onSelectSite).not.toHaveBeenCalled();
  });

  it('selects the option a pointer presses', () => {
    const onSelectSite = vi.fn();
    renderSearch(onSelectSite);
    typeQuery('Dublin');

    fireEvent.mouseDown(screen.getByRole('option', { name: /Dublin rooftop 2/ }));

    // `mousedown` is the whole point: the field's blur closes the popup, so a
    // handler on `click` would fire on an option that had already unmounted.
    expect(onSelectSite.mock.calls).toEqual([['id-dublin-rooftop-2']]);
  });
});

describe('SiteSearch handle', () => {
  it('points an offered ref at the field itself, not at the box around it', () => {
    const inputRef = createRef<HTMLInputElement>();

    render(<SiteSearch sites={FLEET} onSelectSite={() => undefined} inputRef={inputRef} />);

    /*
     * The prop's whole contract, asserted where the prop lives. A handle on the
     * wrapper — or on nothing — would still let a caller write `focus()` and
     * would still leave the caret nowhere.
     *
     * `AppHeader.test.tsx` asserts something different rather than this again:
     * *when* the focus happens, which is inside the press that opens the
     * collapsed search bar and is the reason this prop exists at all.
     */
    expect(inputRef.current).toBe(searchInput());
  });
});

describe('SiteSearch dismissal', () => {
  it('closes the list on Escape while keeping what was typed', () => {
    renderSearch();
    typeQuery('Dublin');

    fireEvent.keyDown(searchInput(), { key: 'Escape' });

    expect(searchInput().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('listbox')).toBe(null);
    // The second closed state, and the same rule: a dismissed popup leaves no
    // active descendant behind pointing at an option that has gone.
    expect(searchInput().getAttribute('aria-activedescendant')).toBe(null);
    // Escape dismisses the popup, not the reader's work: clearing the field here
    // would make a mistyped last character cost the whole query.
    expect(searchInput().value).toBe('Dublin');
  });

  it('reopens the list when the reader arrows back into it', () => {
    renderSearch();
    typeQuery('Dublin');
    fireEvent.keyDown(searchInput(), { key: 'Escape' });

    fireEvent.keyDown(searchInput(), { key: 'ArrowDown' });

    // Without this the field keeps a query it will never answer again, and the
    // only way back is to retype the last character.
    expect(searchInput().getAttribute('aria-expanded')).toBe('true');
    expect(optionNames()).toHaveLength(2);
  });

  it('closes the list when focus leaves the field', () => {
    renderSearch();
    typeQuery('Dublin');

    fireEvent.blur(searchInput());

    expect(screen.queryByRole('listbox')).toBe(null);
  });
});
