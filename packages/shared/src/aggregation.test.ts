import { describe, expect, it } from 'vitest';

import { aggregateFleetActuals, aggregateFleetForecast, fleetCapacityKw } from './aggregation';
import type { FleetActualsPoint, FleetForecastPoint } from './aggregation';
import { forecastSchema } from './forecast';
import type { Forecast } from './forecast';
import { generationReadingSchema } from './generation-reading';
import type { GenerationReading } from './generation-reading';
import * as packageSurface from './index';
import { siteSchema } from './site';
import type { Site } from './site';
import { uncertaintyBandSchema } from './index';
import type { UncertaintyBand } from './index';

const siteA = '11111111-1111-4111-8111-111111111111';
const siteB = '22222222-2222-4222-8222-222222222222';
const siteC = '33333333-3333-4333-8333-333333333333';

const noon = '2026-07-30T12:00:00Z';
const onePm = '2026-07-30T13:00:00Z';
const twoPm = '2026-07-30T14:00:00Z';
const defaultIssuedAt = '2026-07-30T06:00:00Z';

interface ForecastSpec {
  readonly siteId: string;
  readonly validTime: string;
  readonly acPowerKw: number;
  readonly issuedAt?: string;
  readonly band?: UncertaintyBand;
}

/**
 * Fixtures go through `forecastSchema.parse`, which is both the only cast-free way to obtain the
 * branded timestamps and a standing check that the fixtures are forecasts a real producer could
 * emit. Fields aggregation ignores are fixed rather than parameterized.
 */
const buildForecast = (spec: ForecastSpec): Forecast =>
  forecastSchema.parse({
    siteId: spec.siteId,
    model: 'physics',
    validTime: spec.validTime,
    issuedAt: spec.issuedAt ?? defaultIssuedAt,
    weatherSource: 'open-meteo',
    poaIrradianceWm2: 0,
    acPowerKw: spec.acPowerKw,
    ...(spec.band === undefined ? {} : { uncertainty: spec.band }),
  });

interface ReadingSpec {
  readonly siteId: string;
  readonly validTime: string;
  readonly acPowerKw: number;
}

const buildReading = (spec: ReadingSpec): GenerationReading => generationReadingSchema.parse(spec);

/**
 * Capacity is the only field the sum reads, so it is the only one that varies. Parsed rather than
 * hand-built so a fixture can never carry a capacity `siteSchema` would refuse.
 */
const buildSite = (siteId: string, capacityKw: number): Site =>
  siteSchema.parse({
    id: siteId,
    name: `Site ${siteId.slice(0, 4)}`,
    latitude: 53.35,
    longitude: -6.26,
    tiltDegrees: 35,
    azimuthDegrees: 180,
    capacityKw,
  });

const validTimesOf = (
  points: readonly (FleetForecastPoint | FleetActualsPoint)[],
): readonly string[] => points.map((point) => point.validTime);

