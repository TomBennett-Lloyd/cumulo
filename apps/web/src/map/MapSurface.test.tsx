// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { MapSurface } from './MapSurface';

/*
 * The shell every map state now shares, asserted once for all three of them.
 *
 * This file exists because the three states used to be three copies: the tests
 * for each could only say that *that* copy was written correctly, and the
 * property that actually matters — every state occupies the same box and every
 * state carries the credit — was nobody's assertion. Here it is one, run three
 * times over the union.
 *
 * Nothing below reaches maplibre. `MapSurface` takes the canvas as a slot rather
 * than owning a map, which is what makes the shipping shell renderable in jsdom
 * at all (`react.md` rule 4); `MapView` supplies the ref that a real maplibre
 * instance mounts into, and that adapter stays untestable here by design.
 */

// Vitest runs without global test hooks, so Testing Library's automatic cleanup
// never registers itself — unmount explicitly or renders accumulate and the
// attribution queries below match more than one credit.
afterEach(() => {
  cleanup();
});

const openMeteoLinkHref = (): string | null =>
  screen.getByRole('link', { name: 'Open-Meteo.com' }).getAttribute('href');

describe('MapSurface with a live map canvas', () => {
  it('hands the canvas element to the caller that owns the map instance', () => {
    // The ref is the entire point of this slot: maplibre mounts into the element
    // it receives, so a shell that rendered the box without wiring the ref would
    // look right and never draw a tile.
    const containerRef = createRef<HTMLDivElement>();

    const { container } = render(<MapSurface canvas={{ kind: 'map', containerRef }} />);

    expect(container.firstElementChild?.className).toBe('map-view');
    expect(containerRef.current?.classList.contains('map-canvas')).toBe(true);
    expect(containerRef.current?.parentElement?.className).toBe('map-view');
  });

  it('credits Open-Meteo beneath the map', () => {
    render(<MapSurface canvas={{ kind: 'map', containerRef: createRef<HTMLDivElement>() }} />);

    expect(openMeteoLinkHref()).toBe('https://open-meteo.com/');
  });

  it('draws overlays between the canvas and the credits', () => {
    // Markers and clusters arrive as children; they belong over the canvas and
    // above the strip, which is the stacking the map's column depends on.
    render(
      <MapSurface canvas={{ kind: 'map', containerRef: createRef<HTMLDivElement>() }}>
        <p>Site markers</p>
      </MapSurface>,
    );

    const overlay = screen.getByText('Site markers');

    expect(overlay.previousElementSibling?.className).toBe('map-canvas');
    expect(overlay.nextElementSibling?.className).toBe('map-attribution');
  });
});

describe('MapSurface while the map is on its way', () => {
  it('occupies the same box the real canvas does, so the swap shifts nothing', () => {
    const { container } = render(
      <MapSurface canvas={{ kind: 'placeholder', label: 'Loading map…' }} />,
    );
    const placeholder = screen.getByText('Loading map…');

    expect(container.firstElementChild?.className).toBe('map-view');
    expect(placeholder.classList.contains('map-canvas')).toBe(true);
    expect(placeholder.classList.contains('map-placeholder')).toBe(true);
  });

  it('marks the wait as busy content rather than mounting a live region', () => {
    // `react.md`'s async surface convention: a live region mounted with its text
    // already inside it has no change to report, announces nothing, and merely
    // looks accessible (#161). The second and third assertions are the negative
    // control — the first passes unchanged with a `role="status"` wrapped back
    // around the label, which is exactly the regression worth catching.
    render(<MapSurface canvas={{ kind: 'placeholder', label: 'Loading map…' }} />);

    expect(screen.getByText('Loading map…').getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByRole('status')).toBe(null);
    expect(screen.queryByRole('alert')).toBe(null);
  });

  it('credits Open-Meteo while there is no map yet', () => {
    // The CC BY obligation is not suspended by a slow network.
    render(<MapSurface canvas={{ kind: 'placeholder', label: 'Loading map…' }} />);

    expect(openMeteoLinkHref()).toBe('https://open-meteo.com/');
  });

  it('still renders whatever overlays the caller passes', () => {
    render(
      <MapSurface canvas={{ kind: 'placeholder', label: 'Loading map…' }}>
        <p>Overlay</p>
      </MapSurface>,
    );

    expect(screen.getByText('Overlay')).toBeDefined();
  });
});

describe('MapSurface when the map has failed', () => {
  it('occupies the same box, so a failure does not reflow the page either', () => {
    const { container } = render(
      <MapSurface canvas={{ kind: 'failure', message: 'The map could not be loaded.' }} />,
    );
    const failure = screen.getByRole('alert');

    expect(container.firstElementChild?.className).toBe('map-view');
    expect(failure.classList.contains('map-canvas')).toBe(true);
    expect(failure.classList.contains('map-failure')).toBe(true);
    expect(failure.textContent).toBe('The map could not be loaded.');
  });

  it('announces the failure, because this one really is a change', () => {
    // Unlike the pending state, this mounts into a tree the reader is already
    // looking at — the placeholder was there a moment ago — so the alert has a
    // change to report and assistive technology reports it.
    render(<MapSurface canvas={{ kind: 'failure', message: 'The map could not be loaded.' }} />);

    expect(screen.getByRole('alert')).toBeDefined();
    expect(screen.queryByRole('status')).toBe(null);
  });

  it('credits Open-Meteo when the map is never going to arrive', () => {
    // The state the credit is easiest to lose, and the licence does not lapse
    // because the chunk did.
    render(<MapSurface canvas={{ kind: 'failure', message: 'The map could not be loaded.' }} />);

    expect(openMeteoLinkHref()).toBe('https://open-meteo.com/');
  });

  it('still renders whatever overlays the caller passes', () => {
    render(
      <MapSurface canvas={{ kind: 'failure', message: 'The map could not be loaded.' }}>
        <p>Overlay</p>
      </MapSurface>,
    );

    expect(screen.getByText('Overlay')).toBeDefined();
  });
});
