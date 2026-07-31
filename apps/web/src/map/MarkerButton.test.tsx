// @vitest-environment jsdom

import type { Site } from '@cumulo/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarkerButton } from './MarkerButton';

afterEach(cleanup);

const RATHMINES_ID = '2a2b2f3c-0000-4000-8000-000000000001';

const site: Site = {
  id: RATHMINES_ID,
  name: 'Rathmines rooftop',
  latitude: 53.3244,
  longitude: -6.2657,
  tiltDegrees: 35,
  azimuthDegrees: 180,
  capacityKw: 4.25,
};

/**
 * Activate an element the way a keyboard user does.
 *
 * jsdom dispatches key events but never performs the *activation behaviour*
 * the HTML spec attaches to Enter and Space on a focused button, so a `keyDown`
 * alone could never reach `onClick` however the component were built. This does
 * both halves — and does the second only when the target really is a `<button>`
 * whose keydown was not cancelled, so a marker rebuilt as a clickable `<div>`
 * (genuinely dead to the keyboard) fails here instead of passing on a
 * synthesized click.
 */
const pressKey = (element: HTMLElement, key: string): void => {
  const notCancelled = fireEvent.keyDown(element, { key });

  if (notCancelled && element instanceof HTMLButtonElement) {
    fireEvent.click(element);
  }
};

describe('MarkerButton', () => {
  it('renders a focusable button named after the site', () => {
    render(<MarkerButton site={site} selected={false} onSelect={vi.fn()} />);

    const marker = screen.getByRole('button', { name: 'Rathmines rooftop' });

    marker.focus();

    expect(document.activeElement).toBe(marker);
  });

  it.each(['Enter', ' '])('reports the site id when activated with %s', (key) => {
    const onSelect = vi.fn();

    render(<MarkerButton site={site} selected={false} onSelect={onSelect} />);
    pressKey(screen.getByRole('button'), key);

    expect(onSelect).toHaveBeenCalledWith(RATHMINES_ID);
  });

  it('reports the site id when clicked', () => {
    const onSelect = vi.fn();

    render(<MarkerButton site={site} selected={false} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button'));

    expect(onSelect).toHaveBeenCalledWith(RATHMINES_ID);
  });

  it('carries a tooltip naming the site, so hover never rests on colour alone', () => {
    const { container } = render(<MarkerButton site={site} selected={false} onSelect={vi.fn()} />);

    expect(container.querySelector('.map-site-marker-tooltip')?.textContent).toBe(
      'Rathmines rooftop',
    );
  });

  it('marks a selected marker as selected and current, not by colour alone', () => {
    render(<MarkerButton site={site} selected onSelect={vi.fn()} />);

    const marker = screen.getByRole('button', { name: 'Rathmines rooftop' });

    expect(marker.className).toContain('map-site-marker-selected');
    expect(marker).toHaveProperty('ariaCurrent', 'true');
  });

  it('leaves an unselected marker unmarked', () => {
    render(<MarkerButton site={site} selected={false} onSelect={vi.fn()} />);

    const marker = screen.getByRole('button', { name: 'Rathmines rooftop' });

    expect(marker.className).not.toContain('map-site-marker-selected');
    expect(marker.getAttribute('aria-current')).toBeNull();
  });
});
