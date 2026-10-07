// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { focusPressedControl } from './marker-press-focus';

interface PressedMarker {
  /** A non-focusable span inside the control — where a press actually lands. */
  readonly label: HTMLElement;
  /** Loose text beside the control, with no focusable ancestor inside the marker. */
  readonly prose: HTMLElement;
}

/**
 * A marker shell around `control`, wired as `MapMarkerAnchor.tsx` wires it: the
 * host's cancelling listener first when `hostCancels`, then the one under test.
 */
const markerWith = (control: HTMLElement, hostCancels: boolean): PressedMarker => {
  const marker = document.createElement('div');
  const label = document.createElement('span');
  const prose = document.createElement('p');

  control.append(label);
  marker.append(control, prose);
  document.body.append(marker);

  if (hostCancels) {
    marker.addEventListener('mousedown', (event) => {
      event.preventDefault();
    });
  }

  marker.addEventListener('mousedown', focusPressedControl);

  return { label, prose };
};

const press = (target: Element): void => {
  target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
};

afterEach(() => {
  document.body.replaceChildren();
});

describe('focusPressedControl', () => {
  it('focuses the closest focusable ancestor when the default was prevented', () => {
    const button = document.createElement('button');

    press(markerWith(button, true).label);

    expect(document.activeElement).toBe(button);
  });

  it('does nothing when the default was not prevented', () => {
    press(markerWith(document.createElement('button'), false).label);

    expect(document.activeElement).toBe(document.body);
  });

  it('does nothing when no focusable ancestor exists', () => {
    press(markerWith(document.createElement('button'), true).prose);

    expect(document.activeElement).toBe(document.body);
  });

  it('leaves the focus where it was when the pressed control is disabled', () => {
    const elsewhere = document.createElement('input');
    const button = document.createElement('button');

    document.body.append(elsewhere);
    elsewhere.focus();
    button.disabled = true;

    press(markerWith(button, true).label);

    expect(document.activeElement).toBe(elsewhere);
  });
});
