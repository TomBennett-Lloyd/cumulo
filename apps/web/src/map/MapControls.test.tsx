// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MapControls } from './MapControls';

/*
 * The half of the control group that is not a camera.
 *
 * `MapControls` reads `MapContext`, and the value that context carries is a live
 * `MapLibreMap` — WebGL, which jsdom does not implement, and which
 * `testing.md` rule 3 forbids replacing with a mock whose calls this suite would
 * then assert on. So this file renders the controls with no map in context,
 * which is not a limitation dressed up as a test: it is the state the component
 * genuinely spends its first frame in, and the state the `disabled` reset button
 * below is about.
 *
 * What that leaves unproven here is what `easeTo` is asked for — that pressing
 * Reset actually returns the camera to the framing the map opened on. That is a
 * browser criterion in the strict sense (`testing.md` rule 10): it needs a real
 * camera, a real drag, and marker geometry read back off a laid-out page. It has
 * an owner rather than a gap — `e2e/map-regressions.spec.ts` drags the map,
 * presses this button, and polls a marker back to the pixel it started on.
 */

// Vitest runs without global test hooks, so Testing Library's automatic cleanup never registers
// itself — every render has to be torn down explicitly or later queries match two control groups.
afterEach(cleanup);

const addSiteToggle = (): HTMLElement => screen.getByRole('button', { name: 'Add a site' });

const resetControl = (): HTMLElement => screen.getByRole('button', { name: 'Reset map view' });

describe('MapControls add-site toggle', () => {
  it('reports the armed state it is given, in both directions', () => {
    const { rerender } = render(<MapControls armed={false} onToggleArmed={vi.fn()} />);

    expect(addSiteToggle().getAttribute('aria-pressed')).toBe('false');

    rerender(<MapControls armed onToggleArmed={vi.fn()} />);

    // Both directions, because a control stuck at `true` announces the mode it
    // is in exactly as convincingly as one that tracks it.
    expect(addSiteToggle().getAttribute('aria-pressed')).toBe('true');
  });

  it('asks its owner to toggle rather than deciding for itself', () => {
    const onToggleArmed = vi.fn();
    render(<MapControls armed={false} onToggleArmed={onToggleArmed} />);

    fireEvent.click(addSiteToggle());

    // Controlled: the press is a request, and `armed` above stays false because
    // nothing here is allowed to move it. The dashboard owns the flag, since it
    // is the dashboard's map-click handler that reads it.
    expect(onToggleArmed).toHaveBeenCalledTimes(1);
    expect(addSiteToggle().getAttribute('aria-pressed')).toBe('false');
  });
});

describe('MapControls reset', () => {
  it('offers no camera reset until there is a camera', () => {
    render(<MapControls armed={false} onToggleArmed={vi.fn()} />);

    // `MapContext` is null for the frame between `MapView` mounting and its map
    // instance existing. A live-looking button that silently did nothing in that
    // window is the thing being refused here.
    expect(resetControl().hasAttribute('disabled')).toBe(true);
  });

  it('keeps the add-site toggle live while the map is still arriving', () => {
    render(<MapControls armed={false} onToggleArmed={vi.fn()} />);

    // The asymmetry is deliberate and is what this pins: arming is dashboard
    // state, so it does not wait on a map, and disabling both would make the
    // group flicker on arrival for a reason the reader cannot see.
    expect(addSiteToggle().hasAttribute('disabled')).toBe(false);
  });
});
