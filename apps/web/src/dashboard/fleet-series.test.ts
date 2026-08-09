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

  it('keeps a measurement whose hour has no forecast, and orders it before the forecast hours', () => {
    const joined = joinFleetSeries(
      [{ validTime: timestamp(6), acPowerKw: 6, contributingSiteCount: 2 }],
      [
        { validTime: timestamp(6), acPowerKw: 5, contributingSiteCount: 2 },
        { validTime: timestamp(5), acPowerKw: 1, contributingSiteCount: 1 },
      ],
    );

    // 05:00 arrives second in the actuals and first in the answer: the union is sorted by instant,
    // not by the order either input happened to be in.
    expect(joined.map((point) => point.validTimeIso)).toEqual([
      '2026-07-30T05:00:00Z',
      '2026-07-30T06:00:00Z',
    ]);
    expect(joined.map((point) => point.medianKw)).toEqual([null, 6]);
  });

  /*
   * The live shape, which is the one the old forecast-only x-domain could not draw at all. The
   * deployed source reads forecasts forward from the clock and actuals back from it, so the two
   * windows share no hour — every simulated actual was dropped, and the chart rendered a legend
   * and an accessible name for a series that was never on it (#264).
   */
  it('keeps disjoint-window actuals on the chart, past hours before future ones', () => {
    const joined = joinFleetSeries(
      [
        {
          validTime: timestamp(12),
          acPowerKw: 9,
          uncertainty: band(7, 11),
          contributingSiteCount: 2,
        },
        {
          validTime: timestamp(13),
          acPowerKw: 7,
          uncertainty: band(5, 9),
          contributingSiteCount: 2,
        },
      ],
      [
        { validTime: timestamp(10), acPowerKw: 4, contributingSiteCount: 2 },
        { validTime: timestamp(11), acPowerKw: 6, contributingSiteCount: 2 },
      ],
    );

    expect(joined.map((point) => point.validTimeIso)).toEqual([
      '2026-07-30T10:00:00Z',
      '2026-07-30T11:00:00Z',
      '2026-07-30T12:00:00Z',
      '2026-07-30T13:00:00Z',
    ]);
    // Every actual survives, which is the assertion the defect fails.
    expect(joined.map((point) => point.actualKw)).toEqual([4, 6, null, null]);
    // And nothing is invented on the half of the domain the other series owns: the past hours have
    // no median and no band, the future hours have no reading.
    expect(joined.map((point) => point.medianKw)).toEqual([null, null, 9, 7]);
    expect(joined.filter((point) => 'band' in point).map((point) => point.validTimeIso)).toEqual([
      '2026-07-30T12:00:00Z',
      '2026-07-30T13:00:00Z',
    ]);
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
