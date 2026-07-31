// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';

// Vitest runs without global test hooks, so Testing Library's automatic cleanup
// never registers itself. The theme attribute is document-level state this app
// deliberately writes, so it has to be reset too — otherwise one test's dark
// mode is the next test's starting point.
afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
});

describe('App', () => {
  it('themes the document light before anyone touches the toggle', () => {
    render(<App />);

    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('flips the document theme each time the toggle is pressed', () => {
    render(<App />);
    const toggle = screen.getByRole('button', { name: 'Dark theme' });

    fireEvent.click(toggle);

    expect(document.documentElement.dataset.theme).toBe('dark');

    fireEvent.click(toggle);

    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('reports the current theme through the toggle it lives on', () => {
    render(<App />);
    const toggle = screen.getByRole('button', { name: 'Dark theme' });

    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-pressed')).toBe('true');
  });
});
