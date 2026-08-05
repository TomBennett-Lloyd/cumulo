// @vitest-environment jsdom

import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DemoFleetDataSource } from '../data/demo-fleet-data-source';
import {
  armAddSite,
  clickBasemap,
  clickMap,
  CREATED_SITE_NAME,
  firstListedSite,
  fleetList,
  fleetPanel,
  renderDashboard,
  settle,
  submitDraft,
  visit,
} from './dashboard-test-fixture';

/*
 * The draft as a modal, and what that changed about the page behind it.
 *
 * The fourth subject split off the same mount (`structure.md` rule 4), through
 * the same fixture — the composition is `Dashboard.test.tsx`'s, the `?site=`
 * link is `Dashboard.deep-link.test.tsx`'s, and managed focus is
 * `Dashboard.focus.test.tsx`'s, which is where this dialog's focus return is
 * asserted rather than here.
 *
 * What jsdom can say about a `<dialog>` and what it cannot is the same line
 * `header/AboutDialog.test.tsx` draws, and for the same reason: jsdom 30
 * implements `HTMLDialogElement` with `open` and nothing else. So modality
 * itself — the top layer, the backdrop, the page going inert, Escape raising
 * `cancel` — is out of reach here by construction and belongs to the browser
 * lane (`testing.md` rule 10), where `e2e/map-regressions.spec.ts` drives
 * Escape through a real Chromium. What is left is genuinely this lane's: which
 * things are in the document, in which state, and what the dashboard does with
 * the dialog's two answers.
 */

const draftDialog = (root: HTMLElement): HTMLElement | null =>
  root.querySelector('.add-site-dialog');

beforeEach(() => {
  // The creation path runs through the throttle and the first-forecast poll, so
  // the clock is simulated here as in every dashboard suite. Nothing sleeps.
  vi.useFakeTimers();
  visit('/');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  visit('/');
});

describe('Dashboard draft dialog', () => {
  it('opens the form in a dialog when an armed map click lands', async () => {
    const container = renderDashboard(new DemoFleetDataSource());
    await settle();

    expect(draftDialog(container)).toBeNull();

    armAddSite();
    clickBasemap();

    const dialog = draftDialog(container);

    // `open` is the one thing about the *element* this lane can measure, and it
    // is load-bearing rather than incidental: it is what takes the user agent's
    // `dialog:not([open]) { display: none }` off the content, so without it
    // every by-role query below finds nothing. In a browser the same line
    // reaches for `showModal` instead, and the top-layer half of that is
    // `e2e/map-regressions.spec.ts`'s to prove.
    expect(dialog?.hasAttribute('open')).toBe(true);
    // The form is inside the dialog, not merely somewhere on the page — which
    // is the whole of what "moved into a modal" means structurally.
    expect(dialog?.querySelector('form.add-site-form')).not.toBeNull();
  });

  it('leaves the reading behind it exactly as it was', async () => {
    const container = renderDashboard(new DemoFleetDataSource());
    await settle();

    clickMap();

    /*
     * The change a modal makes to the page under it: none. While the draft was
     * an occupant of the context region it displaced whatever was there, so the
     * fleet panel was hidden and a site panel unmounted for the duration. The
     * backdrop does that job now, and emptying the region behind it would buy
     * nothing a reader can see while costing them the context they had.
     */
    expect(fleetPanel(container)?.hasAttribute('hidden')).toBe(false);
    expect(within(fleetList()).getAllByRole('listitem')).toHaveLength(60);
  });

  it('cancels back to no draft without clearing the selection', async () => {
    const dataSource = new DemoFleetDataSource();
    const selected = await firstListedSite(dataSource);
    const container = renderDashboard(dataSource);
    await settle();

    fireEvent.click(screen.getByRole('button', { name: `Marker: ${selected.name}` }));
    clickMap();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    // "Where shall the new site go" and "which site am I reading" are still
    // different questions, and abandoning the first never answers the second.
    // The dialog leaves; the selection it opened over does not.
    expect(draftDialog(container)).toBeNull();
    expect(screen.getByRole('heading', { name: selected.name })).toBeDefined();
    expect(window.location.search).toBe(`?site=${selected.id}`);
  });

  it('closes on submit and selects the site the fleet returned, never a predicted one', async () => {
    const dataSource = new DemoFleetDataSource();
    const container = renderDashboard(dataSource);
    await settle();

    clickMap();
    submitDraft();
    await settle();

    expect(draftDialog(container)).toBeNull();

    const listed = await dataSource.listSites();

    if (listed.kind !== 'ok') {
      throw new Error('The demo fleet refused to list its own sites.');
    }

    const created = listed.value.at(-1);

    if (created === undefined) {
      throw new Error('The demo fleet is empty after a site was created.');
    }

    /*
     * The id the dashboard is now addressing is the one the *source* holds,
     * asked of the source rather than regenerated here — a dashboard that
     * predicted an id locally would be addressing a site that does not exist,
     * and a test that predicted it the same way would agree with the bug.
     */
    expect(created.name).toBe(CREATED_SITE_NAME);
    expect(window.location.search).toBe(`?site=${created.id}`);
    expect(screen.getByRole('heading', { name: CREATED_SITE_NAME })).toBeDefined();
    expect(within(fleetList()).getAllByRole('listitem')).toHaveLength(61);
  });
});
