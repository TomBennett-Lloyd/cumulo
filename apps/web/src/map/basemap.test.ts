import { describe, expect, it } from 'vitest';
import { basemapStyleUrl } from './basemap';

describe('basemapStyleUrl', () => {
  it('serves the light theme OpenFreeMap positron style', () => {
    expect(basemapStyleUrl('light')).toBe('https://tiles.openfreemap.org/styles/positron');
  });

  it('serves the dark theme its own authored style', () => {
    expect(basemapStyleUrl('dark')).toBe('https://tiles.openfreemap.org/styles/dark');
  });

  it('gives the two themes different basemaps', () => {
    // The map treatment forbids producing the dark basemap by inverting or
    // filtering the light one, so the two themes must reach different styles —
    // one URL serving both would be the tell that the swap never happens.
    expect(basemapStyleUrl('dark')).not.toBe(basemapStyleUrl('light'));
  });
});
