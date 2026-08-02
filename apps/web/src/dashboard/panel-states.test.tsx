// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PanelEmpty, PanelError, PanelPending } from './panel-states';

afterEach(cleanup);

/*
 * These assert markup, not appearance, because the markup *is* the contract:
 * the panels in this column are read by screen readers as much as by eyes, and
 * the roles below are what the rest of the redesign builds against. A pending
 * state that quietly grew a `role="status"` would still look right and would
 * still announce nothing (#161) — so the absence is asserted, not assumed.
 */

describe('PanelPending', () => {
  it('shows the label it was given', () => {
    render(<PanelPending label="Summing the fleet’s forecasts…" />);

    expect(screen.getByText('Summing the fleet’s forecasts…')).toBeDefined();
  });

  it('marks its container busy', () => {
    render(<PanelPending label="Loading the fleet…" />);

    expect(screen.getByText('Loading the fleet…').getAttribute('aria-busy')).toBe('true');
  });

  // A live region mounted with its text already inside it announces nothing,
  // so the pending state deliberately claims no live semantics at all.
  it('mounts no live region', () => {
    render(<PanelPending label="Loading the fleet…" />);

    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByText('Loading the fleet…').getAttribute('role')).toBeNull();
  });
});

describe('PanelEmpty', () => {
  it('states the absence as ordinary content', () => {
    render(<PanelEmpty message="No fleet forecast available yet" />);

    const message = screen.getByText('No fleet forecast available yet');

    expect(message.getAttribute('role')).toBeNull();
    expect(message.getAttribute('aria-live')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('PanelError', () => {
  it('announces the failure as an alert', () => {
    render(<PanelError message="Could not load the fleet forecast: network unreachable" />);

    const alert = screen.getByRole('alert');

    expect(alert.textContent).toContain('Could not load the fleet forecast: network unreachable');
  });

  // Retrying is offered only where it can work: a panel that omits the callback
  // gets no button rather than a dead one.
  it('offers no retry when retrying is not a recourse', () => {
    render(<PanelError message="Could not load the forecast for Rathmines rooftop" />);

    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offers a retry that calls back when one is given', () => {
    const onRetry = vi.fn<() => void>();
    render(<PanelError message="Could not load the fleet forecast" onRetry={onRetry} />);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  // Inside a `role="alert"`, a button that submits an enclosing form would
  // reload the page instead of retrying (`type` defaults to "submit").
  it('gives the retry an explicit non-submitting type', () => {
    render(<PanelError message="Could not load the fleet forecast" onRetry={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Try again' }).getAttribute('type')).toBe('button');
  });
});
