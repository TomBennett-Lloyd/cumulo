// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HeaderMenu } from './HeaderMenu';

/*
 * The disclosure's own behaviour: what is revealed, and every way it is
 * dismissed.
 *
 * Dismissal is where a popover is usually wrong, so each route has a case —
 * the button itself, Escape, and a press outside — and each asserts where focus
 * ended up as well as what is on screen, because a popover that closes while
 * leaving focus on `body` has lost a keyboard reader.
 *
 * One route is deliberately absent: Escape *inside the About dialog*. That is
 * the browser closing a modal it owns, and jsdom has no modality to close (see
 * `AboutDialog.test.tsx`). `e2e/header.spec.ts` drives it in a real Chromium,
 * including the part this file could never see — that the dialog's Escape is
 * the dialog's alone and leaves the popover behind it standing.
 */

/** The menu with the theme wiring a caller supplies, defaulted to a no-op. */
const renderMenu = (onToggleTheme: () => void = () => undefined): void => {
  render(<HeaderMenu theme="light" onToggleTheme={onToggleTheme} />);
};

/** The disclosure button, by the name a reader finds it under. */
const menuButton = (): HTMLElement => screen.getByRole('button', { name: 'Menu' });

/** Open the menu the way a reader does, and hand back the button that did it. */
const openMenu = (): HTMLElement => {
  const button = menuButton();
  fireEvent.click(button);

  return button;
};

afterEach(cleanup);

describe('HeaderMenu at rest', () => {
  it('reveals nothing, and says so', () => {
    renderMenu();

    expect(menuButton().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: 'Dark theme' })).toBe(null);
    expect(screen.queryByRole('button', { name: 'About Cumulo' })).toBe(null);
  });
});

describe('HeaderMenu when opened', () => {
  it('reveals the shell controls it houses', () => {
    renderMenu();

    openMenu();

    expect(menuButton().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: 'Dark theme' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'About Cumulo' })).toBeDefined();
  });

  it('hands a theme press through to the caller unchanged', () => {
    const onToggleTheme = vi.fn();
    renderMenu(onToggleTheme);
    openMenu();

    fireEvent.click(screen.getByRole('button', { name: 'Dark theme' }));

    // The menu decides where the toggle sits, not what pressing it means.
    expect(onToggleTheme).toHaveBeenCalledTimes(1);
  });

  it('closes on a second press of the button that opened it', () => {
    renderMenu();
    openMenu();

    fireEvent.click(menuButton());

    expect(menuButton().getAttribute('aria-expanded')).toBe('false');
  });

  it('closes on Escape and gives focus back to the button', () => {
    renderMenu();
    const button = openMenu();
    const toggle = screen.getByRole('button', { name: 'Dark theme' });
    toggle.focus();

    fireEvent.keyDown(toggle, { key: 'Escape' });

    expect(menuButton().getAttribute('aria-expanded')).toBe('false');
    // The control the reader was on has just unmounted. Without this, focus
    // falls to `body` and a keyboard reader restarts from the top of the page.
    expect(document.activeElement).toBe(button);
  });

  it('closes on a press outside it', () => {
    renderMenu();
    openMenu();

    fireEvent.mouseDown(document.body);

    expect(menuButton().getAttribute('aria-expanded')).toBe('false');
  });

  it('stays open on a press inside it', () => {
    renderMenu();
    openMenu();

    fireEvent.mouseDown(screen.getByRole('button', { name: 'About Cumulo' }));

    // The outside-press listener is on the document, so "outside" has to be
    // decided rather than assumed — a version that closed here would dismiss
    // the popover on the way to every control in it.
    expect(menuButton().getAttribute('aria-expanded')).toBe('true');
  });
});

describe('HeaderMenu and the About dialog', () => {
  it('opens the dialog and leaves the popover standing behind it', () => {
    renderMenu();
    openMenu();

    fireEvent.click(screen.getByRole('button', { name: 'About Cumulo' }));

    expect(screen.getByRole('heading', { name: 'About Cumulo' })).toBeDefined();
    // Not tidiness: the browser restores focus to whatever opened a modal when
    // it closes, and closing the popover here would unmount that control.
    expect(menuButton().getAttribute('aria-expanded')).toBe('true');
  });

  it('does not treat a press inside the dialog as a press outside the menu', () => {
    renderMenu();
    openMenu();
    fireEvent.click(screen.getByRole('button', { name: 'About Cumulo' }));

    fireEvent.mouseDown(screen.getByRole('button', { name: 'Close' }));

    /*
     * The dialog is a React *sibling* of the element the outside-press listener
     * measures against, so every press inside it is literally "outside" that
     * element — which is why the listener stands down entirely while the dialog
     * is open rather than trying to decide the question. Without that, reaching
     * for the dialog's own Close button unmounts the popover behind it, and the
     * focus the browser then restores to the About button lands on nothing.
     */
    expect(menuButton().getAttribute('aria-expanded')).toBe('true');
  });

  it('closes the dialog when it asks to be dismissed', () => {
    renderMenu();
    openMenu();
    fireEvent.click(screen.getByRole('button', { name: 'About Cumulo' }));

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(screen.queryByRole('heading', { name: 'About Cumulo' })).toBe(null);
  });
});
