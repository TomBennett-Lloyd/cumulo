import { describe, expect, it } from 'vitest';

import { faimanCellTemperatureC } from './cell-temperature';
import { acPowerKw, pvwattsDcPowerKw } from './power';

describe('pvwattsDcPowerKw', () => {
  it('produces exactly no power when no irradiance reaches the plane of array', () => {
    // Exact zero, not a small number: every night-time fixture case expects it, and a
    // signed or drifting zero would be a real defect in the chain.
    expect(pvwattsDcPowerKw({ poaTotalWm2: 0, cellTemperatureC: -5, capacityKw: 4 })).toBe(0);
    expect(pvwattsDcPowerKw({ poaTotalWm2: 0, cellTemperatureC: 31.5, capacityKw: 4 })).toBe(0);
  });

  it('returns nameplate capacity at standard test conditions', () => {
    // 1000 W/m² on the plane of array with cells at the 25 °C reference is the
    // definition of nameplate DC capacity, so the temperature factor is exactly 1.
    expect(pvwattsDcPowerKw({ poaTotalWm2: 1000, cellTemperatureC: 25, capacityKw: 4.2 })).toBe(
      4.2,
    );
  });

  it('scales linearly with irradiance at the reference cell temperature', () => {
    const atPoa = (poaTotalWm2: number): number =>
      pvwattsDcPowerKw({ poaTotalWm2, cellTemperatureC: 25, capacityKw: 4 });

    expect(atPoa(500)).toBeCloseTo(2, 10);
    expect(atPoa(250)).toBeCloseTo(1, 10);
    expect(atPoa(1200)).toBeCloseTo(4.8, 10);
  });

  it('loses power as the cells heat above the reference temperature', () => {
    // γ = −0.004/°C: 20 °C above the 25 °C reference costs 8 % of output.
    // (500/1000) × 4 kW × (1 − 0.004 × 20) = 2 × 0.92 = 1.84 kW.
    expect(pvwattsDcPowerKw({ poaTotalWm2: 500, cellTemperatureC: 45, capacityKw: 4 })).toBeCloseTo(
      1.84,
      10,
    );
  });

  it('gains power as the cells cool below the reference temperature', () => {
    const atCellTemperature = (cellTemperatureC: number): number =>
      pvwattsDcPowerKw({ poaTotalWm2: 900, cellTemperatureC, capacityKw: 4 });

    expect(atCellTemperature(-10)).toBeGreaterThan(atCellTemperature(10));
    expect(atCellTemperature(10)).toBeGreaterThan(atCellTemperature(25));
    expect(atCellTemperature(25)).toBeGreaterThan(atCellTemperature(40));
    expect(atCellTemperature(40)).toBeGreaterThan(atCellTemperature(70));
  });

  it('uses the PVWatts temperature coefficient when gamma is omitted', () => {
    // −0.004/°C (crystalline silicon) is the pinned model (ADR 0003) and the value the
    // fixture generator passes, so the default path is asserted directly.
    const operatingPoint = { poaTotalWm2: 820, cellTemperatureC: 38.5, capacityKw: 3.6 };

    expect(pvwattsDcPowerKw(operatingPoint)).toBe(
      pvwattsDcPowerKw({ ...operatingPoint, gammaPerC: -0.004 }),
    );
  });

  it('honours an overridden temperature coefficient', () => {
    // A thin-film module degrades less with heat; a zero coefficient not at all.
    const operatingPoint = { poaTotalWm2: 1000, cellTemperatureC: 55, capacityKw: 4 };

    expect(pvwattsDcPowerKw({ ...operatingPoint, gammaPerC: 0 })).toBe(4);
    expect(pvwattsDcPowerKw({ ...operatingPoint, gammaPerC: -0.002 })).toBeGreaterThan(
      pvwattsDcPowerKw(operatingPoint),
    );
  });
});

