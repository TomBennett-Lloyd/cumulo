// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppErrorBoundary } from './AppErrorBoundary';

/*
 * The half of the boundary React cannot deliver.
 *
 * `App.test.tsx` covers the throw: a component below the shell fails during
 * render and React hands it to the boundary. Nothing hands it a rejection —
 * that arrives on `window`, past the tree entirely — so the listener, its
 * removal, and what the visitor is left looking at are only provable here.
 *
 * These tests dispatch the event rather than rejecting a real promise. A real
 * rejection fires `unhandledrejection` on a microtask-queue turn no test can
 * await deterministically, and jsdom's own firing of it is not something to
 * take a dependency on; the listener's contract is "an `unhandledrejection`
 * event reached the window", and dispatching one states exactly that.
 */

/** The boundary's rejection log line — asserted, so it is named once. */
const REJECTION_LOG = 'Unhandled promise rejection reached the app boundary';

/**
 * Every `console.error` argument list the boundary produced, kept typed.
 *
 * The spy is the pattern the other boundary suites use — React logs each
 * caught error itself, so a deliberate failure would otherwise read as a broken
 * run — but the calls are captured into a declared `unknown[][]` rather than
 * read back off the mock, whose recorded arguments are `any`. `reason` is one
 * of the things under test, and `unknown` is what the boundary claims it is.
 */
const loggedErrors: unknown[][] = [];

const rejectionLogs = (): readonly unknown[][] =>
  loggedErrors.filter((args) => args[0] === REJECTION_LOG);

/**
 * A rejection event carrying a reason, built from the class a browser uses.
 *
 * jsdom 30 does define `PromiseRejectionEvent` (checked, rather than assumed),
 * so the reason-carrying path is testable against the real event shape instead
 * of a stand-in. The plain-`Event` case below covers the other end — an event
 * with no `reason` at all — which is what the handler's `in` narrowing is for.
 *
 * `Error` rather than `unknown` for the parameter: the boundary types the
 * reason it *reads* as `unknown` because a rejection may carry anything, but a
 * promise this file rejects on purpose is a promise this file should reject
 * properly (`prefer-promise-reject-errors`).
 */
const rejectionEvent = (reason: Error): PromiseRejectionEvent => {
  const promise = Promise.reject(reason);

  // The event holds a rejected promise nobody awaits. Left unhandled, node
  // reports it against this test file and fails the run for a reason that has
  // nothing to do with the boundary.
  promise.catch(() => undefined);

  return new PromiseRejectionEvent('unhandledrejection', { promise, reason });
};

/**
 * The boundary around something identifiable, so its disappearance is provable.
 *
 * The failure surface replacing the children is the behaviour — a boundary that
 * logged and rendered the tree on regardless would leave the visitor with the
 * same stuck screen the log is warning about.
 */
const renderBoundary = (): { readonly unmount: () => void } =>
  render(
    <AppErrorBoundary>
      <p>Panel content</p>
    </AppErrorBoundary>,
  );

const dispatchRejection = (event: Event): void => {
  act(() => {
    window.dispatchEvent(event);
  });
};

beforeEach(() => {
  loggedErrors.length = 0;
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    loggedErrors.push(args);
  });
});

// Vitest runs without global test hooks, so Testing Library's automatic cleanup
// never registers itself — and an uncleaned render leaves a mounted boundary
// listening on the shared window, which the removal test would then blame on a
// listener that was in fact removed.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AppErrorBoundary when a rejection reaches the window', () => {
  it('renders the failure surface in place of the children', () => {
    renderBoundary();

    dispatchRejection(new Event('unhandledrejection'));

    expect(screen.getByRole('alert').textContent).toContain(
      'The dashboard hit an unexpected error',
    );
    // The stuck-form case this exists for: a rejection nobody handled used to
    // leave whatever was on screen sitting there mid-operation.
    expect(screen.queryByText('Panel content')).toBe(null);
  });

  it('still credits Open-Meteo on the rejection failure', () => {
    // The CC BY 4.0 obligation does not lapse because a promise did, and the
    // failure surface is where the credit is easiest to lose.
    renderBoundary();

    dispatchRejection(new Event('unhandledrejection'));

    expect(screen.getByRole('link', { name: 'Open-Meteo.com' }).getAttribute('href')).toBe(
      'https://open-meteo.com/',
    );
  });

  it('logs the rejection rather than swallowing it', () => {
    renderBoundary();

    dispatchRejection(new Event('unhandledrejection'));

    // `error-handling.md` rule 2c: the boundary is where the failure stops, so
    // it has to stop visibly. Asserted apart from the surface above — the two
    // are separate obligations and a change that drops either should be able to
    // fail on its own.
    expect(rejectionLogs()).toHaveLength(1);
  });

  it('carries the rejection reason into the log', () => {
    const reason = new Error('The site never finished adding');

    renderBoundary();
    dispatchRejection(rejectionEvent(reason));

    // Structured context, not a bare line (`error-handling.md` rule 4): the
    // reason is the only thing that says *which* promise gave up.
    expect(rejectionLogs()[0]?.[1]).toEqual({ reason });
  });

  it('reports no reason when the event carries none, rather than throwing', () => {
    renderBoundary();

    dispatchRejection(new Event('unhandledrejection'));

    // The handler reads `reason` by presence rather than by event class, so an
    // event without one degrades to `undefined` instead of taking the boundary
    // itself down — which would be a crash inside the crash handler.
    expect(rejectionLogs()[0]?.[1]).toEqual({ reason: undefined });
  });
});

describe('AppErrorBoundary once it is gone', () => {
  it('stops listening for rejections after unmount', () => {
    const { unmount } = renderBoundary();

    unmount();
    dispatchRejection(rejectionEvent(new Error('Too late')));

    // A listener left on `window` outlives the tree it was going to update:
    // React warns about the setState, and every later mount adds another.
    expect(rejectionLogs()).toHaveLength(0);
  });
});

describe('AppErrorBoundary before anything has failed', () => {
  it('renders its children untouched', (): void => {
    // The negative control for every assertion above: they all read "the
    // children are gone", which is only meaningful if they were there first.
    renderBoundary();

    expect(screen.getByText('Panel content')).toBeDefined();
    expect(screen.queryByRole('alert')).toBe(null);
  });
});
