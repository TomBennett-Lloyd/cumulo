import { utcIsoTimestampSchema, type Forecast, type GenerationReading } from '@cumulo/shared';
import { describe, expect, it } from 'vitest';

import { joinSiteSeries } from './site-series';

const SITE_ID = '1f8f1f4e-8f4a-4a2f-9a7a-2f7c1f4e8f4a';

const at = (hour: number) =>
  utcIsoTimestampSchema.parse(`2026-07-30T${hour.toString().padStart(2, '0')}:00:00Z`);

const pointEstimate = (hour: number, medianKw: number): Forecast => ({
  siteId: SITE_ID,
  model: 'physics',
  validTime: at(hour),
  issuedAt: at(0),
  weatherSource: 'open-meteo',
  poaIrradianceWm2: medianKw * 100,
  acPowerKw: medianKw,
});

const banded = (hour: number, medianKw: number): Forecast => ({
  ...pointEstimate(hour, medianKw),
  uncertainty: { p10AcPowerKw: medianKw - 0.5, p90AcPowerKw: medianKw + 0.5 },
});

const reading = (hour: number, acPowerKw: number): GenerationReading => ({
  siteId: SITE_ID,
  validTime: at(hour),
  acPowerKw,
});

describe('joinSiteSeries', () => {
  it('joins each forecast to the measurement recorded for the same instant', () => {
    const points = joinSiteSeries([banded(9, 4)], [reading(9, 3.8)]);

    expect(points).toEqual([
      {
        validTimeIso: '2026-07-30T09:00:00Z',
        medianKw: 4,
        band: { p10Kw: 3.5, p90Kw: 4.5 },
        actualKw: 3.8,
      },
    ]);
  });

  it('leaves an unmeasured hour null rather than carrying the previous value forward', () => {
    const points = joinSiteSeries([banded(9, 4), banded(12, 6)], [reading(9, 3.8)]);

    expect(points.map((point) => point.actualKw)).toEqual([3.8, null]);
  });

  it('omits the band key entirely for a point-estimate forecast', () => {
    const points = joinSiteSeries([pointEstimate(9, 4)], []);

    expect(points[0]).not.toHaveProperty('band');
  });

  it('drops a measurement whose hour was never forecast, and sorts by time', () => {
    const points = joinSiteSeries(
      [banded(12, 6), banded(9, 4)],
      [reading(3, 0.1), reading(12, 5.9)],
    );

    expect(points.map((point) => point.validTimeIso)).toEqual([
      '2026-07-30T09:00:00Z',
      '2026-07-30T12:00:00Z',
    ]);
    expect(points.map((point) => point.actualKw)).toEqual([null, 5.9]);
  });
});
