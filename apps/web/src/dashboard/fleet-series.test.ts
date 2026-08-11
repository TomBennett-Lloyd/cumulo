import {
  canonicalFleetSeed,
  forecastSchema,
  generateFleet,
  utcIsoTimestampSchema,
  type Forecast,
  type UncertaintyBand,
  type UtcIsoTimestamp,
} from '@cumulo/shared';
import { describe, expect, it } from 'vitest';

import { fleetChartAggregate, joinFleetSeries, minimumContributingSites } from './fleet-series';

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
 * `fleetChartAggregate` is the pipeline the panel actually calls, and the only place the night flag
 * is stamped. What it owes a test is the *threading*: that the fleet reaches the classifier and the
 * classifier reaches every point. Whether a given hour is really night is `fleet-night.test.ts`'s
 * question, so the assertions below turn on a contrast the summer/winter split makes unarguable
 * rather than on any single hour's verdict.
 */
const forecastAt = (hourUtc: number, acPowerKw: number, dayIso: string): Forecast =>
  forecastSchema.parse({
    siteId: '11111111-1111-4111-8111-111111111111',
    validTime: `${dayIso}T${hourUtc.toString().padStart(2, '0')}:00:00Z`,
    issuedAt: `${dayIso}T00:00:00Z`,
    model: 'physics',
    weatherSource: 'open-meteo',
    poaIrradianceWm2: acPowerKw * 100,
    acPowerKw,
  });

describe('fleetChartAggregate', () => {
  const demoFleet = generateFleet(canonicalFleetSeed);

  it('marks the fleet’s dark hours and leaves its daylight hours unmarked', () => {
    // Midwinter, where the contrast is widest and needs no fine judgement: 02:00 UTC is the middle
    // of the night anywhere in these islands, and 12:00 UTC is the middle of the day.
    const aggregate = fleetChartAggregate(
      [forecastAt(2, 0, '2026-12-21'), forecastAt(12, 9, '2026-12-21')],
      [],
      demoFleet,
    );

    expect(aggregate.points.map((point) => point.night)).toEqual([true, false]);
  });

  it('flags every point, so an unflagged point means the flag was never threaded', () => {
    const aggregate = fleetChartAggregate(
      [forecastAt(2, 0, '2026-12-21'), forecastAt(12, 9, '2026-12-21')],
      [],
      demoFleet,
    );

    expect(aggregate.points.every((point) => point.night !== undefined)).toBe(true);
  });

  it('marks nothing at all for a fleet with no sites, whatever the hour', () => {
    // The empty-fleet arm reaching the chart: a fleet that is nowhere has no night, so the layer
    // draws nothing rather than shading hours no site was consulted about.
    const aggregate = fleetChartAggregate(
      [forecastAt(2, 0, '2026-12-21'), forecastAt(12, 9, '2026-12-21')],
      [],
      [],
    );

    expect(aggregate.points.map((point) => point.night)).toEqual([false, false]);
  });

  it('leaves the kilowatts and the completeness count untouched by the night layer', () => {
    const aggregate = fleetChartAggregate([forecastAt(12, 9, '2026-12-21')], [], demoFleet);

    expect(aggregate.points.map((point) => point.medianKw)).toEqual([9]);
    expect(aggregate.minContributingSites).toBe(1);
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
