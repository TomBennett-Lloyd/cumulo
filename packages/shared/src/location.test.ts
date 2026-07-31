import { describe, expect, it } from 'vitest';

import { locationId } from './location';

describe('locationId', () => {
  it('renders latitude then longitude, each to two decimal places', () => {
    expect(locationId({ latitude: 53.3498, longitude: -6.2603 })).toBe('53.35,-6.26');
  });

  it('pads whole-degree coordinates to the fixed two-decimal width', () => {
    expect(locationId({ latitude: 53, longitude: -6 })).toBe('53.00,-6.00');
  });

  it('does not treat swapped coordinates as the same location', () => {
    expect(locationId({ latitude: 1.5, longitude: 3.5 })).toBe('1.50,3.50');
    expect(locationId({ latitude: 3.5, longitude: 1.5 })).toBe('3.50,1.50');
  });

  it('collapses 180°E and 180°W — one meridian, one partition', () => {
    const east = locationId({ latitude: 12.34, longitude: 180 });

    expect(east).toBe('12.34,-180.00');
    expect(east).toBe(locationId({ latitude: 12.34, longitude: -180 }));
  });

  it('collapses coordinates that round up onto the antimeridian from either side', () => {
    const fromEast = locationId({ latitude: 12.34, longitude: 179.996 });
    const fromWest = locationId({ latitude: 12.34, longitude: -179.997 });

    expect(fromEast).toBe(fromWest);
    expect(fromEast).toBe('12.34,-180.00');
  });

  it('canonicalizes a longitude that rounds to negative zero', () => {
    expect(locationId({ latitude: 51.5, longitude: -0.001 })).toBe('51.50,0.00');
  });

  it('canonicalizes a latitude that rounds to negative zero', () => {
    expect(locationId({ latitude: -0.004, longitude: -0.002 })).toBe('0.00,0.00');
  });

  it('gives adjacent 0.01° buckets distinct ids', () => {
    expect(locationId({ latitude: 53.35, longitude: -6.26 })).not.toBe(
      locationId({ latitude: 53.36, longitude: -6.26 }),
    );
    expect(locationId({ latitude: 53.35, longitude: -6.26 })).not.toBe(
      locationId({ latitude: 53.35, longitude: -6.27 }),
    );
  });

  it('gives two points inside one bucket the same id — the de-duplication this key exists for', () => {
    expect(locationId({ latitude: 53.3512, longitude: -6.2634 })).toBe(
      locationId({ latitude: 53.3489, longitude: -6.2551 }),
    );
  });

  it('handles the poles without losing the fixed width', () => {
    expect(locationId({ latitude: 90, longitude: 0 })).toBe('90.00,0.00');
    expect(locationId({ latitude: -90, longitude: 0 })).toBe('-90.00,0.00');
  });
});
