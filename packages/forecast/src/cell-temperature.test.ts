import { describe, expect, it } from 'vitest';

import { faimanCellTemperatureC } from './cell-temperature';

describe('faimanCellTemperatureC', () => {
  it('leaves the module at air temperature when no irradiance reaches it', () => {
    // Night, and every other zero-POA hour: there is no heat input, so the module sits
    // at ambient. Exact equality (not a tolerance) — the golden fixtures assert the same
    // thing for every polar-night and after-dark case.
    expect(faimanCellTemperatureC({ poaTotalWm2: 0, temperature2mC: -5, windSpeed10mMs: 3 })).toBe(
      -5,
    );
    expect(
      faimanCellTemperatureC({ poaTotalWm2: 0, temperature2mC: 21.5, windSpeed10mMs: 0 }),
    ).toBe(21.5);
  });

  it('raises the module poa/u0 above air temperature in still air', () => {
    // Faiman (2008) with no wind reduces to Tair + poa/u0. At 1000 W/m² and u0 = 25
    // W/m²K that is exactly 40 K of rise, so the arithmetic is checkable by hand rather
    // than by restating the implementation.
    expect(
      faimanCellTemperatureC({ poaTotalWm2: 1000, temperature2mC: 20, windSpeed10mMs: 0 }),
    ).toBe(60);
  });

  it('matches a hand-computed Faiman evaluation with wind', () => {
    // Tcell = 10 + 800 / (25 + 6.84 × 2) = 10 + 800 / 38.68 = 30.68252…
    expect(
      faimanCellTemperatureC({ poaTotalWm2: 800, temperature2mC: 10, windSpeed10mMs: 2 }),
    ).toBeCloseTo(30.68252, 5);
  });

  it('cools the module as wind speed rises, for fixed irradiance and air temperature', () => {
    const atWind = (windSpeed10mMs: number): number =>
      faimanCellTemperatureC({ poaTotalWm2: 900, temperature2mC: 18, windSpeed10mMs });

    const temperatures = [0, 1, 3, 6, 12, 25].map(atWind);

    for (const [index, temperature] of temperatures.entries()) {
      const previous = temperatures[index - 1];
      if (previous !== undefined) {
        expect(temperature).toBeLessThan(previous);
      }
    }
    // Even a gale never cools the module below ambient — the model only ever adds heat.
    expect(atWind(30)).toBeGreaterThan(18);
  });

  it('heats the module as irradiance rises, for fixed weather', () => {
    const atPoa = (poaTotalWm2: number): number =>
      faimanCellTemperatureC({ poaTotalWm2, temperature2mC: 12, windSpeed10mMs: 4 });

    expect(atPoa(0)).toBeLessThan(atPoa(200));
    expect(atPoa(200)).toBeLessThan(atPoa(600));
    expect(atPoa(600)).toBeLessThan(atPoa(1100));
  });

  it('uses the pvlib faiman coefficients when u0 and u1 are omitted', () => {
    // The pinned model (ADR 0003) is Faiman with u0 = 25.0, u1 = 6.84 — the values the
    // fixture generator passes explicitly. This is the production default path, so it is
    // asserted directly rather than only through calls that override the coefficients.
    const weather = { poaTotalWm2: 750, temperature2mC: 9, windSpeed10mMs: 5 };

    expect(faimanCellTemperatureC(weather)).toBe(
      faimanCellTemperatureC({ ...weather, u0: 25.0, u1: 6.84 }),
    );
  });

  it('honours overridden heat-loss coefficients', () => {
    // A larger u0 means the module sheds heat faster, so the same irradiance heats it
    // less: the coefficients are wired to the physics, not decorative.
    const weather = { poaTotalWm2: 1000, temperature2mC: 15, windSpeed10mMs: 0 };

    expect(faimanCellTemperatureC({ ...weather, u0: 50, u1: 6.84 })).toBe(35);
    expect(faimanCellTemperatureC({ ...weather, u0: 50, u1: 6.84 })).toBeLessThan(
      faimanCellTemperatureC(weather),
    );
  });

  it('is pure: the same input evaluated twice gives an identical result', () => {
    const input = { poaTotalWm2: 640, temperature2mC: 7.25, windSpeed10mMs: 2.5 };

    expect(faimanCellTemperatureC(input)).toBe(faimanCellTemperatureC(input));
  });
});