describe('aggregateFleetForecast', () => {
  it('returns no points for an empty fleet', () => {
    expect(aggregateFleetForecast([])).toEqual([]);
  });

  it('passes a single site-hour through with its own band and a count of one', () => {
    const points: readonly FleetForecastPoint[] = aggregateFleetForecast([
      buildForecast({
        siteId: siteA,
        validTime: noon,
        acPowerKw: 3.5,
        band: { p10AcPowerKw: 2.5, p90AcPowerKw: 4.5 },
      }),
    ]);

    expect(points).toEqual([
      {
        validTime: noon,
        acPowerKw: 3.5,
        uncertainty: { p10AcPowerKw: 2.5, p90AcPowerKw: 4.5 },
        contributingSiteCount: 1,
      },
    ]);
  });

  it('sums median, p10 and p90 across two sites in the same hour', () => {
    const points = aggregateFleetForecast([
      buildForecast({
        siteId: siteA,
        validTime: noon,
        acPowerKw: 3.5,
        band: { p10AcPowerKw: 2.5, p90AcPowerKw: 4.5 },
      }),
      buildForecast({
        siteId: siteB,
        validTime: noon,
        acPowerKw: 2.25,
        band: { p10AcPowerKw: 1.25, p90AcPowerKw: 3.25 },
      }),
    ]);

    expect(points).toEqual([
      {
        validTime: noon,
        acPowerKw: 5.75,
        uncertainty: { p10AcPowerKw: 3.75, p90AcPowerKw: 7.75 },
        contributingSiteCount: 2,
      },
    ]);
  });

  it('treats a point estimate as a degenerate band so a mixed hour still reports uncertainty', () => {
    const points = aggregateFleetForecast([
      buildForecast({
        siteId: siteA,
        validTime: noon,
        acPowerKw: 2,
        band: { p10AcPowerKw: 1, p90AcPowerKw: 3 },
      }),
      buildForecast({ siteId: siteB, validTime: noon, acPowerKw: 4 }),
    ]);

    expect(points).toEqual([
      {
        validTime: noon,
        acPowerKw: 6,
        uncertainty: { p10AcPowerKw: 5, p90AcPowerKw: 7 },
        contributingSiteCount: 2,
      },
    ]);
  });

  it('omits the uncertainty key entirely when no site in the hour has a band', () => {
    const points = aggregateFleetForecast([
      buildForecast({ siteId: siteA, validTime: noon, acPowerKw: 2 }),
      buildForecast({ siteId: siteB, validTime: noon, acPowerKw: 4 }),
    ]);
    expect(points.map((point) => 'uncertainty' in point)).toEqual([false]);
    expect(points).toEqual([{ validTime: noon, acPowerKw: 6, contributingSiteCount: 2 }]);
  });

  it('keeps the latest issuedAt when one site appears twice in an hour', () => {
    const points = aggregateFleetForecast([
      buildForecast({
        siteId: siteA,
        validTime: noon,
        acPowerKw: 9,
        issuedAt: '2026-07-30T00:00:00Z',
      }),
      buildForecast({
        siteId: siteA,
        validTime: noon,
        acPowerKw: 2,
        issuedAt: '2026-07-30T06:00:00Z',
      }),
    ]);

    expect(points).toEqual([{ validTime: noon, acPowerKw: 2, contributingSiteCount: 1 }]);
  });

  it('ignores a superseded forecast even when it arrives last', () => {
    const points = aggregateFleetForecast([
      buildForecast({
        siteId: siteA,
        validTime: noon,
        acPowerKw: 2,
        issuedAt: '2026-07-30T06:00:00Z',
      }),
      buildForecast({
        siteId: siteA,
        validTime: noon,
        acPowerKw: 9,
        issuedAt: '2026-07-30T00:00:00Z',
      }),
    ]);

    expect(points).toEqual([{ validTime: noon, acPowerKw: 2, contributingSiteCount: 1 }]);
  });

  it('breaks an issuedAt tie in favour of the last forecast in input order', () => {
    const points = aggregateFleetForecast([
      buildForecast({ siteId: siteA, validTime: noon, acPowerKw: 9 }),
      buildForecast({ siteId: siteA, validTime: noon, acPowerKw: 2 }),
    ]);

    expect(points).toEqual([{ validTime: noon, acPowerKw: 2, contributingSiteCount: 1 }]);
  });

  it('returns points sorted ascending by validTime whatever order the input arrives in', () => {
    const points = aggregateFleetForecast([
      buildForecast({ siteId: siteA, validTime: twoPm, acPowerKw: 1 }),
      buildForecast({ siteId: siteB, validTime: noon, acPowerKw: 1 }),
      buildForecast({ siteId: siteA, validTime: onePm, acPowerKw: 1 }),
      buildForecast({ siteId: siteA, validTime: noon, acPowerKw: 1 }),
    ]);

    expect(validTimesOf(points)).toEqual([noon, onePm, twoPm]);
  });

  it('never reports a fleet p10 above the fleet p90', () => {
    const points = aggregateFleetForecast([
      buildForecast({
        siteId: siteA,
        validTime: noon,
        acPowerKw: 3.5,
        band: { p10AcPowerKw: 0, p90AcPowerKw: 7 },
      }),
      buildForecast({ siteId: siteB, validTime: noon, acPowerKw: 4.25 }),
      buildForecast({
        siteId: siteC,
        validTime: onePm,
        acPowerKw: 1.5,
        band: { p10AcPowerKw: 1.5, p90AcPowerKw: 1.5 },
      }),
      buildForecast({
        siteId: siteA,
        validTime: onePm,
        acPowerKw: 6,
        band: { p10AcPowerKw: 5.5, p90AcPowerKw: 9.75 },
      }),
    ]);
    const bandedPoints = points.flatMap((point) =>
      point.uncertainty === undefined ? [] : [{ median: point.acPowerKw, band: point.uncertainty }],
    );

    expect(bandedPoints).toHaveLength(2);
    for (const { median, band } of bandedPoints) {
      expect(band.p10AcPowerKw).toBeLessThanOrEqual(band.p90AcPowerKw);
      expect(median).toBeGreaterThanOrEqual(band.p10AcPowerKw);
      expect(median).toBeLessThanOrEqual(band.p90AcPowerKw);
    }
  });
});

