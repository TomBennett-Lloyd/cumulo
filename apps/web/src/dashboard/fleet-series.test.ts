import { utcIsoTimestampSchema, type UncertaintyBand, type UtcIsoTimestamp } from '@cumulo/shared';
import { describe, expect, it } from 'vitest';

import { joinFleetSeries, minimumContributingSites } from './fleet-series';

const timestamp = (hour: number): UtcIsoTimestamp =>
  utcIsoTimestampSchema.parse(`2026-07-30T${hour.toString().padStart(2, '0')}:00:00Z`);

const band = (p10AcPowerKw: number, p90AcPowerKw: number): UncertaintyBand => ({
  p10AcPowerKw,
  p90AcPowerKw,
});

describe('joinFleetSeries', () => {
  it('carries the fleet band onto the chart point', () => {
    const joined = joinFleetSeries(
      [
        {
          validTime: timestamp(6),
          acPowerKw: 6,
          uncertainty: band(4, 9),
          contributingSiteCount: 2,
        },
      ],
      [],
    );

    expect(joined).toEqual([
      {
        validTimeIso: '2026-07-30T06:00:00Z',
        medianKw: 6,
        band: { p10Kw: 4, p90Kw: 9 },
        actualKw: null,
      },
    ]);
  });

  it('joins a measurement to its own hour and leaves an unmeasured hour null', () => {
    const joined = joinFleetSeries(
      [
        { validTime: timestamp(6), acPowerKw: 6, contributingSiteCount: 2 },
        { validTime: timestamp(7), acPowerKw: 8, contributingSiteCount: 2 },
      ],
      [{ validTime: timestamp(6), acPowerKw: 5, contributingSiteCount: 2 }],
    );

    expect(joined.map((point) => point.actualKw)).toEqual([5, null]);
  });

  it('omits the band key entirely for an hour with no uncertainty', () => {
    const joined = joinFleetSeries(
      [{ validTime: timestamp(6), acPowerKw: 6, contributingSiteCount: 2 }],
      [],
    );

    expect(joined.filter((point) => 'band' in point)).toEqual([]);
  });

  it('drops a measurement whose hour has no forecast point, keeping the forecast x-domain', () => {
    const joined = joinFleetSeries(
      [{ validTime: timestamp(6), acPowerKw: 6, contributingSiteCount: 2 }],
      [
        { validTime: timestamp(6), acPowerKw: 5, contributingSiteCount: 2 },
        { validTime: timestamp(5), acPowerKw: 1, contributingSiteCount: 1 },
      ],
    );

    expect(joined.map((point) => point.validTimeIso)).toEqual(['2026-07-30T06:00:00Z']);
  });
});

/*
 * `minimumContributingSites` was an unexported helper of the old fleet view and
 * was only ever proven through the rendered notice. It is a shared export now,
 * so its edges get named tests of their own — an empty series above all, which
 * is the one input whose answer is a decision rather than a minimum.
 */
describe('minimumContributingSites', () => {
  it('answers 0 for an empty series rather than a number no caller could render', () => {
    expect(minimumContributingSites([])).toBe(0);
  });

  it('reports the thinnest hour, not the first or the last', () => {
    expect(
      minimumContributingSites([
        { validTime: timestamp(6), acPowerKw: 6, contributingSiteCount: 3 },
        { validTime: timestamp(7), acPowerKw: 2, contributingSiteCount: 1 },
        { validTime: timestamp(8), acPowerKw: 5, contributingSiteCount: 2 },
      ]),
    ).toBe(1);
  });

  it('equals the fleet size when every hour has every site', () => {
    expect(
      minimumContributingSites([
        { validTime: timestamp(6), acPowerKw: 6, contributingSiteCount: 2 },
        { validTime: timestamp(7), acPowerKw: 8, contributingSiteCount: 2 },
      ]),
    ).toBe(2);
  });
});
