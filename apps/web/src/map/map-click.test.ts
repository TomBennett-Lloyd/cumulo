// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { isMarkerClick } from './map-click';

/*
 * The DOM maplibre actually builds: markers are appended into the canvas
 * container, so a marker's subtree and the basemap share one ancestor and one
 * click handler. These tests rebuild that shape rather than mock maplibre —
 * what is being checked is the rule for telling the two apart, which is the only
 * part of the interaction that has a decision in it.
 */
const canvasContainer = (): HTMLElement => {
  const container = document.createElement('div');
  container.className = 'maplibregl-canvas-container';

  const canvas = document.createElement('canvas');
  container.append(canvas);

  const marker = document.createElement('div');
  marker.className = 'maplibregl-marker';

  const button = document.createElement('button');
  const tooltip = document.createElement('span');
  button.append(tooltip);
  marker.append(button);
  container.append(marker);

  document.body.append(container);

  return container;
};

afterEach(() => {
  document.body.replaceChildren();
});

describe('isMarkerClick', () => {
  it('claims a click on the marker button, which is what a site marker is', () => {
    const container = canvasContainer();

    expect(isMarkerClick(container.querySelector('button'))).toBe(true);
  });

  it('claims a click on something nested inside the marker, like its tooltip', () => {
    const container = canvasContainer();

    expect(isMarkerClick(container.querySelector('span'))).toBe(true);
  });

  it('claims a click on the marker element itself', () => {
    const container = canvasContainer();

    expect(isMarkerClick(container.querySelector('.maplibregl-marker'))).toBe(true);
  });

  it('leaves a click on the basemap canvas to the map', () => {
    const container = canvasContainer();

    expect(isMarkerClick(container.querySelector('canvas'))).toBe(false);
  });

  it('leaves a click on the container the markers sit in to the map', () => {
    expect(isMarkerClick(canvasContainer())).toBe(false);
  });

  it('treats a target that is not an element as the map', () => {
    // A synthetic or retargeted event can carry a document, a text node or
    // nothing at all; none of them is a marker, and none should throw.
    expect(isMarkerClick(null)).toBe(false);
    expect(isMarkerClick(document)).toBe(false);
    expect(isMarkerClick(document.createTextNode('label'))).toBe(false);
  });
});
