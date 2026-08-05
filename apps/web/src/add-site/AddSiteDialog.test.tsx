// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AddSiteDialog, type AddSiteDialogProps } from './AddSiteDialog';

/*
 * The wrapper's own surface, rendered on its own (`react.md` rule 4).
 *
 * The same line `header/AboutDialog.test.tsx` draws applies here and for the
 * same reason: jsdom 30 implements `HTMLDialogElement` with `open` and nothing
 * else, so modality itself — the top layer, the backdrop, the page going inert,
 * Escape raising `cancel` — has no implementation to assert against and belongs
 * to the browser lane (`testing.md` rule 10). `e2e/map-regressions.spec.ts`
 * drives Escape and the focus landing through a real Chromium.
 *
 * What this file is for is the part that is *not* the form and not the
 * dashboard: that the element opens itself, that the form is inside it, and
 * that leaving the document is what spends the return-focus callback. That last
 * one is the reason this suite exists at all rather than living entirely in
 * `dashboard/Dashboard.draft-dialog.test.tsx` — unmounting the component
 * directly is how the cleanup can be observed as the cleanup, rather than
 * inferred from where focus happened to land in a bigger tree.
 */

const dialogProps = (overrides: Partial<AddSiteDialogProps> = {}): AddSiteDialogProps => ({
  latitude: 53.5,
  longitude: -5.5,
  submitting: false,
  refusal: null,
  error: null,
  onSubmit: vi.fn(),
  onCancel: vi.fn(),
  onReturnFocus: vi.fn(),
  ...overrides,
});

afterEach(cleanup);

describe('AddSiteDialog', () => {
  it('opens the element itself and puts the form inside it', () => {
    const { container } = render(<AddSiteDialog {...dialogProps()} />);
    const dialog = container.querySelector('dialog.add-site-dialog');

    // `open` is what takes the user agent's `dialog:not([open]) { display: none }`
    // off the content, so a dialog that never opened would render a form nothing
    // can see. In a browser this same line reaches for `showModal` instead.
    expect(dialog?.hasAttribute('open')).toBe(true);
    // Inside, not merely on the page beside it — which is the whole of what
    // "the draft moved into a modal" means structurally.
    expect(dialog?.querySelector('form.add-site-form')).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Add a site' })).toBeDefined();
  });

  it('passes the draft’s coordinates through to the form untouched', () => {
    render(<AddSiteDialog {...dialogProps({ latitude: 51.25, longitude: -0.5 })} />);

    // The wrapper is a wrapper: the map owns these numbers and neither this
    // component nor the form is allowed to reinterpret them on the way past.
    expect(screen.getByText('51.2500, -0.5000')).toBeDefined();
  });

  it('spends the return-focus callback when it leaves the document, and not before', () => {
    const onReturnFocus = vi.fn();
    const { unmount } = render(<AddSiteDialog {...dialogProps({ onReturnFocus })} />);

    // Not on mount, and not on a re-render: an open dialog that had already
    // handed focus back would be a dialog the reader cannot type into.
    expect(onReturnFocus).not.toHaveBeenCalled();

    unmount();

    /*
     * The cleanup is where this lives rather than the `cancel` handler, and the
     * placement is load-bearing: in a browser the user agent's own focus
     * restoration is still running while `cancel` is dispatched and would
     * overwrite a focus set there. jsdom cannot show that — it has no close
     * steps to race — so what this pins is only that unmounting is what fires
     * it. The race itself is the browser lane's, in
     * `e2e/map-regressions.spec.ts`.
     */
    expect(onReturnFocus).toHaveBeenCalledTimes(1);
  });

  it('hands the form’s Cancel straight to its owner', () => {
    const onCancel = vi.fn();
    render(<AddSiteDialog {...dialogProps({ onCancel })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    // The dialog does not close itself: the dashboard owns whether a draft
    // exists, and unmounting this component is the whole of closing it.
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