describe('acPowerKw', () => {
  it('applies inverter efficiency below the clipping knee', () => {
    // 2.5 kW DC through a 96 %-efficient inverter is 2.4 kW AC, well under the 4 kW
    // nameplate ceiling.
    expect(acPowerKw({ dcPowerKw: 2.5, capacityKw: 4 })).toBe(2.4);
    expect(acPowerKw({ dcPowerKw: 1.25, capacityKw: 4 })).toBe(1.2);
  });

  it('clips at nameplate capacity when the array outruns the inverter', () => {
    // 5 kW DC × 0.96 = 4.8 kW, above the 4 kW ceiling, so the hour reports exactly
    // nameplate — the behaviour the `edge-clipping` golden case pins.
    expect(acPowerKw({ dcPowerKw: 5, capacityKw: 4 })).toBe(4);
    expect(acPowerKw({ dcPowerKw: 100, capacityKw: 4 })).toBe(4);
  });

  it('produces exactly no power from no DC power', () => {
    expect(acPowerKw({ dcPowerKw: 0, capacityKw: 4 })).toBe(0);
  });

  it('uses the PVWatts nominal inverter efficiency when it is omitted', () => {
    // 0.96 is the pinned model (ADR 0003) and the value the fixture generator applies,
    // so the production default is asserted, not just the overridden path.
    const output = { dcPowerKw: 3.5, capacityKw: 6 };

    expect(acPowerKw(output)).toBe(acPowerKw({ ...output, inverterEfficiency: 0.96 }));
    expect(acPowerKw(output)).toBe(3.36);
  });

  it('honours an overridden inverter efficiency', () => {
    expect(acPowerKw({ dcPowerKw: 2, capacityKw: 4, inverterEfficiency: 1 })).toBe(2);
    expect(acPowerKw({ dcPowerKw: 2, capacityKw: 4, inverterEfficiency: 0.9 })).toBeLessThan(
      acPowerKw({ dcPowerKw: 2, capacityKw: 4 }),
    );
  });
});

describe('the cell-temperature to AC-power chain', () => {
  it('never reports more than nameplate or less than nothing across the weather envelope', () => {
    const capacityKw = 4;

    for (const poaTotalWm2 of [0, 50, 200, 500, 800, 1000, 1200, 1500]) {
      for (const temperature2mC of [-20, -5, 0, 12, 25, 35, 45]) {
        for (const windSpeed10mMs of [0, 1, 3, 8, 15, 30]) {
          const cellTemperatureC = faimanCellTemperatureC({
            poaTotalWm2,
            temperature2mC,
            windSpeed10mMs,
          });
          const dcPowerKw = pvwattsDcPowerKw({ poaTotalWm2, cellTemperatureC, capacityKw });
          const ac = acPowerKw({ dcPowerKw, capacityKw });

          const context = `poa ${String(poaTotalWm2)} W/m², air ${String(temperature2mC)} °C, wind ${String(windSpeed10mMs)} m/s`;
          expect(ac, context).toBeGreaterThanOrEqual(0);
          expect(ac, context).toBeLessThanOrEqual(capacityKw);
          expect(Number.isFinite(ac), context).toBe(true);
        }
      }
    }
  });

  it('reports exactly zero AC power through the whole chain on a dark hour', () => {
    const cellTemperatureC = faimanCellTemperatureC({
      poaTotalWm2: 0,
      temperature2mC: -5,
      windSpeed10mMs: 3,
    });
    const dcPowerKw = pvwattsDcPowerKw({ poaTotalWm2: 0, cellTemperatureC, capacityKw: 4 });

    expect(cellTemperatureC).toBe(-5);
    expect(dcPowerKw).toBe(0);
    expect(acPowerKw({ dcPowerKw, capacityKw: 4 })).toBe(0);
  });

  it('is pure: the same weather evaluated twice gives an identical result', () => {
    const weather = { poaTotalWm2: 725.5, temperature2mC: 11.25, windSpeed10mMs: 4.5 };
    const chain = (): number => {
      const cellTemperatureC = faimanCellTemperatureC(weather);
      return acPowerKw({
        dcPowerKw: pvwattsDcPowerKw({
          poaTotalWm2: weather.poaTotalWm2,
          cellTemperatureC,
          capacityKw: 4,
        }),
        capacityKw: 4,
      });
    };

    expect(chain()).toBe(chain());
  });
});
