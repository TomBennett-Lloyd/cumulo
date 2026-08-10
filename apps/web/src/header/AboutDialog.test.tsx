// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AboutDialog } from './AboutDialog';
import { PRODUCT_TAGLINE } from './header-copy';

/*
 * What jsdom can say about a `<dialog>`, and what it cannot.
 *
 * jsdom 30 implements `HTMLDialogElement` with `open` and nothing else — no
 * `showModal`, no `close` (`constructor,open` is the whole prototype). So every
 * property that needs a top layer is out of this lane's reach by construction:
 * modality, the backdrop, the page behind going inert, Escape raising `cancel`,
 * and the focus restoration the browser performs on the way out. Those are the
 * browser lane's (`testing.md` rule 10) and `e2e/header.spec.ts` drives them
 * through a real Chromium — including the Escape path, which is the one a
 * keyboard reader actually uses.
 *
 * Standing a fake `showModal` up here would not have moved that line, only
 * hidden it: the suite would assert that a stub was called and still know
 * nothing about modality.
 *
 * What is left is genuinely this lane's, and it is the part a licence auditor
 * cares about: what is in the document when the dialog is open, what is *not*
 * in it when the dialog is closed, and that the component's one control means
 * what it says.
 */

/** The two source credits the dialog owes, by the link text each is found by. */
const SOURCE_LINKS = {
  weather: 'Open-Meteo.com',
  tiles: '© OpenStreetMap contributors',
  basemap: 'OpenFreeMap',
} as const;

afterEach(cleanup);

describe('AboutDialog when closed', () => {
  it('puts none of its content in the document', () => {
    render(<AboutDialog open={false} onClose={() => undefined} />);

    // Not merely invisible. The dialog element stays mounted so the component
    // has a stable ref to drive, but a closed dialog still holding the tagline
    // and a third weather credit would be counted by anything reading the page
    // as text — `App.test.tsx`'s "once" and "exactly two" counts among them.
    expect(screen.queryByRole('heading', { name: 'About Cumulo' })).toBe(null);
    expect(screen.queryByText(PRODUCT_TAGLINE)).toBe(null);
    expect(screen.queryByRole('link', { name: SOURCE_LINKS.weather })).toBe(null);
  });
});

describe('AboutDialog when open', () => {
  it('opens the element itself, not merely its React state', () => {
    const { container } = render(<AboutDialog open onClose={() => undefined} />);

    // The one thing about the dialog *element* this lane can measure, and it is
    // load-bearing rather than incidental: `open` is what takes the user
    // agent's `dialog:not([open]) { display: none }` off the content, so every
    // by-role query in this file (and the third-credit count in
    // `App.test.tsx`) finds nothing without it. In a browser the same line of
    // the component reaches for `showModal` instead, and the top-layer half of
    // what that does is `e2e/header.spec.ts`'s to prove.
    expect(container.querySelector('dialog')?.hasAttribute('open')).toBe(true);
  });

  it('says what the product is, quoting the tagline rather than a second copy of it', () => {
    render(<AboutDialog open onClose={() => undefined} />);

    expect(screen.getByRole('heading', { name: 'About Cumulo' })).toBeDefined();
    // The same constant the header renders. Asserted against the export rather
    // than a literal so that editing the sentence in its one home cannot leave
    // this passing against the old words (`architecture.md` rule 9).
    expect(screen.getByText(PRODUCT_TAGLINE)).toBeDefined();
  });

  it('calls the per-site band simulated rather than promising a modelled one', () => {
    render(<AboutDialog open onClose={() => undefined} />);

    // #295's capability claim, in the one place the product explains itself to a
    // first-time reader. The envelope is a deterministic width this codebase
    // attaches to every stored row (`@cumulo/shared`'s `simulated-uncertainty.ts`),
    // not an ensemble the physics model produced — so the qualifier is the whole
    // difference between a description and an over-claim, and it is pinned here
    // for the same reason `FleetPanel.test.tsx` pins #264's "simulated actuals".
    expect(screen.getByText(/Every site on the map/u).textContent).toContain(
      'simulated uncertainty band',
    );
  });

  it('credits every source the app draws on, with the licence links', () => {
    render(<AboutDialog open onClose={() => undefined} />);

    // Open-Meteo is CC BY 4.0 and a hard constraint of this repo; the other two
    // are the basemap's own obligation. The hrefs are asserted, not just the
    // text: a credit that names a provider without linking to it is decoration.
    expect(screen.getByRole('link', { name: SOURCE_LINKS.weather }).getAttribute('href')).toBe(
      'https://open-meteo.com/',
    );
    expect(screen.getByRole('link', { name: SOURCE_LINKS.tiles }).getAttribute('href')).toBe(
      'https://www.openstreetmap.org/copyright',
    );
    expect(screen.getByRole('link', { name: SOURCE_LINKS.basemap }).getAttribute('href')).toBe(
      'https://openfreemap.org/',
    );
  });

  it('offers a pointer reader a way out', () => {
    const onClose = vi.fn();
    render(<AboutDialog open onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    // The component does not close itself: the parent owns `open`, and this is
    // the whole of the dialog's say in the matter.
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