describe('aggregateFleetActuals', () => {
  it('returns no points for an empty fleet', () => {
    expect(aggregateFleetActuals([])).toEqual([]);
  });

  it('sums measured output across the sites reporting in an hour', () => {
    const points: readonly FleetActualsPoint[] = aggregateFleetActuals([
      buildReading({ siteId: siteA, validTime: noon, acPowerKw: 3.5 }),
      buildReading({ siteId: siteB, validTime: noon, acPowerKw: 2.25 }),
    ]);

    expect(points).toEqual([{ validTime: noon, acPowerKw: 5.75, contributingSiteCount: 2 }]);
  });

  it('counts only distinct sites, keeping the last reading for a repeated site', () => {
    const points = aggregateFleetActuals([
      buildReading({ siteId: siteA, validTime: noon, acPowerKw: 9 }),
      buildReading({ siteId: siteA, validTime: noon, acPowerKw: 2 }),
      buildReading({ siteId: siteB, validTime: noon, acPowerKw: 1 }),
    ]);

    expect(points).toEqual([{ validTime: noon, acPowerKw: 3, contributingSiteCount: 2 }]);
  });

  it('returns points sorted ascending by validTime whatever order the input arrives in', () => {
    const points = aggregateFleetActuals([
      buildReading({ siteId: siteA, validTime: twoPm, acPowerKw: 1 }),
      buildReading({ siteId: siteA, validTime: noon, acPowerKw: 1 }),
      buildReading({ siteId: siteB, validTime: onePm, acPowerKw: 1 }),
    ]);

    expect(validTimesOf(points)).toEqual([noon, onePm, twoPm]);
  });
});

describe('fleetCapacityKw', () => {
  it('reports zero for an empty fleet rather than leaving the caller to invent a number', () => {
    expect(fleetCapacityKw([])).toBe(0);
  });

  it('reports a single site as its own capacity', () => {
    expect(fleetCapacityKw([buildSite(siteA, 4.5)])).toBe(4.5);
  });

  it('sums every site in a many-site fleet', () => {
    expect(
      fleetCapacityKw([buildSite(siteA, 4), buildSite(siteB, 6), buildSite(siteC, 10)]),
    ).toBeCloseTo(20, 10);
  });

  it('sums fractional kW without dropping the fraction', () => {
    expect(
      fleetCapacityKw([buildSite(siteA, 3.3), buildSite(siteB, 2.7), buildSite(siteC, 0.1)]),
    ).toBeCloseTo(6.1, 10);
  });
});

describe('@cumulo/shared surface', () => {
  it('exports the fleet capacity sum', () => {
    expect(packageSurface.fleetCapacityKw).toBe(fleetCapacityKw);
  });

  it('exports the uncertainty band schema, its type, and both aggregation functions', () => {
    const band: UncertaintyBand = uncertaintyBandSchema.parse({
      p10AcPowerKw: 1,
      p90AcPowerKw: 2,
    });

    expect(band).toEqual({ p10AcPowerKw: 1, p90AcPowerKw: 2 });
    expect(uncertaintyBandSchema.safeParse({ p10AcPowerKw: 3, p90AcPowerKw: 2 }).success).toBe(
      false,
    );
    expect(packageSurface.aggregateFleetForecast).toBe(aggregateFleetForecast);
    expect(packageSurface.aggregateFleetActuals).toBe(aggregateFleetActuals);
  });
});
